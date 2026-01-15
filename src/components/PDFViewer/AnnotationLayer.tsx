import { useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import './AnnotationLayer.css';

interface AnnotationLayerProps {
  page: PDFPageProxy;
  scale: number;
  rotation: number;
  onLinkClick?: (dest: unknown) => void;
}

export function AnnotationLayer({
  page,
  scale,
  rotation,
  onLinkClick,
}: AnnotationLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !page) return;

    // Clear previous annotations
    container.innerHTML = '';

    // Calculate effective rotation (page's embedded rotation + view rotation)
    const effectiveRotation = getEffectiveRotation(page, rotation);
    const viewport = page.getViewport({ scale, rotation: effectiveRotation });

    // Set container dimensions
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    let cancelled = false;

    const renderAnnotations = async () => {
      try {
        const annotations = await page.getAnnotations();

        if (cancelled) return;

        for (const annotation of annotations) {
          // Only handle link annotations
          if (annotation.subtype !== 'Link') continue;

          // Get the annotation rectangle
          const rect = annotation.rect;
          if (!rect || rect.length < 4) continue;

          // Transform coordinates to viewport
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);

          // Create link element
          const link = document.createElement('a');
          link.className = 'pdf-link-annotation';

          // Position the link
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1);
          const height = Math.abs(y2 - y1);

          link.style.left = `${left}px`;
          link.style.top = `${top}px`;
          link.style.width = `${width}px`;
          link.style.height = `${height}px`;

          // Handle click
          if (annotation.dest) {
            // Internal link (destination within document)
            link.href = '#';
            link.title = 'Go to destination';
            link.onclick = (e) => {
              e.preventDefault();
              if (onLinkClick) {
                onLinkClick(annotation.dest);
              }
            };
          } else if (annotation.url) {
            // External link
            link.href = annotation.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = annotation.url;
          } else if (annotation.action) {
            // Action-based link (like GoTo action)
            const action = annotation.action;
            if (action.dest) {
              link.href = '#';
              link.title = 'Go to destination';
              link.onclick = (e) => {
                e.preventDefault();
                if (onLinkClick) {
                  onLinkClick(action.dest);
                }
              };
            }
          }

          container.appendChild(link);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error rendering annotations:', error);
        }
      }
    };

    renderAnnotations();

    return () => {
      cancelled = true;
    };
  }, [page, scale, rotation, onLinkClick]);

  return <div ref={containerRef} className="annotation-layer-container" />;
}
