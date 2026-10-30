import { useLocale } from "../../i18n";
import { useEffect, useState, useMemo } from 'react';
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
  useLocale();
  const [isVisible, setIsVisible] = useState(false);
  const position = useMemo(() => {
    const viewport = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });
    const [x, y] = viewport.convertToViewportPoint(left ?? page.view[0], top ?? page.view[3]);
    return {
      x: Math.max(0, Math.min(x, viewport.width - 100)),
      y: Math.max(0, Math.min(y, viewport.height - 30)),
    };
  }, [page, scale, rotation, top, left]);

  useEffect(() => {
    // Trigger animation
    const frame = requestAnimationFrame(() => {
      setIsVisible(true);
    });

    // Fade out after delay
    const fadeTimer = setTimeout(() => {
      setIsVisible(false);
    }, 2000);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fadeTimer);
    };
  }, [page, scale, rotation, top, left]);

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
