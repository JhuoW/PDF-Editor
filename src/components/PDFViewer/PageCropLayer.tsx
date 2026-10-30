import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PDFPageProxy } from 'pdfjs-dist';
import { t, translateError, useLocale } from '../../i18n';
import { usePageCropStore, type PageCropRect } from '../../store/pageCropStore';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { OBJECT_RESIZE_HANDLES, moveObjectRect, resizeObjectRect, type ObjectResizeHandle } from '../../editing/objectGeometry';
import { hasOpenModal, isTextInput } from '../../utils/keyboard';
import { capturePageCrop, displayPageCrop, pageCropMargins } from './pageCropGeometry';
import './PageCropLayer.css';

interface Gesture { pointer: number; start: { x: number; y: number }; rect: PageCropRect; previous: PageCropRect | null; kind: 'draw' | 'move' | ObjectResizeHandle }
export function PageCropLayer({ page, pageNumber, scale, rotation }: { page: PDFPageProxy; pageNumber: number; scale: number; rotation: number }) {
  useLocale();
  const crop = usePageCropStore(), layer = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null);
  const active = crop.session?.pageNumber === pageNumber;
  const native = page.getViewport({ scale: 1, rotation: page.rotate || 0 }), display = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });
  const rect = crop.rect ? displayPageCrop(crop.rect, native, display) : null;
  const margins = crop.rect ? pageCropMargins(crop.rect, native) : undefined;
  const valid = !!crop.rect && crop.rect.width * native.width >= 1 && crop.rect.height * native.height >= 1;
  const confirm = () => { if (valid && margins) void usePageCropStore.getState().apply(margins); };
  const handlers = useRef({ confirm, native, display });
  useLayoutEffect(() => { handlers.current = { confirm, native, display }; });
  useEffect(() => {
    if (!active) return;
    layer.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (hasOpenModal()) return;
      const state = usePageCropStore.getState();
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); state.cancel(); return; }
      if (isTextInput(event.target)) return;
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault(); event.stopImmediatePropagation(); handlers.current.confirm(); return;
      }
      if (event.target instanceof HTMLButtonElement && ['Enter', ' '].includes(event.key)) return;
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (direction) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (state.rect && !state.busy) {
          const { native: original, display: shown } = handlers.current, step = event.shiftKey ? 10 : 1;
          const box = displayPageCrop(state.rect, original, shown);
          state.setRect(capturePageCrop(moveObjectRect(box, direction[0] * step, direction[1] * step, shown), shown, original));
        }
      } else if (['Delete', 'Backspace'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation(); state.setRect(null);
      } else if ((event.ctrlKey || event.metaKey) ? ['s', 'z', 'y', 'a', 'x', 'c', 'v'].includes(event.key.toLowerCase()) : event.key.length === 1) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); gesture.current = null; };
  }, [active]);
  useEffect(() => { gesture.current = null; }, [scale, rotation]);
  if (!active) return null;
  const point = (event: ReactPointerEvent) => {
    const bounds = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(display.width, (event.clientX - bounds.left) * display.width / bounds.width)),
      y: Math.max(0, Math.min(display.height, (event.clientY - bounds.top) * display.height / bounds.height)) };
  };
  const begin = (event: ReactPointerEvent) => {
    if (event.button !== 0 || crop.busy) return;
    event.preventDefault(); event.stopPropagation(); layer.current?.focus({ preventScroll: true });
    const target = event.target as HTMLElement, handle = target.closest<HTMLElement>('[data-page-crop-handle]')?.dataset.pageCropHandle as ObjectResizeHandle | undefined;
    const start = point(event), kind = handle ?? (target.closest('.page-crop-selection') && rect ? 'move' : 'draw');
    gesture.current = { pointer: event.pointerId, start, rect: rect ?? { ...start, width: 0, height: 0 }, previous: crop.rect, kind };
    layer.current?.setPointerCapture?.(event.pointerId);
    if (kind === 'draw') crop.setRect(null);
  };
  const move = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const end = point(event), dx = end.x - current.start.x, dy = end.y - current.start.y;
    const next = current.kind === 'draw'
      ? { x: Math.min(current.start.x, end.x), y: Math.min(current.start.y, end.y), width: Math.abs(dx), height: Math.abs(dy) }
      : current.kind === 'move' ? moveObjectRect(current.rect, dx, dy, display)
      : resizeObjectRect(current.rect, current.kind, dx, dy, display, false, 4);
    crop.setRect(capturePageCrop(next, display, native));
  };
  const finish = (event: ReactPointerEvent, cancel = false) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!cancel) move(event);
    const selection = usePageCropStore.getState().rect;
    if (cancel || !selection || displayPageCrop(selection, native, display).width < 4 || displayPageCrop(selection, native, display).height < 4) crop.setRect(current.previous);
    gesture.current = null;
    if (layer.current?.hasPointerCapture?.(event.pointerId)) layer.current.releasePointerCapture(event.pointerId);
  };
  return <>
    <div className="page-crop-layer" ref={layer} tabIndex={0} role="region" aria-label={t('page.crop.visual')}
      onPointerDown={begin} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); confirm(); }}>
      {!rect && <div className="page-crop-draw-hint">{t('page.crop.draw')}</div>}
      {rect && <div className="page-crop-selection" aria-label={t('page.crop.selection')} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
        {OBJECT_RESIZE_HANDLES.map(handle => <button key={handle} type="button" tabIndex={-1} className={`page-crop-handle ${handle}`} data-page-crop-handle={handle} aria-label={t(`page.crop.resize.${handle}`)} />)}
      </div>}
    </div>
    {createPortal(<div className="page-crop-controls" role="region" aria-label={t('page.crop.controls')}>
      <div className="page-crop-feedback" role={crop.error ? 'alert' : 'status'}>{crop.error ? translateError(crop.error) : crop.busy ? t('page.crop.applying') : rect ? t('page.crop.adjust') : t('page.crop.draw')}
        {crop.rect && <span>{t('page.crop.size', { width: (crop.rect.width * native.width).toFixed(1), height: (crop.rect.height * native.height).toFixed(1) })}</span>}
      </div>
      <div className="page-crop-buttons">
        <button type="button" disabled={crop.busy || !rect} onClick={() => crop.setRect(null)}>{t('page.crop.redraw')}</button>
        {crop.session?.onOptions && <button type="button" data-crop-action="options" disabled={crop.busy} onClick={() => crop.options(margins)}>{t('page.crop.options')}</button>}
        <button type="button" disabled={crop.committing} onClick={crop.cancel}>{t('page.crop.cancel')}</button>
        <button type="button" className="page-crop-confirm" disabled={crop.busy || !valid} onClick={confirm}>{crop.busy ? t('page.crop.applying') : t('page.crop.confirm')}</button>
      </div>
    </div>, window.document.body)}
  </>;
}
