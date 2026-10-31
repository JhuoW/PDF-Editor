import { useLocale, t } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { TextRect } from '../../editing/types';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';
import { mapViewportPoint, mapViewportRect } from '../../utils/viewportMapping';
import { boundedRaster } from '../../utils/rasterBudget';

interface Props {
  data: Uint8Array; pageNumber: number; sourceRect: TextRect; targetRect: TextRect;
  scale?: number; disabled: boolean; onChange: (rect: TextRect) => void;
  onInteractionChange: (active: boolean) => void; onError: (message: string) => void; onReady?: () => void;
}
interface Gesture { pointer: number; kind: 'move' | 'resize'; start: [number, number]; rect: TextRect }
function fitTextRect(rect: TextRect, width: number, height: number): TextRect {
  const w = Math.max(1, Math.min(width, rect.width)), h = Math.max(1, Math.min(height, rect.height));
  return { x: Math.max(0, Math.min(width - w, rect.x)), y: Math.max(0, Math.min(height - h, rect.y)), width: w, height: h };
}

export function TextLayoutPreview({ data, pageNumber, sourceRect, targetRect, scale, disabled, onChange, onInteractionChange, onError, onReady }: Props) {
  useLocale();
  const host = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), gesture = useRef<Gesture | null>(null);
  const errorCallback = useRef(onError), interactionCallback = useRef(onInteractionChange), readyCallback = useRef(onReady);
  const [availableWidth, setAvailableWidth] = useState(600), [loaded, setLoaded] = useState<{ data: Uint8Array; number: number; page: PDFPageProxy } | null>(null), [rendered, setRendered] = useState<object | null>(null);
  const page = loaded?.data === data && loaded.number === pageNumber ? loaded.page : null;
  const source = useMemo(() => page?.getViewport({ scale: 1, rotation: 0 }), [page]);
  const viewport = useMemo(() => {
    if (!page) return null;
    const bounds = page.getViewport({ scale: 1 });
    return page.getViewport({ scale: scale ?? Math.min(1.5, Math.max(.05, (availableWidth - 24) / bounds.width)) });
  }, [page, scale, availableWidth]);
  useLayoutEffect(() => { errorCallback.current = onError; interactionCallback.current = onInteractionChange; readyCallback.current = onReady; });
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setAvailableWidth(width); });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false;
    const task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: data.slice() });
    void task.promise.then(document => document.getPage(pageNumber)).then(page => { if (!canceled) setLoaded({ data, number: pageNumber, page }); })
      .catch(cause => { if (!canceled) errorCallback.current(cause instanceof Error ? cause.message : 'Could not load the text layout preview.'); });
    return () => { canceled = true; if (gesture.current) { gesture.current = null; interactionCallback.current(false); } void task.destroy().catch(() => {}); };
  }, [data, pageNumber]);
  useEffect(() => {
    if (!page || !viewport || !canvas.current) return;
    const element = canvas.current, context = element.getContext('2d'); if (!context) return;
    const raster = boundedRaster(viewport.width, viewport.height, Math.min(window.devicePixelRatio || 1, 2));
    element.width = raster.width; element.height = raster.height;
    let canceled = false;
    const task = page.render({ canvas: element, canvasContext: context, viewport, transform: [element.width / viewport.width, 0, 0, element.height / viewport.height, 0, 0] });
    void task.promise.then(() => { if (!canceled) { setRendered(viewport); readyCallback.current?.(); } }).catch(cause => { if (!canceled && cause?.name !== 'RenderingCancelledException') errorCallback.current(cause instanceof Error ? cause.message : 'Could not render the text layout preview.'); });
    return () => { canceled = true; task.cancel(); };
  }, [page, viewport]);
  const point = (event: ReactPointerEvent): [number, number] | null => {
    if (!source || !viewport || !overlay.current) return null;
    const box = overlay.current.getBoundingClientRect(), position = mapViewportPoint(event.clientX - box.left, event.clientY - box.top, viewport, source);
    return [position.x, position.y];
  };
  const begin = (event: ReactPointerEvent, kind: Gesture['kind']) => {
    if (disabled || event.button !== 0) return;
    const start = point(event); if (!start) return;
    event.preventDefault(); event.stopPropagation(); overlay.current?.focus({ preventScroll: true }); overlay.current?.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, kind, start, rect: { ...targetRect } }; onInteractionChange(true);
  };
  const move = (event: ReactPointerEvent) => {
    const active = gesture.current, position = point(event);
    if (!active || !position || !source || active.pointer !== event.pointerId || disabled) return;
    const dx = position[0] - active.start[0], dy = position[1] - active.start[1];
    const rect = active.kind === 'move' ? { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy }
      : { ...active.rect, width: Math.max(1, Math.min(source.width - active.rect.x, active.rect.width + dx)), height: Math.max(1, Math.min(source.height - active.rect.y, active.rect.height + dy)) };
    onChange(fitTextRect(rect, source.width, source.height));
  };
  const finish = (event: ReactPointerEvent, cancel = false) => {
    const active = gesture.current; if (!active || active.pointer !== event.pointerId) return;
    if (cancel) onChange(active.rect); else move(event);
    gesture.current = null; if (overlay.current?.hasPointerCapture(event.pointerId)) overlay.current.releasePointerCapture(event.pointerId); onInteractionChange(false);
  };
  const style = (rect: TextRect) => {
    if (!source || !viewport) return {};
    const bounds = mapViewportRect(rect, source, viewport); return { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
  };
  const corner = source && viewport ? mapViewportPoint(targetRect.x + targetRect.width, targetRect.y + targetRect.height, source, viewport) : { x: 0, y: 0 };
  return <div ref={host} className="text-layout-preview" aria-busy={!viewport || rendered !== viewport}>
    {(!viewport || rendered !== viewport) && <p role="status">{t("m.rendering.pdf.preview.6934dd")}</p>}
    {viewport && source && <div className="text-layout-page" style={{ width: viewport.width, height: viewport.height }}>
      <canvas key={`${pageNumber}-${viewport.width}-${viewport.height}`} ref={canvas} aria-label={t("m.text.layout.pdf.page.preview.60095c")} style={{ width: viewport.width, height: viewport.height }} />
      <div ref={overlay} className="text-layout-overlay" tabIndex={0} role="region" aria-label={t("m.text.layout.target.area.2648c3")} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onKeyDown={event => {
        if (disabled) return;
        const amount = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0, dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
        if (!dx && !dy) return;
        event.preventDefault();
        const origin = mapViewportPoint(0, 0, viewport, source), moved = mapViewportPoint(dx * viewport.scale, dy * viewport.scale, viewport, source);
        onChange(fitTextRect({ ...targetRect, x: targetRect.x + moved.x - origin.x, y: targetRect.y + moved.y - origin.y }, source.width, source.height));
      }}>
        <div className="text-layout-source-area" style={style(sourceRect)} aria-hidden="true" />
        <button type="button" disabled={disabled} aria-label={t("m.move.text.area.3dfda8")} className="text-layout-target-area" style={style(targetRect)} onPointerDown={event => begin(event, 'move')} />
        <button type="button" disabled={disabled} aria-label={t("m.resize.text.area.ec4048")} className="text-layout-resize" style={{ left: corner.x - 7, top: corner.y - 7 }} onPointerDown={event => begin(event, 'resize')} />
      </div>
    </div>}
  </div>;
}
