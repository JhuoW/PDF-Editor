import { useEffect, useState, useRef, useCallback, useLayoutEffect } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { ZoomMode } from '../../store/documentStore';
import type { AnnotationTool } from '../../annotations/types';
import type { PendingImageData } from '../Toolbar/CombinedToolbar';
import { PageCanvas } from './PageCanvas';
import './PDFViewer.css';

export interface LinkDestination {
  pageNumber: number;
  top?: number;
  left?: number;
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
  highlightDestination?: LinkDestination | null;
  currentTool?: AnnotationTool;
  pendingImages?: PendingImageData[];
  onImagePlaced?: () => void;
}

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
  highlightDestination,
  currentTool = 'select',
  pendingImages,
  onImagePlaced,
}: PDFViewerProps) {
  const [pages, setPages] = useState<PDFPageProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculatedScale, setCalculatedScale] = useState(scale);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Pan state
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const [isSpacePanning, setIsSpacePanning] = useState(false);

  // Padding around the page in fit modes
  const FIT_PADDING = 40;

  // Load pages based on view mode
  // Include documentVersion in dependencies to force reload when PDF is modified
  useEffect(() => {
    if (!document) return;

    let cancelled = false;
    setLoading(true);
    // Clear pages immediately to force re-render with fresh data
    setPages([]);

    const loadPages = async () => {
      try {
        let loadedPages: PDFPageProxy[] = [];

        if (viewMode === 'single') {
          const page = await document.getPage(currentPage);
          loadedPages = [page];
        } else if (viewMode === 'continuous') {
          for (let i = 1; i <= document.numPages; i++) {
            if (cancelled) return;
            const page = await document.getPage(i);
            loadedPages.push(page);
          }
        } else if (viewMode === 'two-page') {
          const startPage = currentPage % 2 === 0 ? currentPage - 1 : currentPage;
          for (let i = Math.max(1, startPage); i <= Math.min(startPage + 1, document.numPages); i++) {
            if (cancelled) return;
            const page = await document.getPage(i);
            loadedPages.push(page);
          }
        }

        if (!cancelled) {
          setPages(loadedPages);
          setLoading(false);
        }
      } catch (error) {
        console.error('Error loading pages:', error);
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadPages();

    return () => {
      cancelled = true;
    };
  }, [document, documentVersion, currentPage, viewMode]);

  // Calculate zoom for fit-page and fit-width modes
  const calculateFitZoom = useCallback(() => {
    if (!containerRef.current || pages.length === 0) return null;

    const container = containerRef.current;
    const containerWidth = container.clientWidth - FIT_PADDING * 2;
    const containerHeight = container.clientHeight - FIT_PADDING * 2;

    // Get the current page dimensions
    const page = pages[0]; // Use first loaded page for dimensions
    const viewport = page.getViewport({ scale: 1, rotation });

    // Account for rotation - swap width/height if rotated 90 or 270 degrees
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // For two-page mode, account for both pages side by side
    const effectivePageWidth = viewMode === 'two-page' ? pageWidth * 2 + 20 : pageWidth;

    if (zoomMode === 'fit-page') {
      // Fit both width and height
      const scaleX = containerWidth / effectivePageWidth;
      const scaleY = containerHeight / pageHeight;
      return Math.min(scaleX, scaleY, 4); // Cap at 400%
    } else if (zoomMode === 'fit-width') {
      // Fit width only
      return Math.min(containerWidth / effectivePageWidth, 4);
    }

    return null;
  }, [pages, rotation, viewMode, zoomMode, FIT_PADDING]);

  // Apply calculated zoom when in fit mode
  useLayoutEffect(() => {
    if (zoomMode === 'manual') {
      setCalculatedScale(scale);
      return;
    }

    const newScale = calculateFitZoom();
    if (newScale !== null && newScale !== calculatedScale) {
      setCalculatedScale(newScale);
      onCalculatedZoomChange?.(newScale);
    }
  }, [zoomMode, scale, calculateFitZoom, calculatedScale, onCalculatedZoomChange]);

  // Recalculate on window resize
  useEffect(() => {
    if (zoomMode === 'manual') return;

    const handleResize = () => {
      const newScale = calculateFitZoom();
      if (newScale !== null) {
        setCalculatedScale(newScale);
        onCalculatedZoomChange?.(newScale);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [zoomMode, calculateFitZoom, onCalculatedZoomChange]);

  // Track if we should skip the next page scroll (when navigating via link)
  const skipNextPageScroll = useRef(false);

  // Scroll to current page in continuous mode
  useEffect(() => {
    if (viewMode !== 'continuous' || !containerRef.current) return;

    // Skip if this scroll was triggered by a link navigation
    if (skipNextPageScroll.current) {
      skipNextPageScroll.current = false;
      return;
    }

    const pageElement = pageRefs.current.get(currentPage);
    if (pageElement) {
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [currentPage, viewMode]);

  // Scroll to highlight destination (for citation links in continuous mode)
  useEffect(() => {
    if (!highlightDestination || !containerRef.current) return;

    // Skip the normal page scroll since we're doing a precise destination scroll
    if (viewMode === 'continuous') {
      skipNextPageScroll.current = true;
    }

    const pageElement = pageRefs.current.get(highlightDestination.pageNumber);
    if (!pageElement) return;

    const container = containerRef.current;
    const page = pages.find(p => p.pageNumber === highlightDestination.pageNumber);

    if (!page) {
      // Fallback: just scroll to the page
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // Calculate the scroll position based on destination coordinates
    const pageHeight = page.view[3] - page.view[1]; // PDF page height in PDF units

    // Convert PDF top coordinate to pixel offset from top of page element
    let offsetY = 0;
    if (highlightDestination.top !== undefined) {
      // PDF coordinates have origin at bottom-left
      offsetY = (pageHeight - highlightDestination.top) * calculatedScale;
    }

    // Calculate the target scroll position
    const pageTop = pageElement.offsetTop;
    const targetScrollTop = pageTop + offsetY - 100; // 100px padding from top

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth'
    });
  }, [highlightDestination, pages, calculatedScale, viewMode]);

  // Detect visible page in continuous mode
  const handleScroll = useCallback(() => {
    if (viewMode !== 'continuous' || !onPageChange || !containerRef.current) return;

    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    let closestPage = currentPage;
    let closestDistance = Infinity;

    pageRefs.current.forEach((element, pageNum) => {
      const rect = element.getBoundingClientRect();
      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(pageCenter - containerCenter);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = pageNum;
      }
    });

    if (closestPage !== currentPage) {
      onPageChange(closestPage);
    }
  }, [viewMode, currentPage, onPageChange]);

  // Throttled scroll handler
  useEffect(() => {
    if (viewMode !== 'continuous') return;

    const container = containerRef.current;
    if (!container) return;

    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [viewMode, handleScroll]);

  // Pan handlers
  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (currentTool !== 'pan' && !isSpacePanning) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    setIsPanning(true);
    setPanStart({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    });
  }, [currentTool, isSpacePanning]);

  const handlePanMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !panStart) return;
    const container = containerRef.current;
    if (!container) return;

    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    container.scrollLeft = panStart.scrollLeft - dx;
    container.scrollTop = panStart.scrollTop - dy;
  }, [isPanning, panStart]);

  const handlePanEnd = useCallback(() => {
    setIsPanning(false);
    setPanStart(null);
  }, []);

  // Space key for temporary pan mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

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

  if (loading && pages.length === 0) {
    return (
      <div className="pdf-viewer-container">
        <div className="pdf-viewer-loading">
          <div className="loading-spinner" />
          <span>Loading document...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pdf-viewer-container view-mode-${viewMode}${currentTool === 'pan' || isSpacePanning ? ' pan-mode' : ''}`}
      style={{ cursor: getPanCursor() }}
      onMouseDown={handlePanStart}
      onMouseMove={handlePanMove}
      onMouseUp={handlePanEnd}
      onMouseLeave={handlePanEnd}
    >
      <div className="pdf-pages-wrapper">
        {pages.map((page) => (
          <div
            key={`v${documentVersion}-page-${page.pageNumber}`}
            ref={(el) => {
              if (el) pageRefs.current.set(page.pageNumber, el);
            }}
            className="page-wrapper"
            data-page={page.pageNumber}
          >
            <PageCanvas
              page={page}
              pageNumber={page.pageNumber}
              scale={calculatedScale}
              rotation={rotation}
              searchQuery={searchQuery}
              activeMatchPage={activeMatchPage}
              activeMatchIndex={activeMatchIndex}
              onLinkClick={onLinkClick}
              highlightDestination={
                highlightDestination?.pageNumber === page.pageNumber
                  ? highlightDestination
                  : undefined
              }
              pendingImages={pendingImages}
              onImagePlaced={onImagePlaced}
            />
            {viewMode === 'continuous' && (
              <div className="page-number-label">Page {page.pageNumber}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
