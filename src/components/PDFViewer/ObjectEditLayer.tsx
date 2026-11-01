import { ErrorMessage } from '../Feedback/ErrorMessage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PDFPageProxy } from 'pdfjs-dist';
import { t, useLocale } from '../../i18n';
import { useEditingStore } from '../../store/editingStore';
import { useDocumentStore } from '../../store/documentStore';
import { useUIStore } from '../../store/uiStore';
import { useObjectTransformStore, type ObjectTransformDraft } from '../../store/objectTransformStore';
import { registerPendingEditor } from '../../store/workspaceHistory';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import { detectImages } from '../../editing/ImageDetector';
import { imageAppearance } from '../../editing/imageAppearance';
import { canTransformObject, objectRect, transformObjectEdits, type ObjectTarget } from '../../editing/objectOperations';
import { OBJECT_RESIZE_HANDLES, moveObjectRect, resizeObjectRect, sameObjectRect, objectBounds, snapObjectRect, type ObjectResizeHandle } from '../../editing/objectGeometry';
import type { TextRect } from '../../editing/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportRect } from '../../utils/viewportMapping';
import { hasOpenModal, isTextInput } from '../../utils/keyboard';
import './ObjectEditLayer.css';

interface Props { page: PDFPageProxy; pageNumber: number; scale: number; rotation: number; onTextLayout?: (blockId: string) => void }
interface Gesture {
  pointer: number; element: HTMLElement; start: { x: number; y: number }; rect: TextRect; next: TextRect;
  entries: { target: ObjectTarget; source: TextRect; display: TextRect }[]; handle?: ObjectResizeHandle;
  marquee?: boolean; initialSelection?: string[]; draft?: ObjectTransformDraft;
  owner: ReturnType<typeof useDocumentStore.getState>;
}
function toolbarPosition(rect: TextRect, page: { width: number; height: number }, size: { width: number; height: number }, visible: { left: number; right: number }) {
  const gap = 12, margin = 8;
  const x = Math.max(visible.left + margin, Math.min(rect.x, visible.right - size.width - margin));
  const y = Math.max(margin, Math.min(rect.y, page.height - size.height - margin));
  if (rect.y >= size.height + gap + margin) return { left: x, top: rect.y - gap - size.height };
  if (page.height - rect.y - rect.height >= size.height + gap + margin) return { left: x, top: rect.y + rect.height + gap };
  if (visible.right - rect.x - rect.width >= size.width + gap + margin) return { left: rect.x + rect.width + gap, top: y };
  if (rect.x - visible.left >= size.width + gap + margin) return { left: rect.x - gap - size.width, top: y };
  return null;
}


function validOwner(gesture: Gesture) {
  const state = useDocumentStore.getState();
  return !state.isLoading && state.document === gesture.owner.document && state.documentVersion === gesture.owner.documentVersion
    && state.loadRequestId === gesture.owner.loadRequestId && useEditingStore.getState().mode === 'object';
}
export function ObjectEditLayer({ page, pageNumber, scale, rotation, onTextLayout }: Props) {
  useLocale();
  useObjectTransformStore(state => state.textGeometry);
  const { mode, textBlocks, images, selectedObjectIds, selectedBlockId, selectedImageId, imageEdits, pendingTextEditId } = useEditingStore();
  const root = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), suppressFocus = useRef(false);
  const [localRects, setLocalRects] = useState<Map<string, TextRect>>(() => new Map());
  const [marquee, setMarquee] = useState<TextRect | null>(null);
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; position: number }[]>([]);
  const [toolbarSize, setToolbarSize] = useState({ width: 310, height: 44 });
  const [visible, setVisible] = useState<{ left: number; right: number } | null>(null);
  const [error, setError] = useState<{ page: PDFPageProxy; message: string } | null>(null);
  const blocks = textBlocks.get(pageNumber), pageImages = images.get(pageNumber);
  const source = useMemo(() => page.getViewport({ scale: 1, rotation: 0 }), [page]);
  const viewport = useMemo(() => page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) }), [page, scale, rotation]);
  const targets: ObjectTarget[] = [
    ...(blocks ?? []).filter(block => block.text.trim()).map(item => ({ kind: 'text' as const, item })),
    ...(pageImages ?? []).filter(image => !imageAppearance(image, imageEdits).deleted).map(item => ({ kind: 'image' as const, item })),
  ];
  const ids = selectedObjectIds.length ? selectedObjectIds : [selectedBlockId, selectedImageId].filter((id): id is string => !!id);
  const selected = targets.filter(target => ids.includes(target.item.id));
  const displayRect = (target: ObjectTarget) => localRects.get(target.item.id) ?? mapViewportRect(objectRect(target), source, viewport);
  const selectedRect = selected.length ? objectBounds(selected.map(displayRect)) : null;

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || mode !== 'object') return;
    const viewer = element.closest('.pdf-viewer-container');
    const measure = () => {
      const box = element.getBoundingClientRect(), clip = viewer?.getBoundingClientRect();
      const left = Math.max(0, (clip?.left ?? 0) - box.left);
      const right = Math.min(box.width, Math.min(window.innerWidth, clip ? clip.left + viewer!.clientWidth : window.innerWidth) - box.left);
      setVisible(previous => previous && Math.abs(previous.left - left) < .1 && Math.abs(previous.right - right) < .1 ? previous : { left, right });
    };
    measure(); const observer = new ResizeObserver(measure);
    observer.observe(element); if (viewer) observer.observe(viewer);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [mode, page, scale, rotation]);
  useEffect(() => {
    if (mode !== 'object' || blocks) return;
    let canceled = false;
    void detectTextBlocks(page, 'line').then(found => { if (!canceled) useEditingStore.getState().setTextBlocks(pageNumber, found); })
      .catch(cause => { if (!canceled) setError({ page, message: cause instanceof Error ? cause.message : t('objects.detect.error') }); });
    return () => { canceled = true; };
  }, [mode, blocks, page, pageNumber]);
  useEffect(() => {
    if (mode !== 'object' || pageImages) return;
    let canceled = false;
    void detectImages(page).then(found => { if (!canceled) useEditingStore.getState().setImages(pageNumber, found); })
      .catch(cause => { if (!canceled) setError({ page, message: cause instanceof Error ? cause.message : t('objects.detect.error') }); });
    return () => { canceled = true; };
  }, [mode, pageImages, page, pageNumber]);
  const finish = useCallback((cancel = false) => {
    const active = gesture.current; if (!active) return;
    gesture.current = null;
    if (active.element.hasPointerCapture?.(active.pointer)) active.element.releasePointerCapture(active.pointer);
    if (!cancel && validOwner(active) && active.draft && !sameObjectRect(active.rect, active.next)) {
      useEditingStore.getState().applyObjectEdits(active.draft, active.handle ? 'Resize objects' : 'Move objects');
    }
    if (useObjectTransformStore.getState().draft === active.draft) useObjectTransformStore.getState().setDraft(null);
    setLocalRects(new Map()); setMarquee(null); setGuides([]);
  }, []);
  useEffect(() => registerPendingEditor(() => finish()), [finish]);
  useEffect(() => {
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.isLoading || next.document !== previous.document || next.documentVersion !== previous.documentVersion || next.loadRequestId !== previous.loadRequestId) finish(true);
    });
    return () => { unsubscribe(); finish(true); };
  }, [page, scale, rotation, finish]);
  useEffect(() => useEditingStore.subscribe((next, previous) => {
    if (next.mode !== 'object' || next.textEdits !== previous.textEdits || next.imageEdits !== previous.imageEdits) finish(true);
  }), [finish]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (!gesture.current || event.defaultPrevented || event.key !== 'Escape' || hasOpenModal() || isTextInput(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      if (gesture.current.marquee) useEditingStore.getState().selectObjects(gesture.current.initialSelection ?? []);
      finish(true);
    };
    window.addEventListener('keydown', cancel, true); return () => window.removeEventListener('keydown', cancel, true);
  }, [finish]);
  const focus = (element: HTMLElement) => { suppressFocus.current = true; element.focus({ preventScroll: true }); suppressFocus.current = false; };
  const point = (event: ReactPointerEvent) => {
    const box = root.current!.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const begin = (target: ObjectTarget, event: ReactPointerEvent, handle?: ObjectResizeHandle) => {
    if (event.button !== 0 || event.defaultPrevented || hasOpenModal()) return;
    event.preventDefault(); event.stopPropagation(); finish();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey || useObjectTransformStore.getState().multiSelectEnabled;
    let chosen = selected;
    if (additive && !handle) {
      useEditingStore.getState().selectObjects(ids.includes(target.item.id) ? ids.filter(id => id !== target.item.id) : [...ids, target.item.id], target.item.id);
      focus(event.currentTarget as HTMLElement); return;
    }
    if (!ids.includes(target.item.id)) { useEditingStore.getState().selectObjects([target.item.id]); chosen = [target]; }
    focus(event.currentTarget as HTMLElement);
    if (!chosen.length || !chosen.every(canTransformObject) || useDocumentStore.getState().isLoading) return;
    const entries = chosen.map(item => ({ target: item, source: objectRect(item), display: displayRect(item) }));
    const rect = objectBounds(entries.map(entry => entry.display)), element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, element, entries, handle, start: point(event), rect, next: rect, owner: useDocumentStore.getState() };
  };
  const move = (event: ReactPointerEvent) => {
    const active = gesture.current; if (!active || active.pointer !== event.pointerId) return;
    if (!validOwner(active)) { finish(true); return; }
    event.preventDefault(); event.stopPropagation();
    const current = point(event), dx = current.x - active.start.x, dy = current.y - active.start.y;
    if (active.marquee) {
      const end = { x: Math.max(0, Math.min(current.x, viewport.width)), y: Math.max(0, Math.min(current.y, viewport.height)) };
      const rect = { x: Math.min(end.x, active.start.x), y: Math.min(end.y, active.start.y), width: Math.abs(end.x - active.start.x), height: Math.abs(end.y - active.start.y) };
      setMarquee(rect); active.next = rect;
      if (rect.width < 3 && rect.height < 3) return;
      const found = targets.filter(target => { const box = displayRect(target); return box.x >= rect.x && box.y >= rect.y && box.x + box.width <= rect.x + rect.width && box.y + box.height <= rect.y + rect.height; });
      useEditingStore.getState().selectObjects([...(active.initialSelection ?? []), ...found.map(target => target.item.id)]); return;
    }
    let rect = active.handle ? resizeObjectRect(active.rect, active.handle, dx, dy, viewport, !event.shiftKey) : moveObjectRect(active.rect, dx, dy, viewport);
    if (!active.handle && !event.altKey && useObjectTransformStore.getState().snappingEnabled && Math.abs(dx) + Math.abs(dy) > 2) {
      const others = targets.filter(target => !active.entries.some(entry => entry.target.item.id === target.item.id)).map(displayRect);
      const snapped = snapObjectRect(rect, others, viewport); rect = snapped.rect; setGuides(snapped.guides);
    } else setGuides([]);
    active.next = rect;
    const moved = active.entries.map(entry => active.handle ? rect : { ...entry.display, x: entry.display.x + rect.x - active.rect.x, y: entry.display.y + rect.y - active.rect.y });
    const rects = moved.map((box, index) => {
      const mapped = mapViewportRect(box, viewport, source);
      return active.handle ? mapped : { ...active.entries[index].source, x: mapped.x, y: mapped.y };
    });
    active.draft = { pageNumber, ...transformObjectEdits(active.entries.map(entry => entry.target), rects, !!active.handle) };
    setLocalRects(new Map(active.entries.map((entry, index) => [entry.target.item.id, moved[index]])));
    useObjectTransformStore.getState().setDraft(active.draft);
  };
  const remove = () => {
    finish(true);
    useEditingStore.getState().applyObjectEdits({
      textEdits: selected.filter((item): item is ObjectTarget & { kind: 'text' } => item.kind === 'text' && item.item.editable).map(item => ({ blockId: item.item.id, originalText: item.item.text, newText: '', timestamp: Date.now() })),
      imageEdits: selected.filter(item => item.kind === 'image' && item.item.source && !item.item.unsupportedReason).map(item => ({ imageId: item.item.id, type: 'delete', timestamp: Date.now() })),
    }, 'Delete objects');
    useEditingStore.getState().selectObjects([]); root.current?.focus({ preventScroll: true });
  };
  const editText = (target: ObjectTarget) => { if (target.kind === 'text' && target.item.editable) { finish(); useEditingStore.getState().requestTextEdit(target.item.id); } };
  const properties = () => { finish(); useUIStore.getState().setInspectorOpen(true); };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || hasOpenModal() || isTextInput(event.target) || (event.target as Element).closest('.object-edit-actions')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); useEditingStore.getState().selectObjects(targets.filter(canTransformObject).map(target => target.item.id)); return; }
    if (!selected.length) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); useEditingStore.getState().selectObjects([]); root.current?.focus(); return; }
    if (event.key === 'Enter' && selected.length === 1 && selected[0].kind === 'text') { event.preventDefault(); event.stopPropagation(); editText(selected[0]); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || !selected.every(canTransformObject)) return;
    const amount = (event.shiftKey ? 10 : 1) * scale;
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    const box = selectedRect!, moved = moveObjectRect(box, dx, dy, viewport);
    if (sameObjectRect(box, moved)) return;
    const rects = selected.map(target => { const old = displayRect(target), mapped = mapViewportRect({ ...old, x: old.x + moved.x - box.x, y: old.y + moved.y - box.y }, viewport, source); return { ...objectRect(target), x: mapped.x, y: mapped.y }; });
    useEditingStore.getState().applyObjectEdits(transformObjectEdits(selected, rects), 'Move objects');
  };
  const visibleArea = visible ?? { left: 0, right: viewport.width };
  const placement = selectedRect ? toolbarPosition(selectedRect, viewport, toolbarSize, visibleArea) : null;
  const toolbarHost = selected.length && !placement ? window.document.getElementById('pdf-text-edit-controls') : null;
  useLayoutEffect(() => {
    // The compact ribbon and floating toolbar have different dimensions.
    // Measuring the ribbon as the floating toolbar can alternate placements
    // forever when an almost full-page object leaves only a narrow top margin.
    if (!actions.current || !selected.length || mode !== 'object' || toolbarHost) return;
    const measure = () => {
      const size = actions.current?.getBoundingClientRect();
      if (size) setToolbarSize(previous => Math.abs(previous.width - size.width) < .1 && Math.abs(previous.height - size.height) < .1 ? previous : { width: size.width, height: size.height });
    };
    // Wrapped/localized actions can be taller than the initial estimate. Place
    // them before paint so the second click of a double-click cannot hit Delete.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(actions.current); return () => observer.disconnect();
  }, [selected.length, selectedObjectIds, selectedBlockId, selectedImageId, toolbarHost, mode, pendingTextEditId]);
  if (mode !== 'object' || pendingTextEditId) return null;
  const one = selected.length === 1 ? selected[0] : undefined;
  const unsupported = one?.item.unsupportedReason ?? (one?.kind === 'image' && one.item.source?.insideForm ? t('objects.unsupported.move') : undefined);
  const editActions = selected.length > 0 && <div ref={actions} className={`object-edit-actions ${toolbarHost ? 'in-toolbar' : ''}`} style={toolbarHost ? undefined : { ...(placement ?? { left: 8, top: -toolbarSize.height - 12 }), maxWidth: Math.max(0, visibleArea.right - visibleArea.left - 16) }} onPointerDown={event => event.stopPropagation()}>
    {one?.kind === 'text' && <><button type="button" disabled={!one.item.editable} onClick={() => editText(one)}>{t('objects.edit.text')}</button>{onTextLayout && <button type="button" disabled={!one.item.editable} onClick={() => { finish(); onTextLayout(one.item.id); }}>{t('objects.layout')}</button>}</>}
    {one?.kind === 'image' && <button type="button" onClick={() => { finish(); useEditingStore.getState().setMode('image'); useEditingStore.getState().selectImage(one.item.id); }}>{t('objects.image.options')}</button>}
    <button type="button" onClick={properties}>{t(selected.length > 1 ? 'objects.arrange' : one?.kind === 'image' ? 'image.appearance' : 'text.format')}</button>
    <button type="button" onClick={remove}>{t('objects.delete')}</button>
  </div>;
  return <div ref={root} className="object-edit-layer" tabIndex={-1} onKeyDown={keyDown} onPointerDown={event => {
    if (event.target !== event.currentTarget || event.button !== 0 || hasOpenModal()) return;
    event.preventDefault(); event.stopPropagation(); finish();
    const initialSelection = event.shiftKey || event.ctrlKey || event.metaKey ? ids : [];
    useEditingStore.getState().selectObjects(initialSelection); focus(event.currentTarget);
    const start = point(event), rect = { ...start, width: 0, height: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, element: event.currentTarget, entries: [], start, rect, next: rect, marquee: true, initialSelection, owner: useDocumentStore.getState() };
  }} onPointerMove={move} onPointerUp={event => { if (gesture.current?.pointer === event.pointerId) { move(event); finish(); } }} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
    {(!blocks || !pageImages) && error?.page !== page && <div className="object-edit-loading" role="status">{t('objects.loading')}</div>}
    {error?.page === page && <div className="object-edit-notice" role="alert"><ErrorMessage error={error.message} /></div>}
    {[...targets].sort((a, b) => { const first = objectRect(a), second = objectRect(b); return second.width * second.height - first.width * first.height; }).map(target => {
      const rect = displayRect(target), isSelected = ids.includes(target.item.id);
      return <div key={target.item.id} data-object-id={target.item.id} data-object-kind={target.kind} role="button" tabIndex={0}
        aria-label={t(`objects.select.${target.kind}`, { index: targets.indexOf(target) + 1 })} aria-pressed={isSelected} aria-disabled={!canTransformObject(target) || undefined}
        className={`object-edit-box ${target.kind} ${isSelected ? 'selected' : ''} ${canTransformObject(target) ? '' : 'readonly'}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        onFocus={() => { if (!suppressFocus.current && !ids.includes(target.item.id)) useEditingStore.getState().selectObjects([target.item.id]); }}
        onPointerDown={event => begin(target, event)} onClick={event => event.stopPropagation()}
        onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); editText(target); }}>
        {target.kind === 'image' && isSelected && selected.length === 1 && canTransformObject(target) && OBJECT_RESIZE_HANDLES.map(handle => <button key={handle} type="button" tabIndex={-1} data-resize-handle={handle} className={`object-resize-handle ${handle}`} aria-label={t(`objects.resize.${handle}`)} onPointerDown={event => begin(target, event, handle)} onClick={event => event.stopPropagation()} />)}
      </div>;
    })}
    {selected.length > 1 && selectedRect && <div className="object-group-bounds" style={{ left: selectedRect.x, top: selectedRect.y, width: selectedRect.width, height: selectedRect.height }} />}
    {marquee && <div className="object-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
    {guides.map(guide => <div key={guide.axis} className={`object-snap-guide ${guide.axis}`} style={guide.axis === 'x' ? { left: guide.position } : { top: guide.position }} />)}
    {toolbarHost ? createPortal(editActions, toolbarHost) : editActions}
    {unsupported && <div className="object-edit-notice" role="status"><ErrorMessage error={unsupported} /></div>}
  </div>;
}
