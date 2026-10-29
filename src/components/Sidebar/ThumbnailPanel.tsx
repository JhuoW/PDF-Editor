import { useEffect, useState, useRef } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { movePageSelection } from '../../core/pageMapping';
import './ThumbnailPanel.css';

interface ThumbnailPanelProps {
  document: PDFDocumentProxy;
  currentPage: number;
  selectedPages?: number[];
  onPageSelect: (page: number, multiSelect: boolean) => void;
  onReorderPages?: (order: number[]) => void;
}

interface ThumbnailData {
  pageNumber: number;
  dataUrl: string | null;
  loading: boolean;
}

const THUMBNAIL_WIDTH = 120;
const MAX_CONCURRENT_RENDERS = 2;
const initialThumbnails = (document: PDFDocumentProxy): ThumbnailData[] =>
  Array.from({ length: document.numPages }, (_, index) => ({ pageNumber: index + 1, dataUrl: null, loading: false }));

export function ThumbnailPanel({ document, currentPage, selectedPages = [], onPageSelect, onReorderPages }: ThumbnailPanelProps) {
  const [state, setState] = useState(() => ({ document, items: initialThumbnails(document) }));
  // A changed document owns a new thumbnail cache. Late renders check the owner
  // before publishing, even when the parent does not remount this component.
  if (state.document !== document) setState({ document, items: initialThumbnails(document) });
  const thumbnails = state.document === document ? state.items : initialThumbnails(document);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggedPages = useRef<number[]>([]);
  const [dropTarget, setDropTarget] = useState<{ page: number; after: boolean } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let running = 0;
    const queue = new Set<number>();
    const started = new Set<number>();
    const tasks = new Set<RenderTask>();
    const update = (pageNumber: number, changes: Partial<ThumbnailData>) => {
      if (disposed) return;
      setState(previous => previous.document !== document ? previous : {
        ...previous,
        items: previous.items.map(item => item.pageNumber === pageNumber ? { ...item, ...changes } : item),
      });
    };
    const render = async (pageNumber: number) => {
      let task: RenderTask | undefined;
      let canvas: HTMLCanvasElement | undefined;
      try {
        update(pageNumber, { loading: true });
        const page = await document.getPage(pageNumber);
        if (disposed) return;
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(THUMBNAIL_WIDTH / size.width, 1000 / size.height) });
        canvas = window.document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is unavailable');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvasContext: context, viewport, canvas });
        tasks.add(task);
        await task.promise;
        update(pageNumber, { dataUrl: canvas.toDataURL(), loading: false });
      } catch (error) {
        if (!disposed) {
          console.error(`Error rendering thumbnail for page ${pageNumber}:`, error);
          update(pageNumber, { loading: false });
        }
      } finally {
        if (task) tasks.delete(task);
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        running--;
        pump();
      }
    };
    const pump = () => {
      while (!disposed && running < MAX_CONCURRENT_RENDERS && queue.size) {
        const pageNumber = queue.values().next().value!;
        queue.delete(pageNumber);
        started.add(pageNumber);
        running++;
        void render(pageNumber);
      }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.getAttribute('data-page'));
        if (!entry.isIntersecting) queue.delete(pageNumber);
        else if (!started.has(pageNumber)) queue.add(pageNumber);
      }
      pump();
    }, { root: container.querySelector('.thumbnail-list'), rootMargin: '100px', threshold: 0 });
    container.querySelectorAll('.thumbnail-item').forEach(item => observer.observe(item));
    return () => {
      disposed = true;
      observer.disconnect();
      queue.clear();
      tasks.forEach(task => task.cancel());
    };
  }, [document]);

  // Scroll to current page thumbnail
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const currentThumbnail = container.querySelector(`[data-page="${currentPage}"]`);
    if (currentThumbnail) {
      currentThumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentPage]);

  return (
    <div className="thumbnail-panel" ref={containerRef}>
      <div className="thumbnail-panel-header">
        <span>Pages</span>
        {onReorderPages && <span className="thumbnail-reorder-hint">Drag to reorder</span>}
      </div>
      <div className="thumbnail-list">
        {thumbnails.map((thumbnail) => (
          <div
            key={thumbnail.pageNumber}
            className={`thumbnail-item ${currentPage === thumbnail.pageNumber ? 'active' : ''} ${selectedPages.includes(thumbnail.pageNumber) ? 'selected' : ''} ${dropTarget?.page === thumbnail.pageNumber ? dropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
            role="group"
            aria-label={`Page ${thumbnail.pageNumber}`}
            draggable={!!onReorderPages}
            onDragStart={event => {
              if (!onReorderPages) return;
              draggedPages.current = selectedPages.includes(thumbnail.pageNumber) ? selectedPages : [thumbnail.pageNumber];
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-pdf-editor-pages', JSON.stringify(draggedPages.current));
              event.stopPropagation();
            }}
            onDragOver={event => {
              if (!draggedPages.current.length) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              setDropTarget({ page: thumbnail.pageNumber, after: event.clientY > bounds.top + bounds.height / 2 });
            }}
            onDrop={event => {
              if (!draggedPages.current.length || !onReorderPages) return;
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              const before = thumbnail.pageNumber + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
              const order = movePageSelection(document.numPages, draggedPages.current, before);
              draggedPages.current = [];
              setDropTarget(null);
              if (order.some((page, index) => page !== index + 1)) onReorderPages(order);
            }}
            onDragEnd={() => { draggedPages.current = []; setDropTarget(null); }}
            data-page={thumbnail.pageNumber}
          >
            <button className="thumbnail-select" type="button"
              aria-label={`Go to page ${thumbnail.pageNumber}`}
              aria-current={currentPage === thumbnail.pageNumber ? 'page' : undefined}
              onClick={event => onPageSelect(thumbnail.pageNumber, event.ctrlKey || event.metaKey)}>
            <div className="thumbnail-canvas" style={{ width: THUMBNAIL_WIDTH }}>
              {thumbnail.dataUrl ? (
                <img src={thumbnail.dataUrl} alt="" draggable={false} />
              ) : thumbnail.loading ? (
                <div className="thumbnail-loading">Loading...</div>
              ) : (
                <div className="thumbnail-placeholder" />
              )}
            </div>
            <span className="thumbnail-label">{thumbnail.pageNumber}</span>
            </button>
            {onReorderPages && (
              <div className="thumbnail-move-controls">
                <button aria-label={`Move page ${thumbnail.pageNumber} earlier`} disabled={thumbnail.pageNumber === 1}
                  onClick={event => { event.stopPropagation(); onReorderPages(movePageSelection(document.numPages, [thumbnail.pageNumber], thumbnail.pageNumber - 1)); }}>↑</button>
                <button aria-label={`Move page ${thumbnail.pageNumber} later`} disabled={thumbnail.pageNumber === document.numPages}
                  onClick={event => { event.stopPropagation(); onReorderPages(movePageSelection(document.numPages, [thumbnail.pageNumber], thumbnail.pageNumber + 2)); }}>↓</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
