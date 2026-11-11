import { ErrorMessage } from '../Feedback/ErrorMessage';
import { useLocale, t } from "../../i18n";
import { useEffect, useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { ZoomMode } from '../../store/documentStore';
import type { AnnotationTool } from '../../annotations/types';
import type { PendingImageData } from '../Toolbar/CombinedToolbar';
import { PageCanvas } from './PageCanvas';
import { ProgressivePageLoader } from './ProgressivePageLoader';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { useTextBoxStore } from '../../store/textBoxStore';
import { useAnnotationStore } from '../../store/annotationStore';
import './PDFViewer.css';
import type { PDFLinkView } from '../../core/PDFLinkTypes';
import { PDF_LINK_SCROLL_INSET } from '../../core/PDFLinkNavigation';
import { hasOpenModal, isTextInput, isInteractiveControl } from '../../utils/keyboard';
import { MAX_ZOOM, MIN_ZOOM, wheelZoomFactor } from './zoomGesture';

export interface LinkDestination {
  pageNumber: number;
  top?: number;
  left?: number;
  view?: PDFLinkView;
  rectangle?: [number, number, number, number];
}

interface PDFViewerProps {
  document: PDFDocumentProxy;
  documentVersion: number;
  currentPage: number;
  scale: number;
  zoomMode: ZoomMode;
  rotation: number;
  viewMode: 'single' | 'continuous' | 'two-page';
  searchQuery?: string;
  activeMatchPage?: number;
  activeMatchIndex?: number;
  onPageChange?: (page: number) => void;
  onLinkClick?: (dest: unknown) => void;
  onCalculatedZoomChange?: (zoom: number) => void;
  /** Requests a manual zoom from a pointer or touch gesture over the pages. */
  onZoomChange?: (zoom: number) => void;
  highlightDestination?: LinkDestination | null;
  currentTool?: AnnotationTool;
  pendingImages?: PendingImageData[];
  onImagePlaced?: () => void;
  onTextLayout?: (blockId: string) => void;
}

const EMPTY_PAGES = new Map<number, PDFPageProxy>();
const FIT_PADDING = 40;

export function PDFViewer({
  document,
  documentVersion,
  currentPage,
  scale,
  zoomMode,
  rotation,
  viewMode,
  searchQuery,
  activeMatchPage,
  activeMatchIndex,
  onPageChange,
  onLinkClick,
  onCalculatedZoomChange,
  onZoomChange,
  highlightDestination,
  currentTool = 'select',
  pendingImages,
  onImagePlaced,
  onTextLayout,
}: PDFViewerProps) {
  useLocale();
  const firstPage = viewMode === 'continuous'
    ? 1
    : viewMode === 'two-page' ? currentPage - ((currentPage + 1) % 2) : currentPage;
  const lastPage = viewMode === 'continuous'
    ? document.numPages
    : Math.min(firstPage + (viewMode === 'two-page' ? 1 : 0), document.numPages);
  const continuous = viewMode === 'continuous';
  const request = useMemo(() => ({ document, documentVersion, firstPage, lastPage, continuous }), [document, documentVersion, firstPage, lastPage, continuous]);
  const pageNumbers = useMemo(() => Array.from({ length: lastPage - firstPage + 1 }, (_, index) => firstPage + index), [firstPage, lastPage]);
  const [result, setResult] = useState<{ request: typeof request; pages: Map<number, PDFPageProxy>; reference: PDFPageProxy | undefined; errors: Map<number, string> } | null>(null);
  const pages = result?.request === request ? result.pages : EMPTY_PAGES;
  const referencePage = result?.request === request ? result.reference : undefined;
  const hasPages = pages.size > 0;
  const loadErrors = result?.request === request ? result.errors : undefined;
  const initialPage = useRef(currentPage);
  useEffect(() => { initialPage.current = currentPage; }, [currentPage]);
  const loaderRef = useRef<{ request: typeof request; loader: ProgressivePageLoader } | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number; gap: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollReportedPage = useRef<number | null>(null);
  const [visibility, setVisibility] = useState<{ request: typeof request; numbers: number[] } | null>(null);
  const visiblePagesRef = useRef<Set<number>>(new Set());
  const scrollHandlerRef = useRef<() => void>(() => {});
  const scrollAnchorRef = useRef<{
    request: typeof request;
    layout: Map<number, { width: number; height: number }>;
    pageNumber: number;
    fraction: number;
  } | null>(null);
  const zoomAnchor = useRef<{ scale: number; pageNumber: number; fx: number; fy: number; clientX: number; clientY: number } | null>(null);
  const handledDestination = useRef<{ destination: LinkDestination; request: typeof request } | null>(null);
  const editingTextBoxId = useTextBoxStore((state) => state.editingTextBoxId);
  const editingPageNumber = useAnnotationStore((state) => {
    if (!editingTextBoxId) return undefined;
    for (const [pageNumber, annotations] of state.annotations) {
      if (annotations.some((annotation) => annotation.id === editingTextBoxId)) return pageNumber;
    }
    return undefined;
  });

  const calculatedScale = useMemo(() => {
    if (zoomMode === 'manual' || !referencePage || !containerSize) return scale;
    const visiblePages = viewMode === 'two-page' ? [...pages.values()] : [referencePage];
    const viewports = visiblePages.map(page => page.getViewport({ scale: 1, rotation: getEffectiveRotation(page, rotation) }));
    const availableWidth = containerSize.width - FIT_PADDING * 2 - containerSize.gap * (visiblePages.length - 1);
    const availableHeight = containerSize.height - FIT_PADDING * 2;
    if (availableWidth <= 0 || availableHeight <= 0) return scale;
    const width = viewports.reduce((sum, viewport) => sum + viewport.width, 0);
    const height = Math.max(...viewports.map(viewport => viewport.height));
    return Math.min(availableWidth / width, zoomMode === 'fit-page' ? availableHeight / height : Infinity, 4);
  }, [zoomMode, pages, referencePage, containerSize, scale, rotation, viewMode]);

  // Keep lightweight slots for every page; only nearby pages own canvases/editors.
  const pageLayouts = useMemo(() => new Map(pageNumbers.map(pageNumber => {
    const page = pages.get(pageNumber) ?? referencePage;
    const viewport = page?.getViewport({ scale: calculatedScale, rotation: getEffectiveRotation(page, rotation) });
    return [pageNumber, { width: viewport?.width ?? 612 * calculatedScale, height: viewport?.height ?? 792 * calculatedScale }];
  })), [pages, pageNumbers, referencePage, calculatedScale, rotation]);
  const renderedPages = useMemo(() => {
    const result = new Set<number>();
    const visible = visibility?.request === request ? visibility.numbers : [];
    for (const pageNumber of [...visible, currentPage]) {
      for (let offset = -1; offset <= 1; offset++) result.add(pageNumber + offset);
    }
    // An active TipTap editor must survive scrolling until it commits its edit.
    if (editingPageNumber !== undefined) result.add(editingPageNumber);
    return result;
  }, [visibility, request, currentPage, editingPageNumber]);

  // Pan state
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const [isSpacePanning, setIsSpacePanning] = useState(false);

  // A new request hides the previous result immediately, without clearing state
  // in the effect. Late results can never become the visible pages of a new PDF.
  useEffect(() => {
    let cancelled = false;
    const publish = (loaded: PDFPageProxy[]) => {
      if (cancelled) return;
      setResult(previous => {
        const current = previous?.request === request ? previous : undefined;
        const pages = new Map(current?.pages);
        for (const page of loaded) pages.set(page.pageNumber, page);
        return { request, pages, reference: current?.reference ?? loaded[0], errors: current?.errors ?? new Map() };
      });
    };
    const fail = (pageNumber: number, error: unknown) => {
      if (cancelled) return;
      setResult(previous => {
        const current = previous?.request === request ? previous : undefined;
        const errors = new Map(current?.errors);
        errors.set(pageNumber, error instanceof Error ? error.message : 'Could not load PDF pages');
        return { request, pages: current?.pages ?? EMPTY_PAGES, reference: current?.reference, errors };
      });
    };
    const loader = new ProgressivePageLoader(request.document, request.firstPage, request.lastPage, publish, fail);
    if (request.continuous) {
      loaderRef.current = { request, loader };
      void loader.start(initialPage.current);
    } else {
      // A spread is fitted from both real page dimensions, never from a partly
      // loaded pair that would change its zoom when the second page arrives.
      void (async () => {
        try {
          const loaded: PDFPageProxy[] = [];
          for (let pageNumber = request.firstPage; pageNumber <= request.lastPage; pageNumber++) {
            if (cancelled) return;
            loaded.push(await request.document.getPage(pageNumber));
          }
          publish(loaded);
        } catch (error) { fail(request.firstPage, error); }
      })();
    }
    return () => { cancelled = true; loader.stop(); if (loaderRef.current?.loader === loader) loaderRef.current = null; };
  }, [request]);

  useEffect(() => {
    if (loaderRef.current?.request !== request) return;
    loaderRef.current.loader.prioritize(hasPages ? renderedPages : [currentPage]);
    if (highlightDestination) loaderRef.current.loader.prioritize([highlightDestination.pageNumber]);
  }, [request, renderedPages, currentPage, hasPages, highlightDestination]);

  // Fit reacts to the viewer's actual size, including sidebar and panel changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const wrapper = container.querySelector('.pdf-pages-wrapper');
      const next = { width: container.clientWidth, height: container.clientHeight,
        gap: wrapper ? parseFloat(window.getComputedStyle(wrapper).columnGap) || 0 : 0 };
      setContainerSize(previous => previous?.width === next.width && previous.height === next.height && previous.gap === next.gap ? previous : next);
    };
    // The initial DOM measurement must precede paint to avoid flashing a page at
    // the wrong fit size. All subsequent updates originate from ResizeObserver.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => { cancelled = true; observer.disconnect(); };
  }, [viewMode]);

  useEffect(() => {
    if (zoomMode !== 'manual' && hasPages && containerSize && calculatedScale !== scale) onCalculatedZoomChange?.(calculatedScale);
  }, [calculatedScale, scale, zoomMode, hasPages, containerSize, onCalculatedZoomChange]);

  // Scroll to current page in continuous mode
  useEffect(() => {
    if (viewMode !== 'continuous' || !containerRef.current) return;

    // Scrolling updates the page indicator without snapping back to the page top.
    const reportedPage = scrollReportedPage.current;
    scrollReportedPage.current = null;
    if (reportedPage === currentPage) return;

    const pageElement = pageRefs.current.get(currentPage);
    if (pageElement) {
      // Jump directly so intermediate pages cannot overwrite the requested page
      // while fit layout and IntersectionObserver are catching up.
      pageElement.scrollIntoView({ behavior: 'instant', block: 'start' });
      scrollHandlerRef.current();
    }
  }, [currentPage, viewMode, request, hasPages]);

  // Scroll to highlight destination (for citation links in continuous mode)
  useEffect(() => {
    if (!highlightDestination || !containerRef.current) return;
    if (handledDestination.current?.destination === highlightDestination && handledDestination.current.request === request) return;

    const pageElement = pageRefs.current.get(highlightDestination.pageNumber);
    if (!pageElement) return;

    const container = containerRef.current;
    const page = pages.get(highlightDestination.pageNumber);
    // The destination is requested with foreground priority. Wait for its real
    // dimensions instead of repeating a provisional scroll on every page batch.
    if (!page) return;

    handledDestination.current = { destination: highlightDestination, request };
    const viewport = page.getViewport({ scale: calculatedScale, rotation: getEffectiveRotation(page, rotation) });
    let [offsetX, offsetY] = viewport.convertToViewportPoint(
      highlightDestination.left ?? page.view[0],
      highlightDestination.top ?? page.view[3]
    );
    if (highlightDestination.view === 'Fit' || highlightDestination.view === 'FitB') { offsetX = 0; offsetY = 0; }
    if (highlightDestination.rectangle) {
      const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(highlightDestination.rectangle);
      offsetX = Math.min(x0, x1); offsetY = Math.min(y0, y1);
    }
    const pageTop = pageElement.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const pageLeft = pageElement.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
    container.scrollTo({ top: Math.max(0, pageTop + offsetY - PDF_LINK_SCROLL_INSET.top),
      ...(highlightDestination.view ? { left: Math.max(0, pageLeft + offsetX - PDF_LINK_SCROLL_INSET.left) } : {}), behavior: 'smooth' });
  }, [highlightDestination, pages, request, calculatedScale, rotation, viewMode]);

  // Inspect only pages reported by the browser, rather than measuring the whole PDF on every scroll.
  const handleScroll = useCallback((reportPage = true) => {
    if (viewMode !== 'continuous' || !containerRef.current || !hasPages) return;
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + container.clientHeight / 2;
    const candidates = new Set([currentPage, ...visiblePagesRef.current]);
    let closestPage = currentPage;
    let closestDistance = Infinity;

    for (const pageNumber of candidates) {
      const element = pageRefs.current.get(pageNumber);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - containerCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = pageNumber;
      }
    }

    const element = pageRefs.current.get(closestPage);
    const layout = pageLayouts.get(closestPage);
    if (element && layout && layout.height > 0) {
      scrollAnchorRef.current = {
        request, layout: pageLayouts, pageNumber: closestPage,
        fraction: (containerCenter - element.getBoundingClientRect().top) / layout.height,
      };
    }
    if (reportPage && closestPage !== currentPage && onPageChange) {
      scrollReportedPage.current = closestPage;
      onPageChange(closestPage);
    }
  }, [viewMode, currentPage, onPageChange, pageLayouts, request, hasPages]);

  // Preserve the page and relative position at the viewport center across geometry changes.
  // Slots retain their sizes when canvases are unmounted, so virtualization itself never moves content.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = scrollAnchorRef.current;
    // A pointer zoom keeps the point under the cursor instead of the viewport center.
    if (container && !zoomAnchor.current && viewMode === 'continuous' && anchor?.request === request && anchor.layout !== pageLayouts) {
      const element = pageRefs.current.get(anchor.pageNumber);
      const layout = pageLayouts.get(anchor.pageNumber);
      if (element && layout) {
        const center = container.getBoundingClientRect().top + container.clientHeight / 2;
        container.scrollTop += element.getBoundingClientRect().top + layout.height * anchor.fraction - center;
      }
    }
    scrollHandlerRef.current = handleScroll;
    handleScroll(false);
  }, [handleScroll, pageLayouts, request, hasPages, viewMode]);

  // Pointer and touch zoom: Ctrl+wheel (including trackpad pinches) and two-finger
  // pinches scale continuously and keep the page point under the pointer in place.
  const scaleRef = useRef(calculatedScale);
  const onZoomChangeRef = useRef(onZoomChange);
  useLayoutEffect(() => { scaleRef.current = calculatedScale; onZoomChangeRef.current = onZoomChange; });
  const zoomFrame = useRef<{ factor: number; clientX: number; clientY: number; id: number } | null>(null);
  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const current = scaleRef.current, next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * factor));
    if (!onZoomChangeRef.current || !Number.isFinite(next) || Math.abs(next - current) < 1e-4) return;
    let best: { pageNumber: number; rect: DOMRect; distance: number } | null = null;
    for (const [pageNumber, wrapper] of pageRefs.current) {
      if (viewMode === 'continuous' && pageNumber !== currentPage && !visiblePagesRef.current.has(pageNumber)) continue;
      const rect = wrapper.querySelector('.page-viewport')?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right), dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { pageNumber, rect, distance };
    }
    zoomAnchor.current = best ? {
      scale: next, pageNumber: best.pageNumber, clientX, clientY,
      fx: (clientX - best.rect.left) / best.rect.width, fy: (clientY - best.rect.top) / best.rect.height,
    } : null;
    // Later frames of the same gesture build on this request before React re-renders.
    scaleRef.current = next;
    onZoomChangeRef.current(next);
  }, [viewMode, currentPage]);
  const queueZoom = useCallback((factor: number, clientX: number, clientY: number) => {
    const pending = zoomFrame.current;
    if (pending) { pending.factor *= factor; pending.clientX = clientX; pending.clientY = clientY; return; }
    const frame = { factor, clientX, clientY, id: 0 };
    zoomFrame.current = frame;
    // Coalesce the many events of one gesture frame into a single re-render.
    frame.id = window.requestAnimationFrame(() => {
      zoomFrame.current = null;
      zoomAt(frame.factor, frame.clientX, frame.clientY);
    });
  }, [zoomAt]);
  useEffect(() => () => { if (zoomFrame.current) window.cancelAnimationFrame(zoomFrame.current.id); zoomFrame.current = null; }, []);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current, container = containerRef.current;
    if (!anchor || !container || Math.abs(anchor.scale - calculatedScale) > 1e-6) return;
    zoomAnchor.current = null;
    const rect = pageRefs.current.get(anchor.pageNumber)?.querySelector('.page-viewport')?.getBoundingClientRect();
    if (!rect) return;
    container.scrollLeft += rect.left + anchor.fx * rect.width - anchor.clientX;
    container.scrollTop += rect.top + anchor.fy * rect.height - anchor.clientY;
  }, [calculatedScale, pageLayouts]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A trackpad pinch reports ctrlKey without a pressed Control key. Track the
    // physical key in the capture phase, before editors stop key propagation.
    let ctrlKeyHeld = false;
    const key = (event: KeyboardEvent) => { if (event.key === 'Control') ctrlKeyHeld = event.type === 'keydown'; };
    const release = () => { ctrlKeyHeld = false; };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.defaultPrevented || hasOpenModal() || isTextInput(event.target) || event.deltaY === 0) return;
      event.preventDefault();
      queueZoom(wheelZoomFactor(event, ctrlKeyHeld, container.clientHeight), event.clientX, event.clientY);
    };
    // Touch events stay targeted at the element under the first finger. Re-rendering
    // pages mid-gesture would detach that element and stop later touchmove events,
    // so a pinch previews with a CSS transform and commits one zoom when it ends.
    let pinch: { start: number; factor: number; clientX: number; clientY: number; wrapper: HTMLElement } | null = null;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const finishPinch = (commit: boolean) => {
      const gesture = pinch; pinch = null;
      if (!gesture) return;
      gesture.wrapper.style.transform = ''; gesture.wrapper.style.transformOrigin = '';
      if (commit && Math.abs(gesture.factor - 1) > 1e-3) zoomAt(gesture.factor, gesture.clientX, gesture.clientY);
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) { finishPinch(true); return; }
      const wrapper = container.querySelector<HTMLElement>('.pdf-pages-wrapper'), start = spread(event.touches);
      if (!wrapper || start <= 0) return;
      const clientX = (event.touches[0].clientX + event.touches[1].clientX) / 2, clientY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      const rect = wrapper.getBoundingClientRect();
      wrapper.style.transformOrigin = `${clientX - rect.left}px ${clientY - rect.top}px`;
      pinch = { start, factor: 1, clientX, clientY, wrapper };
    };
    const touchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const current = scaleRef.current;
      pinch.factor = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * spread(event.touches) / pinch.start)) / current;
      pinch.wrapper.style.transform = `scale(${pinch.factor})`;
    };
    const touchEnd = (event: TouchEvent) => { if (event.touches.length !== 2) finishPinch(event.type === 'touchend'); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    window.addEventListener('blur', release);
    container.addEventListener('wheel', wheel, { passive: false });
    container.addEventListener('touchstart', touchStart, { passive: true });
    container.addEventListener('touchmove', touchMove, { passive: false });
    container.addEventListener('touchend', touchEnd);
    container.addEventListener('touchcancel', touchEnd);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      window.removeEventListener('blur', release);
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('touchstart', touchStart);
      container.removeEventListener('touchmove', touchMove);
      container.removeEventListener('touchend', touchEnd);
      container.removeEventListener('touchcancel', touchEnd);
      finishPinch(false);
    };
  }, [queueZoom, zoomAt]);

  useEffect(() => {
    visiblePagesRef.current = new Set();
    if (viewMode !== 'continuous' || !containerRef.current || !hasPages) return;
    let cancelled = false;
    const visible = new Set<number>();
    const observer = new IntersectionObserver((entries) => {
      if (cancelled) return;
      for (const entry of entries) {
        const pageNumber = Number(entry.target.getAttribute('data-page'));
        if (entry.isIntersecting) visible.add(pageNumber);
        else visible.delete(pageNumber);
      }
      visiblePagesRef.current = new Set(visible);
      const next = [...visible].sort((a, b) => a - b);
      setVisibility((previous) => previous?.request === request && previous.numbers.length === next.length &&
        previous.numbers.every((page, index) => page === next[index]) ? previous : { request, numbers: next });
      scrollHandlerRef.current();
    }, { root: containerRef.current, threshold: 0 });
    pageRefs.current.forEach((element) => observer.observe(element));
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [request, hasPages, viewMode]);

  // Throttled scroll handler
  useEffect(() => {
    if (viewMode !== 'continuous') return;

    const container = containerRef.current;
    if (!container) return;

    let frame: number | null = null;
    const onScroll = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          handleScroll();
        });
      }
    };

    container.addEventListener('scroll', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [viewMode, handleScroll]);

  // Pan handlers. Mouse and pen drag the view with pointer capture, so the
  // drag continues outside the viewer; touch keeps native scrolling and inertia.
  const panPointer = useRef<number | null>(null);
  const handlePanStart = useCallback((e: React.PointerEvent) => {
    if (currentTool !== 'pan' && !isSpacePanning) return;
    if (e.pointerType === 'touch' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    panPointer.current = e.pointerId;
    container.setPointerCapture?.(e.pointerId);

    setIsPanning(true);
    setPanStart({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
  }, [currentTool, isSpacePanning]);

  const handlePanMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning || !panStart || e.pointerId !== panPointer.current) return;
    const container = containerRef.current;
    if (!container) return;

    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    container.scrollLeft = panStart.scrollLeft - dx;
    container.scrollTop = panStart.scrollTop - dy;
  }, [isPanning, panStart]);

  const handlePanEnd = useCallback((e?: React.PointerEvent) => {
    if (e && panPointer.current !== null && e.pointerId !== panPointer.current) return;
    panPointer.current = null;
    setIsPanning(false);
    setPanStart(null);
  }, []);

  // Space key for temporary pan mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Space still activates focused buttons/links and belongs to modal dialogs.
      if (e.defaultPrevented || hasOpenModal() || isTextInput(e.target) || isInteractiveControl(e.target)) return;

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setIsSpacePanning(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePanning(false);
        setIsPanning(false);
        setPanStart(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Determine cursor style for panning
  const getPanCursor = () => {
    if (isPanning) return 'grabbing';
    if (currentTool === 'pan' || isSpacePanning) return 'grab';
    return undefined;
  };

  return (
    <div
      ref={containerRef}
      className={`pdf-viewer-container view-mode-${viewMode}${currentTool === 'pan' || isSpacePanning ? ' pan-mode' : ''}`}
      style={{ cursor: getPanCursor() }}
      onPointerDown={handlePanStart}
      onPointerMove={handlePanMove}
      onPointerUp={handlePanEnd}
      onPointerCancel={handlePanEnd}
      onLostPointerCapture={handlePanEnd}
    >
      {!hasPages && !loadErrors?.size && (
        <div className="pdf-viewer-loading">
          <div className="loading-spinner" />
          <span>{t("m.loading.document.951b0d")}</span>
        </div>
      )}
      {!hasPages && loadErrors?.size ? <div className="pdf-viewer-loading" role="alert"><ErrorMessage error={loadErrors.values().next().value} /></div> : null}
      <div className="pdf-pages-wrapper">
        {hasPages && pageNumbers.map(pageNumber => {
          const page = pages.get(pageNumber);
          return (
          <div
            key={`v${documentVersion}-page-${pageNumber}`}
            ref={(el) => {
              if (el) pageRefs.current.set(pageNumber, el);
              else pageRefs.current.delete(pageNumber);
            }}
            className="page-wrapper"
            data-page={pageNumber}
          >
            <div className="page-viewport" style={pageLayouts.get(pageNumber)}>
              {page && (viewMode !== 'continuous' || renderedPages.has(pageNumber)) && <PageCanvas
                page={page}
                pageNumber={pageNumber}
                scale={calculatedScale}
                rotation={rotation}
                searchQuery={searchQuery}
                activeMatchPage={activeMatchPage}
                activeMatchIndex={activeMatchIndex}
                onLinkClick={onLinkClick}
                highlightDestination={
                  highlightDestination?.pageNumber === pageNumber
                    ? highlightDestination
                    : undefined
                }
                pendingImages={pendingImages}
                onImagePlaced={onImagePlaced}
                onTextLayout={onTextLayout}
              />}
              {!page && renderedPages.has(pageNumber) && <div className="pdf-viewer-loading" role={loadErrors?.has(pageNumber) ? 'alert' : 'status'}>
                {loadErrors?.has(pageNumber) ? <ErrorMessage error={loadErrors.get(pageNumber)} /> : t("m.loading.document.951b0d")}
              </div>}
            </div>
            {viewMode === 'continuous' && (
              <div className="page-number-label">{t("m.page.fb0627")}{' '}{pageNumber}</div>
            )}
          </div>
        ); })}
      </div>
    </div>
  );
}
