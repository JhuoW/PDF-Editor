import { useLocale, t } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';

/** Renders the generated PDF bytes rather than an approximation of its decorations. */
export function DecorationPDFPreview({ data, pageNumber, onError, scale }: { data: Uint8Array; pageNumber: number; onError: (message: string) => void; scale?: number }) {
  useLocale();
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const errorCallback = useRef(onError);
  useLayoutEffect(() => { errorCallback.current = onError; }, [onError]);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [loaded, setLoaded] = useState<{ data: Uint8Array; number: number; page: PDFPageProxy } | null>(null);
  const [rendered, setRendered] = useState<object | null>(null);
  const page = loaded?.data === data && loaded.number === pageNumber ? loaded.page : null;
  const viewport = useMemo(() => {
    if (!page) return null;
    const bounds = page.getViewport({ scale: 1 });
    return page.getViewport({ scale: scale ?? Math.min(1.5, Math.max(.05, (availableWidth - 24) / bounds.width)) });
  }, [page, availableWidth, scale]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setAvailableWidth(width); });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false;
    const task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: data.slice() });
    void task.promise.then(document => document.getPage(pageNumber)).then(page => { if (!canceled) setLoaded({ data, number: pageNumber, page }); })
      .catch(cause => { if (!canceled) errorCallback.current(cause instanceof Error ? cause.message : 'Could not load the PDF preview.'); });
    return () => { canceled = true; void task.destroy().catch(() => {}); };
  }, [data, pageNumber]);
  useEffect(() => {
    if (!page || !viewport || !canvas.current) return;
    const element = canvas.current, context = element.getContext('2d');
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    // Avoid an extra bitmap pixel from floating-point noise (423.00000000000006).
    // That extra pixel makes the browser rescale and blur an otherwise exact preview.
    element.width = Math.ceil(viewport.width * ratio - 1e-6); element.height = Math.ceil(viewport.height * ratio - 1e-6);
    let canceled = false;
    const task = page.render({ canvas: element, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    void task.promise.then(() => { if (!canceled) setRendered(viewport); }).catch(cause => { if (!canceled && cause?.name !== 'RenderingCancelledException') errorCallback.current(cause instanceof Error ? cause.message : 'Could not render the PDF preview.'); });
    return () => { canceled = true; task.cancel(); };
  }, [page, viewport]);
  return <div ref={host} className="decoration-pdf-preview" aria-busy={!viewport || rendered !== viewport}>
    {(!viewport || rendered !== viewport) && <p role="status">{t("m.rendering.pdf.preview.6934dd")}</p>}
    {viewport && <canvas key={`${pageNumber}-${viewport.width}-${viewport.height}`} ref={canvas} aria-label={t("m.generated.pdf.page.preview.0c50b5")} style={{ width: viewport.width, height: viewport.height }} />}
  </div>;
}
