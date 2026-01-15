import { useEffect, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import './DestinationHighlight.css';

interface DestinationHighlightProps {
  page: PDFPageProxy;
  scale: number;
  rotation: number;
  top?: number;  // PDF coordinate (from bottom of page)
  left?: number;
}

export function DestinationHighlight({
  page,
  scale,
  rotation,
  top,
  left,
}: DestinationHighlightProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!page) return;

    // Calculate effective rotation (page's embedded rotation + view rotation)
    const effectiveRotation = getEffectiveRotation(page, rotation);
    const viewport = page.getViewport({ scale, rotation: effectiveRotation });
    const pageHeight = page.view[3] - page.view[1]; // PDF page height in PDF units

    // Convert PDF coordinates to viewport coordinates
    // PDF coordinates have origin at bottom-left, viewport at top-left
    let viewportX = 0;
    let viewportY = 0;

    if (top !== undefined) {
      // Convert from PDF coordinate (from bottom) to viewport coordinate (from top)
      viewportY = (pageHeight - top) * scale;
    }

    if (left !== undefined) {
      viewportX = left * scale;
    }

    // Handle rotation (use effective rotation for position transformation)
    if (effectiveRotation === 90) {
      const temp = viewportX;
      viewportX = viewportY;
      viewportY = viewport.height - temp;
    } else if (effectiveRotation === 180) {
      viewportX = viewport.width - viewportX;
      viewportY = viewport.height - viewportY;
    } else if (effectiveRotation === 270) {
      const temp = viewportX;
      viewportX = viewport.width - viewportY;
      viewportY = temp;
    }

    // Clamp to valid viewport bounds
    viewportX = Math.max(0, Math.min(viewportX, viewport.width - 100));
    viewportY = Math.max(0, Math.min(viewportY, viewport.height - 30));

    setPosition({ x: viewportX, y: viewportY });

    // Trigger animation
    requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Fade out after delay
    const fadeTimer = setTimeout(() => {
      setIsVisible(false);
    }, 2000);

    return () => {
      clearTimeout(fadeTimer);
    };
  }, [page, scale, rotation, top, left]);

  if (!position) return null;

  return (
    <div
      className={`destination-highlight ${isVisible ? 'visible' : ''}`}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      <div className="destination-highlight-bar" />
      <div className="destination-highlight-pulse" />
    </div>
  );
}
