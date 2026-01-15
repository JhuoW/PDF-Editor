import { useEffect, useState, useRef, useCallback } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import './ThumbnailPanel.css';

interface ThumbnailPanelProps {
  document: PDFDocumentProxy;
  currentPage: number;
  selectedPages?: number[];
  onPageSelect: (page: number, multiSelect: boolean) => void;
}

interface ThumbnailData {
  pageNumber: number;
  dataUrl: string | null;
  loading: boolean;
}

const THUMBNAIL_SCALE = 0.2;
const THUMBNAIL_WIDTH = 120;

export function ThumbnailPanel({ document, currentPage, selectedPages = [], onPageSelect }: ThumbnailPanelProps) {
  const [thumbnails, setThumbnails] = useState<ThumbnailData[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Initialize thumbnail data
  useEffect(() => {
    if (!document) return;

    const initialThumbnails: ThumbnailData[] = [];
    for (let i = 1; i <= document.numPages; i++) {
      initialThumbnails.push({
        pageNumber: i,
        dataUrl: null,
        loading: false,
      });
    }
    setThumbnails(initialThumbnails);
  }, [document]);

  // Render thumbnail for a specific page
  const renderThumbnail = useCallback(async (pageNumber: number) => {
    if (!document) return;

    setThumbnails((prev) =>
      prev.map((t) =>
        t.pageNumber === pageNumber ? { ...t, loading: true } : t
      )
    );

    try {
      const page: PDFPageProxy = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: THUMBNAIL_SCALE });

      const canvas = window.document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({
        canvasContext: context,
        viewport,
        canvas,
      }).promise;

      const dataUrl = canvas.toDataURL();

      setThumbnails((prev) =>
        prev.map((t) =>
          t.pageNumber === pageNumber ? { ...t, dataUrl, loading: false } : t
        )
      );
    } catch (error) {
      console.error(`Error rendering thumbnail for page ${pageNumber}:`, error);
      setThumbnails((prev) =>
        prev.map((t) =>
          t.pageNumber === pageNumber ? { ...t, loading: false } : t
        )
      );
    }
  }, [document]);

  // Set up intersection observer for lazy loading
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNumber = parseInt(entry.target.getAttribute('data-page') || '0', 10);
            const thumbnail = thumbnails.find((t) => t.pageNumber === pageNumber);
            if (thumbnail && !thumbnail.dataUrl && !thumbnail.loading) {
              renderThumbnail(pageNumber);
            }
          }
        });
      },
      {
        root: containerRef.current,
        rootMargin: '100px',
        threshold: 0,
      }
    );

    return () => {
      observerRef.current?.disconnect();
    };
  }, [thumbnails, renderThumbnail]);

  // Observe thumbnail elements
  useEffect(() => {
    const observer = observerRef.current;
    if (!observer) return;

    const container = containerRef.current;
    if (!container) return;

    const items = container.querySelectorAll('.thumbnail-item');
    items.forEach((item) => observer.observe(item));

    return () => {
      items.forEach((item) => observer.unobserve(item));
    };
  }, [thumbnails]);

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
      </div>
      <div className="thumbnail-list">
        {thumbnails.map((thumbnail) => (
          <div
            key={thumbnail.pageNumber}
            className={`thumbnail-item ${currentPage === thumbnail.pageNumber ? 'active' : ''} ${selectedPages.includes(thumbnail.pageNumber) ? 'selected' : ''}`}
            data-page={thumbnail.pageNumber}
            onClick={(e) => onPageSelect(thumbnail.pageNumber, e.ctrlKey || e.metaKey)}
          >
            <div className="thumbnail-canvas" style={{ width: THUMBNAIL_WIDTH }}>
              {thumbnail.dataUrl ? (
                <img src={thumbnail.dataUrl} alt={`Page ${thumbnail.pageNumber}`} />
              ) : thumbnail.loading ? (
                <div className="thumbnail-loading">Loading...</div>
              ) : (
                <div className="thumbnail-placeholder" />
              )}
            </div>
            <span className="thumbnail-label">{thumbnail.pageNumber}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
