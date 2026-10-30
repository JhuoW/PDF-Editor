import { useLocale, t } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';
import { mapViewportPoint, mapViewportRect, type ViewportRect } from '../../utils/viewportMapping';
import { fitLinkRect } from './pdfLinksDraft';
import { NativeLinkBorderLayer } from '../PDFViewer/NativeLinkBorderLayer';

export interface LinkPreviewItem { id: string; label: string; pageNumber: number; rect?: ViewportRect; editable: boolean }
interface Props {
  data: Uint8Array; pageNumber: number; links: LinkPreviewItem[]; selectedId: string | null;
  placing: boolean; disabled: boolean; scale?: number; showAreas: boolean;
  onSelect: (id: string | null) => void; onCreate: (rect: ViewportRect) => void;
  onMove: (id: string, rect: ViewportRect) => void; onDelete: (id: string) => void;
  onInteractionChange: (active: boolean) => void; onReady: () => void; onError: (message: string) => void;
}
interface Gesture { pointer: number; kind: 'create' | 'move' | 'resize'; start: [number, number]; id?: string; rect?: ViewportRect }
export function PDFLinksPreview({ data, pageNumber, links, selectedId, placing, disabled, scale, showAreas, onSelect, onCreate, onMove, onDelete, onInteractionChange, onReady, onError }: Props) {
  useLocale();
  const host = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), gesture = useRef<Gesture | null>(null);
  const callbacks = useRef({ onReady, onError, onInteractionChange });
  const [availableWidth, setAvailableWidth] = useState(600), [loaded, setLoaded] = useState<{ data: Uint8Array; number: number; page: PDFPageProxy } | null>(null), [rendered, setRendered] = useState<object | null>(null), [ghost, setGhost] = useState<ViewportRect | null>(null);
  const [bordersRendered, setBordersRendered] = useState<object | null>(null), [failedViewport, setFailedViewport] = useState<object | null>(null);
  const page = loaded?.data === data && loaded.number === pageNumber ? loaded.page : null;
  const source = useMemo(() => page?.getViewport({ scale: 1, rotation: 0 }), [page]);
  const viewport = useMemo(() => {
    if (!page) return null;
    const bounds = page.getViewport({ scale: 1 });
    return page.getViewport({ scale: scale ?? Math.min(1.5, Math.max(.05, (availableWidth - 24) / bounds.width)) });
  }, [page, scale, availableWidth]);
  const ready = !!viewport && rendered === viewport && bordersRendered === viewport && failedViewport !== viewport;
  useLayoutEffect(() => { callbacks.current = { onReady, onError, onInteractionChange }; });
  useEffect(() => { if (ready) callbacks.current.onReady(); }, [ready, viewport]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setAvailableWidth(width); }); observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false;
    const task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: data.slice() });
    void task.promise.then(document => document.getPage(pageNumber)).then(page => { if (!canceled) setLoaded({ data, number: pageNumber, page }); })
      .catch(cause => { if (!canceled) callbacks.current.onError(cause instanceof Error ? cause.message : 'Could not load the links preview.'); });
    return () => { canceled = true; if (gesture.current) { gesture.current = null; callbacks.current.onInteractionChange(false); } void task.destroy().catch(() => {}); };
  }, [data, pageNumber]);
  useEffect(() => {
    if (!page || !viewport || !canvas.current) return;
    const element = canvas.current, context = element.getContext('2d'); if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2); element.width = Math.ceil(viewport.width * ratio - 1e-6); element.height = Math.ceil(viewport.height * ratio - 1e-6);
    let canceled = false;
    // The canvas renders page and annotation appearances; the inert SVG below supplies
    // native Link borders that PDF.js normally paints in its interactive DOM layer.
    const task = page.render({ canvas: element, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    void task.promise.then(() => { if (!canceled) setRendered(viewport); }).catch(cause => { if (!canceled && cause?.name !== 'RenderingCancelledException') { setFailedViewport(viewport); callbacks.current.onError(cause instanceof Error ? cause.message : 'Could not render the links preview.'); } });
    return () => { canceled = true; task.cancel(); };
  }, [page, viewport]);
  const point = (event: ReactPointerEvent): [number, number] | null => {
    if (!source || !viewport || !overlay.current) return null;
    const box = overlay.current.getBoundingClientRect(), position = mapViewportPoint(event.clientX - box.left, event.clientY - box.top, viewport, source); return [position.x, position.y];
  };
  const begin = (event: ReactPointerEvent, kind: Gesture['kind'], item?: LinkPreviewItem) => {
    if (disabled || event.button !== 0 || (kind !== 'create' && !item?.editable)) return;
    const start = point(event); if (!start) return;
    event.preventDefault(); event.stopPropagation(); if (item) onSelect(item.id);
    overlay.current?.focus({ preventScroll: true }); overlay.current?.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, kind, start, id: item?.id, rect: item?.rect }; onInteractionChange(true);
  };
  const move = (event: ReactPointerEvent) => {
    const active = gesture.current, position = point(event); if (!active || !position || !source || active.pointer !== event.pointerId || disabled) return;
    const dx = position[0] - active.start[0], dy = position[1] - active.start[1];
    if (active.kind === 'create') setGhost(fitLinkRect({ x: Math.min(position[0], active.start[0]), y: Math.min(position[1], active.start[1]), width: Math.abs(dx), height: Math.abs(dy) }, source.width, source.height));
    else if (active.rect && active.id) onMove(active.id, fitLinkRect(active.kind === 'move' ? { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy } : { ...active.rect, width: Math.max(1, Math.min(source.width - active.rect.x, active.rect.width + dx)), height: Math.max(1, Math.min(source.height - active.rect.y, active.rect.height + dy)) }, source.width, source.height));
  };
  const finish = (event: ReactPointerEvent, cancel = false) => {
    const active = gesture.current, position = point(event); if (!active || active.pointer !== event.pointerId) return;
    if (cancel) { if (active.id && active.rect) onMove(active.id, active.rect); }
    else if (active.kind === 'create' && position && source) {
      const width = Math.abs(position[0] - active.start[0]), height = Math.abs(position[1] - active.start[1]), click = width < 4 && height < 4;
      onCreate(fitLinkRect({ x: click ? active.start[0] : Math.min(position[0], active.start[0]), y: click ? active.start[1] : Math.min(position[1], active.start[1]), width: click ? 120 : width, height: click ? 28 : height }, source.width, source.height));
    } else move(event);
    gesture.current = null; setGhost(null); if (overlay.current?.hasPointerCapture(event.pointerId)) overlay.current.releasePointerCapture(event.pointerId); onInteractionChange(false);
  };
  const style = (rect: ViewportRect) => { if (!source || !viewport) return {}; const mapped = mapViewportRect(rect, source, viewport); return { left: mapped.x, top: mapped.y, width: mapped.width, height: mapped.height }; };
  return <div ref={host} className="pdf-links-preview" aria-busy={!ready}>
    {!ready && <p role="status">{t("m.rendering.pdf.preview.6934dd")}</p>}
    {source && viewport && <div className="pdf-links-page" style={{ width: viewport.width, height: viewport.height }}>
      <canvas key={`${pageNumber}-${viewport.width}-${viewport.height}`} ref={canvas} aria-label={t("m.links.page.preview.c28586", { v0: pageNumber })} style={{ width: viewport.width, height: viewport.height }} />
      <NativeLinkBorderLayer page={page!} viewport={viewport} onReady={() => setBordersRendered(viewport)} onError={message => { setFailedViewport(viewport); callbacks.current.onError(message); }} />
      <div ref={overlay} className={`pdf-links-overlay ${placing ? 'placing' : ''}`} tabIndex={0} role="region" aria-label={t("m.link.areas.d5e715")} onPointerDown={event => { if (placing) begin(event, 'create'); else if (event.target === event.currentTarget && !disabled) onSelect(null); }} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onKeyDown={event => {
        if (disabled) return;
        const selected = links.find(item => item.id === selectedId && item.pageNumber === pageNumber); if (!selected) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDelete(selected.id); return; }
        if (!selected.editable || !selected.rect) return;
        const amount = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0, dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0; if (!dx && !dy) return;
        event.preventDefault(); const origin = mapViewportPoint(0, 0, viewport, source), moved = mapViewportPoint(dx * viewport.scale, dy * viewport.scale, viewport, source);
        onMove(selected.id, fitLinkRect({ ...selected.rect, x: selected.rect.x + moved.x - origin.x, y: selected.rect.y + moved.y - origin.y }, source.width, source.height));
      }}>
        {showAreas && links.filter(item => item.pageNumber === pageNumber && item.rect && [item.rect.x, item.rect.y, item.rect.width, item.rect.height].every(Number.isFinite) && item.rect.width > 0 && item.rect.height > 0 && item.rect.x + item.rect.width > 0 && item.rect.y + item.rect.height > 0 && item.rect.x < source.width && item.rect.y < source.height).map(item => {
          const selected = item.id === selectedId, original = item.rect!, rect = { x: Math.max(0, original.x), y: Math.max(0, original.y), width: Math.min(source.width, original.x + original.width) - Math.max(0, original.x), height: Math.min(source.height, original.y + original.height) - Math.max(0, original.y) }, corner = mapViewportPoint(rect.x + rect.width, rect.y + rect.height, source, viewport);
          return <div key={item.id}>
            <button type="button" disabled={disabled} className={`pdf-links-area ${selected ? 'selected' : ''} ${!item.editable ? 'readonly' : ''}`} aria-label={t("m.select.link.cc7ea8", { v0: item.label })} style={style(rect)} onPointerDown={event => { if (placing) return; if (item.editable) begin(event, 'move', item); else { event.stopPropagation(); onSelect(item.id); } }} onClick={event => { event.stopPropagation(); if (!placing) onSelect(item.id); }} />
            {selected && item.editable && !disabled && !placing && <button type="button" className="pdf-links-resize" aria-label={t("m.resize.link.area.45f56d")} style={{ left: corner.x - 7, top: corner.y - 7 }} onPointerDown={event => begin(event, 'resize', item)} />}
          </div>;
        })}
        {ghost && <div className="pdf-links-ghost" style={style(ghost)} />}
      </div>
    </div>}
  </div>;
}
