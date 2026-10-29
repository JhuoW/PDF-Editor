// @vitest-environment jsdom
import { act, useState } from 'react';
import type { ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFViewer } from '../../src/components/PDFViewer/PDFViewer';
import { useTextBoxStore } from '../../src/store/textBoxStore';
import { useAnnotationStore, createFreeTextAnnotation } from '../../src/store/annotationStore';

vi.mock('../../src/components/PDFViewer/PageCanvas', () => ({
  PageCanvas: ({ pageNumber, scale }: { pageNumber: number; scale: number }) => (
    <canvas data-page-canvas={pageNumber} data-scale={scale} />
  ),
}));

type ViewerProps = ComponentProps<typeof PDFViewer>;

function makePage(pageNumber: number, width = 600, height = 800, rotate = 0) {
  return {
    pageNumber,
    rotate,
    view: [0, 0, width, height],
    getViewport: vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({
      width: (rotation % 180 === 0 ? width : height) * scale,
      height: (rotation % 180 === 0 ? height : width) * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (height - y) * scale],
    })),
  } as unknown as PDFPageProxy;
}

function makeDocument(pages: PDFPageProxy[]) {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
  } as unknown as PDFDocumentProxy;
}

function rect(top: number, height = 800) {
  return { top, height, bottom: top + height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} };
}

describe('PDFViewer navigation and fit zoom', () => {
  let host: HTMLDivElement;
  let root: Root;
  let props: ViewerProps;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let observers: { callback: IntersectionObserverCallback; elements: Set<Element> }[];
  let resizeObservers: { callback: ResizeObserverCallback; elements: Set<Element> }[];

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useTextBoxStore.setState(useTextBoxStore.getInitialState());
    useAnnotationStore.setState(useAnnotationStore.getInitialState());
    observers = [];
    resizeObservers = [];
    vi.stubGlobal('ResizeObserver', class {
      elements = new Set<Element>();
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; resizeObservers.push(this); }
      observe(element: Element) { this.elements.add(element); }
      disconnect() { this.elements.clear(); }
    });
    vi.stubGlobal('IntersectionObserver', class {
      elements = new Set<Element>();
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; observers.push(this); }
      observe(element: Element) { this.elements.add(element); }
      unobserve(element: Element) { this.elements.delete(element); }
      disconnect() { this.elements.clear(); }
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    frames = new Map();
    nextFrame = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    scrollIntoView = vi.fn();
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ columnGap: '16px' })));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    props = {
      document: makeDocument([makePage(1), makePage(2), makePage(3)]),
      documentVersion: 1,
      currentPage: 1,
      scale: 1,
      zoomMode: 'manual',
      rotation: 0,
      viewMode: 'continuous',
      onPageChange: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(changes: Partial<ViewerProps> = {}) {
    props = { ...props, ...changes };
    await act(async () => { root.render(<PDFViewer {...props} />); });
  }

  async function scrollToSecondPage() {
    const container = host.querySelector('.pdf-viewer-container') as HTMLElement;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0));
    host.querySelectorAll<HTMLElement>('.page-wrapper').forEach((element, index) => {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect((index - 1) * 900));
    });
    await observeVisiblePages([2]);
    await act(async () => {
      container.dispatchEvent(new Event('scroll'));
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  }


  async function observeVisiblePages(pageNumbers: number[]) {
    const observer = observers.at(-1)!;
    const entries = [...observer.elements].map(target => ({
      target, isIntersecting: pageNumbers.includes(Number(target.getAttribute('data-page'))),
    } as IntersectionObserverEntry));
    await act(async () => { observer.callback(entries, {} as IntersectionObserver); });
  }

  function useMeasuredPageLayout() {
    const container = host.querySelector('.pdf-viewer-container') as HTMLElement;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0));
    const wrappers = [...host.querySelectorAll<HTMLElement>('.page-wrapper')];
    wrappers.forEach((element, index) => {
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
        const height = (node: HTMLElement) => parseFloat((node.querySelector('.page-viewport') as HTMLElement).style.height);
        const top = 16 + wrappers.slice(0, index).reduce((sum, node) => sum + height(node) + 40, 0);
        return rect(top - container.scrollTop, height(element) + 24);
      });
    });
    return { container, wrappers };
  }

  it('mounts a bounded set of canvases for 500 pages and can navigate to the final page', async () => {
    await render({ document: makeDocument(Array.from({ length: 500 }, (_, index) => makePage(index + 1))) });
    expect(host.querySelectorAll('.page-wrapper')).toHaveLength(500);
    expect(host.querySelectorAll('canvas').length).toBeLessThanOrEqual(3);
    const firstSlot = host.querySelector('[data-page="1"] .page-viewport') as HTMLElement;
    const firstSize = firstSlot.getAttribute('style');
    await render({ currentPage: 500 });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(host.querySelector('[data-page="500"]'));
    await observeVisiblePages([500]);
    expect(host.querySelector('[data-page-canvas="500"]')).not.toBeNull();
    expect(host.querySelector('[data-page-canvas="499"]')).not.toBeNull();
    expect(host.querySelector('[data-page-canvas="1"]')).toBeNull();
    expect(host.querySelectorAll('canvas').length).toBeLessThanOrEqual(3);
    expect(firstSlot.getAttribute('style')).toBe(firstSize);
    expect(props.document.getPage).toHaveBeenCalledTimes(500);
  });

  it('preloads one page on each side and keeps the active text editor mounted until editing ends', async () => {
    await render({ document: makeDocument(Array.from({ length: 20 }, (_, index) => makePage(index + 1))) });
    const annotation = createFreeTextAnnotation(1, [0, 0, 100, 50], 'Draft');
    await act(async () => {
      useAnnotationStore.getState().addAnnotation(annotation);
      useTextBoxStore.getState().startEditing(annotation.id);
    });
    const firstCanvas = host.querySelector('[data-page-canvas="1"]');
    await render({ currentPage: 10 });
    await observeVisiblePages([10]);
    for (const pageNumber of [9, 10, 11]) expect(host.querySelector(`[data-page-canvas="${pageNumber}"]`)).not.toBeNull();
    expect(host.querySelector('[data-page-canvas="1"]')).toBe(firstCanvas);
    expect(host.querySelectorAll('canvas')).toHaveLength(4);
    await act(async () => { useTextBoxStore.getState().stopEditing(); });
    expect(host.querySelector('[data-page-canvas="1"]')).toBeNull();
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
  });

  it('preserves the page and position within it when zooming and rotating mixed-size pages', async () => {
    await render({ document: makeDocument([makePage(1, 300, 500), makePage(2, 600, 1000), makePage(3, 400, 700)]) });
    const { container, wrappers } = useMeasuredPageLayout();
    container.scrollTop = 16 + 500 + 40 + 400 - 400;
    await observeVisiblePages([2]);
    await render({ currentPage: 2 });
    vi.mocked(props.onPageChange!).mockClear();
    const fractionAtCenter = () => (400 - wrappers[1].getBoundingClientRect().top) /
      parseFloat((wrappers[1].querySelector('.page-viewport') as HTMLElement).style.height);
    expect(fractionAtCenter()).toBeCloseTo(0.4);
    await render({ scale: 2 });
    expect(fractionAtCenter()).toBeCloseTo(0.4);
    await render({ rotation: 90 });
    expect(fractionAtCenter()).toBeCloseTo(0.4);
    expect(props.onPageChange).not.toHaveBeenCalled();
  });

  it('scrolls a link to an unmounted page and does not repeat it on later zoom', async () => {
    await render({ document: makeDocument(Array.from({ length: 20 }, (_, index) => makePage(index + 1))) });
    const { container, wrappers } = useMeasuredPageLayout();
    expect(host.querySelector('[data-page-canvas="20"]')).toBeNull();
    const destination = { pageNumber: 20, top: 700, left: 0 };
    await render({ currentPage: 20, highlightDestination: destination, activeMatchPage: 20, searchQuery: 'target' });
    expect(host.querySelector('[data-page-canvas="20"]')).not.toBeNull();
    expect(container.scrollTo).toHaveBeenLastCalledWith({ top: wrappers[19].getBoundingClientRect().top, behavior: 'smooth' });
    vi.mocked(container.scrollTo).mockClear();
    await render({ scale: 2 });
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it('preserves the captured current scroll for a null XYZ destination and does not reapply it after manual zoom', async () => {
    await render();
    const { container, wrappers } = useMeasuredPageLayout();
    container.scrollTop = 316; container.scrollLeft = 120;
    vi.spyOn(wrappers[0], 'getBoundingClientRect').mockImplementation(() => ({ ...rect(16 - container.scrollTop), left: 16 - container.scrollLeft }));
    // A visible reference point at (40, 100) is PDF (144, 400) on this page.
    // App fills null coordinates before page/zoom mutations using that snapshot.
    const destination = { pageNumber: 1, view: 'XYZ' as const, left: 144, top: 400 };
    await render({ highlightDestination: destination });
    expect(container.scrollTo).toHaveBeenLastCalledWith({ left: 120, top: 316, behavior: 'smooth' });
    vi.mocked(container.scrollTo).mockClear();
    await render({ scale: 2 });
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it('tracks scrolling after the initial load without reloading canvases or snapping to the page top', async () => {
    await render();
    const canvases = new Map([...host.querySelectorAll('canvas')].map(canvas => [canvas.dataset.pageCanvas, canvas]));
    expect(props.document.getPage).toHaveBeenCalledTimes(3);
    scrollIntoView.mockClear();

    await scrollToSecondPage();
    expect(props.onPageChange).toHaveBeenCalledWith(2);
    await render({ currentPage: 2 });

    expect(props.document.getPage).toHaveBeenCalledTimes(3);
    for (const [pageNumber, canvas] of canvases) expect(host.querySelector(`[data-page-canvas="${pageNumber}"]`)).toBe(canvas);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to a requested page after loading and preserves canvases on later navigation', async () => {
    await render({ currentPage: 3 });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(host.querySelector('[data-page="3"]'));
    const secondCanvas = host.querySelector('[data-page-canvas="2"]');

    await render({ currentPage: 2 });
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(host.querySelector('[data-page="2"]'));
    expect(props.document.getPage).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[data-page-canvas="2"]')).toBe(secondCanvas);
  });

  it('does not reload a two-page spread when selecting its other page', async () => {
    await render({ viewMode: 'two-page' });
    const canvases = [...host.querySelectorAll('canvas')];
    await render({ currentPage: 2 });
    expect(props.document.getPage).toHaveBeenCalledTimes(2);
    host.querySelectorAll('canvas').forEach((canvas, index) => expect(canvas).toBe(canvases[index]));
  });

  it('removes detached page refs when replacing the document', async () => {
    await render();
    await scrollToSecondPage();
    await render({ document: makeDocument([makePage(1)]), documentVersion: 2 });
    vi.mocked(props.onPageChange!).mockClear();
    const container = host.querySelector('.pdf-viewer-container') as HTMLElement;
    const page = host.querySelector('.page-wrapper') as HTMLElement;
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect(1000));

    await act(async () => {
      container.dispatchEvent(new Event('scroll'));
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
    expect(props.onPageChange).not.toHaveBeenCalled();
  });

  it('combines embedded and view rotation when fitting a page', async () => {
    const page = makePage(1, 600, 800, 90);
    await render({ document: makeDocument([page]), viewMode: 'single', zoomMode: 'fit-width' });
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1, rotation: 90 });
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo(920 / 800);
  });

  it('fits the actual dimensions of both pages and leaves the gap unscaled', async () => {
    await render({
      document: makeDocument([makePage(1, 300, 400), makePage(2, 600, 1200)]),
      viewMode: 'two-page',
      zoomMode: 'fit-page',
    });
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo(720 / 1200);
    await render({ zoomMode: 'fit-width' });
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo((920 - 16) / 900);
  });

  it('fits a final unpaired page without reserving a missing second page', async () => {
    await render({ currentPage: 3, viewMode: 'two-page', zoomMode: 'fit-width' });
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo(920 / 600);
  });

  it('updates fit zoom when the container changes size without a window resize event', async () => {
    const onCalculatedZoomChange = vi.fn();
    await render({ viewMode: 'single', zoomMode: 'fit-width', onCalculatedZoomChange });
    const container = host.querySelector('.pdf-viewer-container') as HTMLElement;
    const observer = resizeObservers.at(-1)!;
    expect(observer.elements.has(container)).toBe(true);
    vi.spyOn(container, 'clientWidth', 'get').mockReturnValue(720);
    await act(async () => { observer.callback([], {} as ResizeObserver); });
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo(640 / 600);
    expect(onCalculatedZoomChange).toHaveBeenLastCalledWith(640 / 600);
    expect(props.document.getPage).toHaveBeenCalledTimes(1);
    await render({ zoomMode: 'manual', scale: 1.7 });
    onCalculatedZoomChange.mockClear();
    vi.spyOn(container, 'clientWidth', 'get').mockReturnValue(900);
    await act(async () => { observer.callback([], {} as ResizeObserver); });
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBe(1.7);
    expect(onCalculatedZoomChange).not.toHaveBeenCalled();
  });

  it('does not loop when the parent stores fit zoom and recreates its callback on each render', async () => {
    const callback = vi.fn();
    function Parent() {
      const [navigation, setNavigation] = useState({ scale: 1 });
      return <PDFViewer {...props} viewMode="single" zoomMode="fit-width" scale={navigation.scale} onCalculatedZoomChange={value => {
        callback(value);
        setNavigation({ scale: value });
      }} />;
    }
    await act(async () => { root.render(<Parent />); });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(Number(host.querySelector('canvas')?.getAttribute('data-scale'))).toBeCloseTo(920 / 600);
  });

  it('keeps the continuous anchor on a mixed-size page while fit zoom follows a sidebar resize', async () => {
    await render({ document: makeDocument([makePage(1, 300, 500), makePage(2, 600, 1000), makePage(3)]), zoomMode: 'fit-width' });
    const { container, wrappers } = useMeasuredPageLayout();
    const height = (index: number) => parseFloat((wrappers[index].querySelector('.page-viewport') as HTMLElement).style.height);
    container.scrollTop = 16 + height(0) + 40 + height(1) * 0.4 - 400;
    await observeVisiblePages([2]);
    await render({ currentPage: 2 });
    vi.mocked(props.onPageChange!).mockClear();
    vi.spyOn(container, 'clientWidth', 'get').mockReturnValue(760);
    await act(async () => { resizeObservers.at(-1)!.callback([], {} as ResizeObserver); });
    expect((400 - wrappers[1].getBoundingClientRect().top) / height(1)).toBeCloseTo(0.4);
    expect(props.onPageChange).not.toHaveBeenCalled();
    expect(props.document.getPage).toHaveBeenCalledTimes(3);
  });

  it('derives loading from the current request and ignores a late old-document result', async () => {
    let resolveOld!: (page: PDFPageProxy) => void;
    const old = makeDocument([makePage(1)]);
    vi.mocked(old.getPage).mockReturnValue(new Promise(resolve => { resolveOld = resolve; }));
    await render({ document: old, viewMode: 'single' });
    expect(host.querySelector('.pdf-viewer-loading')).not.toBeNull();
    expect(host.querySelector('canvas')).toBeNull();
    await render({ document: makeDocument([makePage(1, 200, 300)]), documentVersion: 2 });
    const canvas = host.querySelector('canvas');
    expect(canvas).not.toBeNull();
    await act(async () => { resolveOld(makePage(1, 900, 1000)); });
    expect(host.querySelector('canvas')).toBe(canvas);
    expect(host.querySelector('.pdf-viewer-loading')).toBeNull();
    expect((host.querySelector('.page-viewport') as HTMLElement).style.width).toBe('200px');
  });

  it('cancels a queued scroll frame when the view changes', async () => {
    await render();
    host.querySelector('.pdf-viewer-container')!.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    await render({ viewMode: 'single' });
    expect(frames.size).toBe(0);
  });
  it('leaves Space to editable controls while preserving viewer panning', async () => {
    await render();
    const container = host.querySelector('.pdf-viewer-container') as HTMLElement;
    const controls = document.createElement('div');
    controls.innerHTML = '<input /><textarea></textarea><select><option>Page</option></select>' +
      '<div contenteditable="true"><span>Rich text</span></div>' +
      '<div contenteditable><span>Inherited editing</span></div>' +
      '<div contenteditable="plaintext-only"><span>Plain text</span></div>';
    host.appendChild(controls);

    for (const target of controls.querySelectorAll('input, textarea, select, [contenteditable], span')) {
      const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(container.classList.contains('pan-mode')).toBe(false);
    }

    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    await act(async () => { container.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(container.classList.contains('pan-mode')).toBe(true);
    await act(async () => { container.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true })); });
    expect(container.classList.contains('pan-mode')).toBe(false);
  });

});
