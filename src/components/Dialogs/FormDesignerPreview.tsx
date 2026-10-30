import { useLocale, translateError, t } from "../../i18n";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnnotationMode, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { DesignableFieldType, FormDesignField, FormDesignWidget } from '../../forms/FormDesignerTypes';
import type { FormFieldRect } from '../../forms/types';
import { mapViewportPoint, mapViewportRect } from '../../utils/viewportMapping';
import { defaultFieldSize, fitDesignRect } from './formDesignDraft';

export interface FormDesignSelection { fieldId: string; widgetId: string }
interface Props {
  document: PDFDocumentProxy;
  pageNumber: number;
  fields: FormDesignField[];
  selected: FormDesignSelection | null;
  tool: DesignableFieldType | null;
  disabled: boolean;
  onSelect: (selection: FormDesignSelection | null) => void;
  onCreate: (type: DesignableFieldType, page: number, rect: FormFieldRect) => void;
  onMove: (selection: FormDesignSelection, rect: FormFieldRect) => void;
  onDeleteWidget: (selection: FormDesignSelection) => void;
}
interface Gesture { pointer: number; kind: 'create' | 'move' | 'resize'; start: [number, number]; selection?: FormDesignSelection; rect?: FormFieldRect }

export function FormDesignerPreview({ document: pdfDocument, pageNumber, fields, selected, tool, disabled, onSelect, onCreate, onMove, onDeleteWidget }: Props) {
  useLocale();
  const container = useRef<HTMLDivElement>(null), overlay = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [page, setPage] = useState<{ number: number; document: PDFDocumentProxy; proxy: PDFPageProxy } | null>(null);
  const [availableWidth, setAvailableWidth] = useState(600);
  const [error, setError] = useState<string | null>(null);
  const [ghost, setGhost] = useState<FormFieldRect | null>(null);
  const current = page?.number === pageNumber && page.document === pdfDocument ? page.proxy : null;
  const source = useMemo(() => current?.getViewport({ scale: 1, rotation: 0 }), [current]);
  const viewport = useMemo(() => {
    if (!current) return null;
    const bounds = current.getViewport({ scale: 1 });
    return current.getViewport({ scale: Math.min(1.5, Math.max(.15, (availableWidth - 24) / bounds.width)) });
  }, [current, availableWidth]);
  const widgets = fields.flatMap(field => field.widgets.filter(widget => widget.pageNumber === pageNumber).map(widget => ({ field, widget })));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setAvailableWidth(width); });
    resize.observe(element); return () => resize.disconnect();
  }, []);
  useEffect(() => {
    let canceled = false;
    pdfDocument.getPage(pageNumber).then(proxy => { if (!canceled) { setPage({ number: pageNumber, document: pdfDocument, proxy }); setError(null); } }, cause => { if (!canceled) setError(cause instanceof Error ? cause.message : 'Could not preview this page.'); });
    return () => { canceled = true; gesture.current = null; };
  }, [pdfDocument, pageNumber]);
  useEffect(() => {
    if (!current || !viewport || !canvas.current) return;
    const element = canvas.current, context = element.getContext('2d');
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio);
    let canceled = false;
    const task = current.render({ canvas: element, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: AnnotationMode.DISABLE });
    task.promise.catch(cause => { if (!canceled && cause?.name !== 'RenderingCancelledException') setError(cause instanceof Error ? cause.message : 'Could not render the page.'); });
    return () => { canceled = true; task.cancel(); };
  }, [current, viewport]);

  const point = (event: ReactPointerEvent): [number, number] | null => {
    if (!source || !viewport || !overlay.current) return null;
    const bounds = overlay.current.getBoundingClientRect();
    const mapped = mapViewportPoint(event.clientX - bounds.left, event.clientY - bounds.top, viewport, source);
    return [mapped.x, mapped.y];
  };
  const begin = (event: ReactPointerEvent, kind: Gesture['kind'], selection?: FormDesignSelection, widget?: FormDesignWidget) => {
    if (disabled || event.button !== 0) return;
    const start = point(event); if (!start) return;
    event.preventDefault(); event.stopPropagation();
    if (selection) onSelect(selection);
    // Focusing a tall preview must not scroll it between pointer-down and move.
    overlay.current?.focus({ preventScroll: true }); overlay.current?.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, kind, start, selection, rect: widget?.rect };
    if (kind === 'create') setGhost({ x: start[0], y: start[1], width: 0, height: 0 });
  };
  const move = (event: ReactPointerEvent) => {
    const active = gesture.current, position = point(event);
    if (!active || active.pointer !== event.pointerId || !position || !source || disabled) return;
    const dx = position[0] - active.start[0], dy = position[1] - active.start[1];
    if (active.kind === 'create') setGhost(fitDesignRect({ x: Math.min(active.start[0], position[0]), y: Math.min(active.start[1], position[1]), width: Math.abs(dx), height: Math.abs(dy) }, source.width, source.height));
    else if (active.selection && active.rect) onMove(active.selection, fitDesignRect(active.kind === 'move'
      ? { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy }
      : { ...active.rect, width: Math.max(4, Math.min(source.width - active.rect.x, active.rect.width + dx)), height: Math.max(4, Math.min(source.height - active.rect.y, active.rect.height + dy)) }, source.width, source.height));
  };
  const finish = (event: ReactPointerEvent) => {
    const active = gesture.current, position = point(event);
    gesture.current = null; setGhost(null);
    if (overlay.current?.hasPointerCapture(event.pointerId)) overlay.current.releasePointerCapture(event.pointerId);
    if (!active || !position || !source || disabled) return;
    if (active.kind === 'create' && tool) {
      const width = Math.abs(position[0] - active.start[0]), height = Math.abs(position[1] - active.start[1]);
      const click = width < 4 && height < 4;
      onCreate(tool, pageNumber, fitDesignRect({ x: click ? active.start[0] : Math.min(active.start[0], position[0]), y: click ? active.start[1] : Math.min(active.start[1], position[1]), width: click ? defaultFieldSize[tool][0] : width, height: click ? defaultFieldSize[tool][1] : height }, source.width, source.height));
    }
  };
  const positionStyle = (rect: FormFieldRect) => {
    if (!source || !viewport) return {};
    const mapped = mapViewportRect(rect, source, viewport);
    return { left: mapped.x, top: mapped.y, width: mapped.width, height: mapped.height };
  };

  return <div ref={container} className="form-designer-preview">
    {error && <p role="alert" className="form-designer-error">{translateError(error)}</p>}
    {!viewport && !error && <p role="status">{t("m.loading.page.preview.a26e3d")}</p>}
    {viewport && source && <div className="form-designer-page" style={{ width: viewport.width, height: viewport.height }}>
      <canvas key={`${pageNumber}-${viewport.width}-${viewport.height}`} ref={canvas} style={{ width: viewport.width, height: viewport.height }} aria-label={t("m.page.preview.3cb45f", { v0: pageNumber })} />
      <div ref={overlay} className={`form-designer-overlay ${tool ? 'placing' : ''}`} tabIndex={0} role="region" aria-label={t("m.form.design.page.620178", { v0: pageNumber })}
        onPointerDown={event => { if (tool) begin(event, 'create'); else if (event.target === event.currentTarget) onSelect(null); }}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; setGhost(null); }}
        onKeyDown={event => {
          if (!selected || disabled) return;
          const item = widgets.find(({ field, widget }) => field.id === selected.fieldId && widget.id === selected.widgetId);
          if (!item?.field.supported) return;
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDeleteWidget(selected); }
          const offset = event.shiftKey ? 10 : 1;
          const dx = event.key === 'ArrowRight' ? offset : event.key === 'ArrowLeft' ? -offset : 0;
          const dy = event.key === 'ArrowDown' ? offset : event.key === 'ArrowUp' ? -offset : 0;
          if (dx || dy) {
            event.preventDefault();
            const origin = mapViewportPoint(0, 0, viewport, source);
            const moved = mapViewportPoint(dx * viewport.scale, dy * viewport.scale, viewport, source);
            onMove(selected, fitDesignRect({ ...item.widget.rect, x: item.widget.rect.x + moved.x - origin.x, y: item.widget.rect.y + moved.y - origin.y }, source.width, source.height));
          }
        }}>
        {widgets.map(({ field, widget }) => {
          const chosen = selected?.fieldId === field.id && selected.widgetId === widget.id;
          const { x: cornerX, y: cornerY } = mapViewportPoint(widget.rect.x + widget.rect.width, widget.rect.y + widget.rect.height, source, viewport);
          return <div key={widget.id} className="form-designer-widget-wrapper">
            <button type="button" className={`form-designer-widget ${chosen ? 'selected' : ''} ${widget.hidden ? 'hidden-widget' : ''}`} style={positionStyle(widget.rect)} aria-label={t("m.select.field.widget.965853", { v0: field.name, v1: field.widgets.indexOf(widget) + 1 })}
              onPointerDown={event => { if (tool) return; if (field.supported) begin(event, 'move', { fieldId: field.id, widgetId: widget.id }, widget); else { event.stopPropagation(); onSelect({ fieldId: field.id, widgetId: widget.id }); } }}
              onClick={event => { event.stopPropagation(); if (!tool) onSelect({ fieldId: field.id, widgetId: widget.id }); }}>
              <span>{field.type === 'checkbox' ? '☑' : field.type === 'radio' ? '◉' : field.name}</span>
            </button>
            {chosen && field.supported && !disabled && !tool && <button type="button" className="form-designer-resize" aria-label={t("m.resize.field.9c3a1e", { v0: field.name })} style={{ left: cornerX - 6, top: cornerY - 6 }} onPointerDown={event => begin(event, 'resize', { fieldId: field.id, widgetId: widget.id }, widget)} />}
          </div>;
        })}
        {ghost && <div className="form-designer-ghost" style={positionStyle(ghost)} />}
      </div>
    </div>}
  </div>;
}
