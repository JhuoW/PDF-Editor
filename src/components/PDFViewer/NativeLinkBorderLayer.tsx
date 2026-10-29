import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';

interface BorderAnnotation {
  id?: string; subtype?: string; rect?: number[]; annotationFlags?: number; hasAppearance?: boolean;
  borderColor?: Uint8ClampedArray | Uint8Array | number[] | null;
  borderStyle?: { width: number; style: number; dashArray?: number[]; horizontalCornerRadius?: number; verticalCornerRadius?: number };
}
interface Props { page: PDFPageProxy; viewport: PageViewport; onReady?: () => void; onError?: (message: string) => void }

/** PDF.js paints Link borders in its DOM layer, not in the page canvas. */
export function NativeLinkBorderLayer({ page, viewport, onReady, onError }: Props) {
  const [loaded, setLoaded] = useState<{ page: PDFPageProxy; annotations: BorderAnnotation[] } | null>(null);
  const callbacks = useRef({ onReady, onError });
  useLayoutEffect(() => { callbacks.current = { onReady, onError }; });
  useEffect(() => {
    let canceled = false;
    void page.getAnnotations({ intent: 'display' }).then(annotations => {
      if (!canceled) setLoaded({ page, annotations });
    }).catch(error => {
      if (!canceled) callbacks.current.onError?.(error instanceof Error ? error.message : 'Could not render native link borders.');
    });
    return () => { canceled = true; };
  }, [page]);
  useEffect(() => { if (loaded?.page === page) callbacks.current.onReady?.(); }, [loaded, page, viewport]);
  const annotations = loaded?.page === page ? loaded.annotations : [];
  return <svg className="native-link-border-layer" aria-hidden="true" width={viewport.width} height={viewport.height}
    viewBox={`0 0 ${viewport.width} ${viewport.height}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <g transform={`matrix(${viewport.transform.join(' ')})`} fill="none">
      {annotations.map((annotation, index) => {
        const { rect, borderStyle: border, borderColor: color } = annotation;
        if (annotation.subtype !== 'Link' || annotation.hasAppearance || ((annotation.annotationFlags ?? 0) & (2 | 32))
          || !rect || rect.length !== 4 || !rect.every(Number.isFinite) || !border || !Number.isFinite(border.width) || border.width <= 0
          || ![1, 2, 5].includes(border.style) || !color || color.length !== 3 || !Array.from(color).every(Number.isFinite)) return null;
        const left = Math.min(rect[0], rect[2]), bottom = Math.min(rect[1], rect[3]);
        const width = Math.abs(rect[2] - rect[0]), height = Math.abs(rect[3] - rect[1]);
        if (width <= 0 || height <= 0) return null;
        const stroke = `rgb(${Array.from(color, channel => Math.max(0, Math.min(255, Math.round(channel)))).join(', ')})`;
        const strokeWidth = Math.min(border.width, width, height), inset = strokeWidth / 2;
        const common = { stroke, strokeWidth, 'data-annotation-id': annotation.id ?? String(index) };
        // PDF's bottom edge must rotate with the page; screen border-bottom is
        // the wrong edge on pages with Rotate=90/180/270. The viewport matrix
        // also accounts for CropBox origin, UserUnit, and the viewer zoom.
        if (border.style === 5) return <line key={`${annotation.id ?? ''}:${index}`} {...common} x1={left} y1={bottom + inset} x2={left + width} y2={bottom + inset} />;
        const dash = border.style === 2 && border.dashArray?.length && border.dashArray.every(value => Number.isFinite(value) && value >= 0)
          ? border.dashArray.join(' ') : undefined;
        return <rect key={`${annotation.id ?? ''}:${index}`} {...common} x={left + inset} y={bottom + inset} width={Math.max(0, width - strokeWidth)} height={Math.max(0, height - strokeWidth)}
          rx={Math.max(0, border.horizontalCornerRadius ?? 0)} ry={Math.max(0, border.verticalCornerRadius ?? 0)} strokeDasharray={dash} />;
      })}
    </g>
  </svg>;
}
