import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PDFPageProxy } from 'pdfjs-dist';
import { t, translateError, useLocale } from '../../i18n';
import { useEditingStore } from '../../store/editingStore';
import { useDocumentStore } from '../../store/documentStore';
import { useObjectTransformStore } from '../../store/objectTransformStore';
import { registerPendingEditor } from '../../store/workspaceHistory';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import { detectImages } from '../../editing/ImageDetector';
import { OBJECT_RESIZE_HANDLES, moveObjectRect, resizeObjectRect, sameObjectRect, type ObjectResizeHandle } from '../../editing/objectGeometry';
import type { ImageEditOperation, PDFImage, TextBlock, TextEditOperation, TextRect } from '../../editing/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportRect } from '../../utils/viewportMapping';
import { hasOpenModal, isTextInput } from '../../utils/keyboard';
import './ObjectEditLayer.css';

interface Props { page: PDFPageProxy; pageNumber: number; scale: number; rotation: number; onTextLayout?: (blockId: string) => void }
type ObjectTarget = { kind: 'text'; item: TextBlock } | { kind: 'image'; item: PDFImage };
interface Draft { pageNumber: number; textEdit?: TextEditOperation; imageEdit?: ImageEditOperation }
interface Gesture {
  pointer: number; element: HTMLElement; target: ObjectTarget; handle?: ObjectResizeHandle;
  start: { x: number; y: number }; rect: TextRect; next: TextRect; initialSource: TextRect; draft?: Draft;
  owner: ReturnType<typeof useDocumentStore.getState>;
}

function existingImageRect(image: PDFImage, edits: ImageEditOperation[]) {
  return edits.filter(edit => edit.imageId === image.id).reduce((rect, edit) => edit.newRect ?? rect, image.rect);
}
function deletedImage(image: PDFImage, edits: ImageEditOperation[]) {
  return edits.filter(edit => edit.imageId === image.id).reduce((deleted, edit) => edit.type === 'delete' ? true : edit.type === 'replace' ? false : deleted, false);
}
function textTransform(block: TextBlock, rect: TextRect): TextEditOperation {
  const previous = useEditingStore.getState().textEdits.find(edit => edit.blockId === block.id);
  const layout = previous?.layout;
  return { blockId: block.id, originalText: previous?.originalText ?? block.text, newText: block.text, timestamp: Date.now(),
    layout: { ...layout, targetRect: rect, ...(layout && !layout.keepBaseline ? {} : { keepBaseline: true, translate: true, autoGrow: false }) } };
}
function imageTransform(image: PDFImage, type: 'move' | 'resize' | 'delete', newRect?: TextRect): ImageEditOperation {
  return { imageId: image.id, type, newRect, timestamp: Date.now() };
}
function canTransform(target: ObjectTarget) {
  return target.kind === 'text' ? target.item.editable : !!target.item.source && !target.item.unsupportedReason && !target.item.source.insideForm;
}
function validOwner(gesture: Gesture) {
  const state = useDocumentStore.getState();
  return !state.isLoading && state.document === gesture.owner.document && state.documentVersion === gesture.owner.documentVersion
    && state.loadRequestId === gesture.owner.loadRequestId && useEditingStore.getState().mode === 'object';
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

/** A single selection layer for existing PDF content; edits keep their native PDF representation. */
export function ObjectEditLayer({ page, pageNumber, scale, rotation, onTextLayout }: Props) {
  useLocale();
  const { mode, textBlocks, images, selectedBlockId, selectedImageId, textEdits, imageEdits } = useEditingStore();
  const root = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null);
  const [localDraft, setLocalDraft] = useState<{ id: string; rect: TextRect } | null>(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 310, height: 44 });
  const [visible, setVisible] = useState<{ left: number; right: number } | null>(null);
  const [error, setError] = useState<{ page: PDFPageProxy; message: string } | null>(null);
  const blocks = textBlocks.get(pageNumber), pageImages = images.get(pageNumber);
  const source = useMemo(() => page.getViewport({ scale: 1, rotation: 0 }), [page]);
  const viewport = useMemo(() => page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) }), [page, scale, rotation]);
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
    const observer = new ResizeObserver(measure);
    observer.observe(element); if (viewer) observer.observe(viewer);
    window.addEventListener('resize', measure); window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [mode, page, scale, rotation]);
  const targets: ObjectTarget[] = [
    ...(blocks ?? []).filter(block => block.text.trim()).map(item => ({ kind: 'text' as const, item })),
    ...(pageImages ?? []).filter(image => !deletedImage(image, imageEdits)).map(item => ({ kind: 'image' as const, item })),
  ];
  const selected = targets.find(target => target.item.id === (target.kind === 'text' ? selectedBlockId : selectedImageId));
  const sourceRect = (target: ObjectTarget) => target.kind === 'text'
    ? textEdits.find(edit => edit.blockId === target.item.id)?.layout?.targetRect ?? target.item.rect
    : existingImageRect(target.item, imageEdits);
  const displayRect = (target: ObjectTarget) => localDraft?.id === target.item.id ? localDraft.rect : mapViewportRect(sourceRect(target), source, viewport);

  useEffect(() => {
    if (mode !== 'object') return;
    let canceled = false;
    const jobs: Promise<unknown>[] = [];
    if (!blocks) jobs.push(detectTextBlocks(page).then(found => { if (!canceled) useEditingStore.getState().setTextBlocks(pageNumber, found); }));
    if (!pageImages) jobs.push(detectImages(page).then(found => { if (!canceled) useEditingStore.getState().setImages(pageNumber, found); }));
    void Promise.all(jobs).catch(cause => { if (!canceled) setError({ page, message: cause instanceof Error ? cause.message : 'Could not detect page objects.' }); });
    return () => { canceled = true; };
  }, [mode, blocks, pageImages, page, pageNumber]);

  const finish = useCallback((cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (active.element.hasPointerCapture?.(active.pointer)) active.element.releasePointerCapture(active.pointer);
    if (!cancel && validOwner(active) && active.draft && !sameObjectRect(active.rect, active.next)) {
      const state = useEditingStore.getState();
      if (active.draft.textEdit && state.getBlock(active.target.item.id)?.editable) state.updateBlockLayout(active.draft.textEdit);
      if (active.draft.imageEdit && state.images.get(active.target.item.pageNumber)?.some(image => image.id === active.target.item.id)) state.addImageEdit(active.draft.imageEdit);
    }
    if (useObjectTransformStore.getState().draft === active.draft) useObjectTransformStore.getState().setDraft(null);
    setLocalDraft(null);
  }, []);
  useEffect(() => registerPendingEditor(() => finish()), [finish]);
  useEffect(() => {
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.isLoading || next.document !== previous.document || next.documentVersion !== previous.documentVersion || next.loadRequestId !== previous.loadRequestId) finish(true);
    });
    return () => { unsubscribe(); finish(true); };
  }, [page, scale, rotation, finish]);
  useEffect(() => {
    const unsubscribe = useEditingStore.subscribe((next, previous) => {
      if (next.mode !== 'object' || next.textEdits !== previous.textEdits || next.imageEdits !== previous.imageEdits) finish(true);
    });
    return unsubscribe;
  }, [finish]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (!gesture.current || event.defaultPrevented || event.key !== 'Escape' || hasOpenModal() || isTextInput(event.target)) return;
      event.preventDefault(); event.stopPropagation(); finish(true);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [finish]);

  const select = (target: ObjectTarget) => {
    if (target.kind === 'text') useEditingStore.getState().selectBlock(target.item.id);
    else useEditingStore.getState().selectImage(target.item.id);
  };
  const point = (event: ReactPointerEvent) => {
    const box = root.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const begin = (target: ObjectTarget, event: ReactPointerEvent, handle?: ObjectResizeHandle) => {
    if (event.button !== 0 || event.defaultPrevented || hasOpenModal()) return;
    event.preventDefault(); event.stopPropagation(); finish(); select(target);
    const element = event.currentTarget as HTMLElement;
    element.focus({ preventScroll: true });
    if (!canTransform(target) || useDocumentStore.getState().isLoading) return;
    element.setPointerCapture(event.pointerId);
    const rect = displayRect(target);
    gesture.current = { pointer: event.pointerId, element, target, handle, start: point(event), rect, next: rect, initialSource: sourceRect(target), owner: useDocumentStore.getState() };
  };
  const move = (event: ReactPointerEvent) => {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (!validOwner(active)) { finish(true); return; }
    event.preventDefault(); event.stopPropagation();
    const current = point(event), dx = current.x - active.start.x, dy = current.y - active.start.y;
    const rect = active.handle ? resizeObjectRect(active.rect, active.handle, dx, dy, viewport, !event.shiftKey)
      : moveObjectRect(active.rect, dx, dy, viewport);
    active.next = rect;
    const mapped = mapViewportRect(rect, viewport, source);
    // Keep exact original dimensions on a pure move, avoiding float noise and reflow.
    const next = active.handle ? mapped : { ...active.initialSource, x: mapped.x, y: mapped.y };
    active.draft = active.target.kind === 'text' ? { pageNumber, textEdit: textTransform(active.target.item, next) }
      : { pageNumber, imageEdit: imageTransform(active.target.item, active.handle ? 'resize' : 'move', next) };
    setLocalDraft({ id: active.target.item.id, rect });
    useObjectTransformStore.getState().setDraft(active.draft);
  };
  const remove = (target: ObjectTarget) => {
    finish(true);
    if (target.kind === 'text') {
      if (!target.item.editable) return;
      useEditingStore.getState().updateBlockText(target.item.id, '');
      useEditingStore.getState().selectBlock(null);
    } else if (target.item.source && !target.item.unsupportedReason) {
      useEditingStore.getState().addImageEdit(imageTransform(target.item, 'delete'));
      useEditingStore.getState().selectImage(null);
    }
    root.current?.focus({ preventScroll: true });
  };
  const editText = (block: TextBlock) => {
    finish();
    useEditingStore.getState().requestTextEdit(block.id);
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || hasOpenModal() || isTextInput(event.target) || (event.target as Element).closest('.object-edit-actions')) return;
    if (!selected) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(selected); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); useEditingStore.getState().selectBlock(null); root.current?.focus(); return; }
    if (event.key === 'Enter' && selected.kind === 'text' && selected.item.editable) { event.preventDefault(); event.stopPropagation(); editText(selected.item); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || !canTransform(selected)) return;
    const amount = (event.shiftKey ? 10 : 1) * scale;
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0, dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    const current = displayRect(selected), moved = moveObjectRect(current, dx, dy, viewport);
    if (sameObjectRect(current, moved)) return;
    const mapped = mapViewportRect(moved, viewport, source), original = sourceRect(selected), next = { ...original, x: mapped.x, y: mapped.y };
    if (selected.kind === 'text') useEditingStore.getState().updateBlockLayout(textTransform(selected.item, next));
    else useEditingStore.getState().addImageEdit(imageTransform(selected.item, 'move', next));
  };

  const selectedRect = selected ? displayRect(selected) : null;
  const visibleArea = visible ?? { left: 0, right: viewport.width };
  const placement = selectedRect ? toolbarPosition(selectedRect, viewport, toolbarSize, visibleArea) : null;
  const toolbarHost = mode === 'object' && selected && !placement ? window.document.getElementById('pdf-text-edit-controls') : null;
  useLayoutEffect(() => {
    if (!actions.current || toolbarHost) return;
    const observer = new ResizeObserver(entries => {
      const size = entries[0]?.borderBoxSize[0];
      if (size) setToolbarSize(previous => Math.abs(previous.width - size.inlineSize) < .1 && Math.abs(previous.height - size.blockSize) < .1
        ? previous : { width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(actions.current);
    return () => observer.disconnect();
  }, [selected?.item.id, toolbarHost, mode]);
  if (mode !== 'object') return null;
  const unsupported = selected?.kind === 'text' ? selected.item.unsupportedReason : selected?.item.unsupportedReason
    ?? (selected?.item.source?.insideForm ? t('objects.unsupported.move') : undefined);
  const editActions = selected && <div ref={actions} className={`object-edit-actions ${toolbarHost ? 'in-toolbar' : ''}`}
    style={toolbarHost ? undefined : { ...(placement ?? { left: 8, top: -toolbarSize.height - 12 }), maxWidth: Math.max(0, visibleArea.right - visibleArea.left - 16) }} onPointerDown={event => event.stopPropagation()}>
    {selected.kind === 'text' ? <>
      <button type="button" disabled={!selected.item.editable} onClick={() => editText(selected.item)}>{t('objects.edit.text')}</button>
      {onTextLayout && <button type="button" disabled={!selected.item.editable} onClick={() => { finish(); onTextLayout(selected.item.id); }}>{t('objects.layout')}</button>}
    </> : <button type="button" onClick={() => { finish(); useEditingStore.getState().setMode('image'); useEditingStore.getState().selectImage(selected.item.id); }}>{t('objects.image.options')}</button>}
    <button type="button" disabled={selected.kind === 'text' ? !selected.item.editable : !selected.item.source || !!selected.item.unsupportedReason} onClick={() => remove(selected)}>{t('objects.delete')}</button>
  </div>;
  return <div ref={root} className="object-edit-layer" tabIndex={-1} onKeyDown={keyDown} onPointerDown={event => {
    if (event.target !== event.currentTarget || hasOpenModal()) return;
    event.preventDefault(); event.stopPropagation(); finish(); useEditingStore.getState().selectBlock(null); root.current?.focus();
  }} onPointerMove={move} onPointerUp={event => { if (gesture.current?.pointer === event.pointerId) { move(event); finish(); } }}
    onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}>
    {(!blocks || !pageImages) && error?.page !== page && <div className="object-edit-loading" role="status">{t('objects.loading')}</div>}
    {error?.page === page && <div className="object-edit-notice" role="alert">{translateError(error.message)}</div>}
    {[...targets].sort((a, b) => {
      const first = sourceRect(a), second = sourceRect(b);
      return second.width * second.height - first.width * first.height;
    }).map(target => {
      const rect = displayRect(target), isSelected = selected?.item.id === target.item.id;
      return <div key={target.item.id} data-object-id={target.item.id} data-object-kind={target.kind}
        role="button" tabIndex={0} aria-label={t(`objects.select.${target.kind}`, { index: targets.indexOf(target) + 1 })} aria-pressed={isSelected}
        aria-disabled={!canTransform(target) || undefined}
        className={`object-edit-box ${target.kind} ${isSelected ? 'selected' : ''} ${canTransform(target) ? '' : 'readonly'}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        onFocus={() => select(target)} onPointerDown={event => begin(target, event)} onClick={event => { event.stopPropagation(); select(target); }}
        onDoubleClick={event => { if (target.kind === 'text' && target.item.editable) { event.preventDefault(); event.stopPropagation(); editText(target.item); } }}>
        {target.kind === 'image' && isSelected && canTransform(target) && OBJECT_RESIZE_HANDLES.map(handle => <button key={handle} type="button" tabIndex={-1}
          data-resize-handle={handle} className={`object-resize-handle ${handle}`} aria-label={t(`objects.resize.${handle}`)}
          onPointerDown={event => begin(target, event, handle)} onClick={event => event.stopPropagation()} />)}
      </div>;
    })}
    {toolbarHost ? createPortal(editActions, toolbarHost) : editActions}
    {unsupported && <div className="object-edit-notice" role="status">{translateError(unsupported)}</div>}
  </div>;
}
