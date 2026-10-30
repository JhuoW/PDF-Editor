import { useLocale, t, translateError } from "../../i18n";
/** Direct PDF text editing: the PDF paints the letters, an input handles typing. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useEditingStore } from '../../store/editingStore';
import { useHistoryStore } from '../../store/historyStore';
import { cancelWorkspaceGroup, registerPendingEditor } from '../../store/workspaceHistory';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import { originalParagraphText } from '../../editing/ParagraphText';
import type { TextBlock, TextLayoutOptions, TextRect } from '../../editing/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportPoint, mapViewportRect } from '../../utils/viewportMapping';
import { inlineCaret, inlineOffsetAt, inlineSelection, inlineTextRows, sourceInlineGeometry } from '../../editing/InlineTextGeometry';
import { useInlineTextPreview } from './useInlineTextPreview';
import { InlinePDFPreview } from './InlinePDFPreview';
import './TextEditLayer.css';

interface TextEditLayerProps {
  page: PDFPageProxy; pageNumber: number; scale: number; rotation: number;
  onTextLayout?: (blockId: string) => void;
}
const EMPTY: TextBlock[] = [];
function sourceGeometry(block: TextBlock, text: string, layout?: TextLayoutOptions) {
  const geometry = sourceInlineGeometry({ ...block, text });
  if (layout?.translate && layout.targetRect) {
    const dx = layout.targetRect.x - block.rect.x, dy = layout.targetRect.y - block.rect.y;
    geometry.input.rect = layout.targetRect;
    for (const line of geometry.layout.lines) {
      line.x += dx; line.baseline += dy;
      for (const glyph of line.glyphs) { glyph.x += dx; glyph.baseline += dy; }
    }
  }
  return geometry;
}
export function TextEditLayer({ page, pageNumber, scale, rotation, onTextLayout }: TextEditLayerProps) {
  useLocale();
  const { mode, setMode, setTextBlocks, textBlocks, selectedBlockId, selectBlock, updateBlockText, textEdits, pendingTextEditId, clearTextEditRequest } = useEditingStore();
  const [analysisError, setAnalysisError] = useState<{ page: PDFPageProxy; message: string } | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null), [editText, setEditText] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const input = useRef<HTMLTextAreaElement>(null), layer = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const group = useRef<string | null>(null), pointer = useRef<{ id: number; anchor: number } | null>(null);
  const focusedBlock = useRef<string | null>(null);
  const preferredColumn = useRef<number | null>(null);
  const pendingPoint = useRef<{ x: number; y: number; detail: number } | null>(null);
  const pageBlocks = textBlocks.get(pageNumber) ?? EMPTY, hasBlocks = textBlocks.has(pageNumber);
  const pageEdits = useMemo(() => textEdits.filter(edit => pageBlocks.some(block => block.id === edit.blockId)), [textEdits, pageBlocks]);
  const layouts = useMemo(() => new Map(pageEdits.map(edit => [edit.blockId, edit.layout])), [pageEdits]);
  const activeId = mode === 'text' ? editingBlockId : null;
  const preview = useInlineTextPreview(page, pageNumber, pageBlocks, pageEdits, activeId, scale, rotation);
  const activeBlock = pageBlocks.find(block => block.id === activeId);
  const fallback = useMemo(() => activeBlock ? sourceGeometry(activeBlock, editText, layouts.get(activeBlock.id)) : undefined, [activeBlock, editText, layouts]);
  const measured = preview?.activeId === activeId ? preview.prepared : undefined;
  const prepared = useMemo(() => measured && measured.input.text !== editText && originalParagraphText(measured.input.text) === editText
    ? { ...measured, input: { ...measured.input, text: editText } } : measured ?? fallback, [measured, editText, fallback]);
  const source = page.getViewport({ scale: 1, rotation: 0 });
  const viewport = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });
  const rectStyle = (rect: TextRect) => {
    const mapped = mapViewportRect(rect, source, viewport);
    return { left: mapped.x, top: mapped.y, width: mapped.width, height: mapped.height };
  };
  const blockStyle = (block: TextBlock) => rectStyle(layouts.get(block.id)?.targetRect ?? block.rect);

  useEffect(() => {
    if (mode !== 'text' || hasBlocks) return;
    let canceled = false;
    void detectTextBlocks(page).then(blocks => {
      if (!canceled) { setAnalysisError(null); setTextBlocks(pageNumber, blocks); }
    }).catch(cause => {
      if (!canceled) setAnalysisError({ page, message: cause instanceof Error ? cause.message : 'Could not analyze text.' });
    });
    return () => { canceled = true; };
  }, [mode, hasBlocks, page, pageNumber, setTextBlocks]);

  const finish = useCallback((keepSelection = false) => {
    if (!focusedBlock.current) return;
    const finishedBlock = focusedBlock.current;
    focusedBlock.current = null;
    group.current = null; pointer.current = null; pendingPoint.current = null; preferredColumn.current = null;
    useHistoryStore.getState().endGroup(); setEditingBlockId(null);
    if (!keepSelection && useEditingStore.getState().selectedBlockId === finishedBlock) selectBlock(null);
  }, [selectBlock]);
  useEffect(() => registerPendingEditor(() => finish()), [finish]);
  const setRange = useCallback((start: number, end = start) => {
    input.current?.setSelectionRange(Math.min(start, end), Math.max(start, end), end < start ? 'backward' : 'forward');
    setSelection({ start: Math.min(start, end), end: Math.max(start, end) });
  }, []);
  useEffect(() => {
    if (activeId) { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(0, 0); }
  }, [activeId, setRange]);
  useEffect(() => {
    const point = pendingPoint.current;
    if (!point || !prepared || prepared.input.text !== editText) return;
    if (preview?.activeId === activeId && preview.prepared) pendingPoint.current = null;
    let start = inlineOffsetAt(prepared, point.x, point.y), end = start;
    if (point.detail >= 2) {
      while (start > 0 && /[\p{L}\p{N}_]/u.test(editText[start - 1])) start--;
      while (end < editText.length && /[\p{L}\p{N}_]/u.test(editText[end])) end++;
    }
    input.current?.setSelectionRange(start, end);
  }, [prepared, editText, preview, activeId]);
  useEffect(() => {
    const previous = activeId ? layouts.get(activeId) : undefined;
    if (activeId && group.current && (!previous?.translate || previous.autoGrow) && pageEdits.some(edit => edit.blockId === activeId) && preview?.activeId === activeId && preview.availableRect && (!previous || previous.keepBaseline)) {
      updateBlockText(activeId, editText, group.current, { ...previous, targetRect: preview.availableRect, keepBaseline: true, reflow: true, ...(previous?.translate ? { autoGrow: false } : {}) });
    }
  }, [activeId, pageEdits, layouts, preview, editText, updateBlockText]);

  const pointAt = (event: React.PointerEvent | React.MouseEvent) => {
    const bounds = layer.current!.getBoundingClientRect();
    return mapViewportPoint(event.clientX - bounds.left, event.clientY - bounds.top, viewport, source);
  };
  const begin = (block: TextBlock, event: React.PointerEvent) => {
    if (!block.editable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    preferredColumn.current = null;
    const point = pointAt(event);
    if (activeId !== block.id) {
      finish(); useHistoryStore.getState().endGroup();
      focusedBlock.current = block.id; group.current = `text:${block.id}:${crypto.randomUUID()}`;
      const previous = layouts.get(block.id);
      const text = previous?.reflow || (previous && !previous.keepBaseline) ? block.text : originalParagraphText(block.text);
      selectBlock(block.id); setEditText(text); setEditingBlockId(block.id);
      setSelection({ start: 0, end: 0 });
      pendingPoint.current = { ...point, detail: event.detail };
      const cached = preview?.geometry.get(block.id);
      pointer.current = { id: event.pointerId, anchor: inlineOffsetAt(cached?.input.text === text ? cached : sourceGeometry(block, text, previous), point.x, point.y) };
      layer.current?.setPointerCapture?.(event.pointerId);
    } else if (prepared) {
      const offset = inlineOffsetAt(prepared, point.x, point.y);
      const element = input.current;
      const anchor = element?.selectionDirection === 'backward' ? element.selectionEnd : element?.selectionStart ?? selection.start;
      let start = event.shiftKey ? anchor : offset, end = offset;
      if (event.detail >= 2) {
        while (start > 0 && /[\p{L}\p{N}_]/u.test(editText[start - 1])) start--;
        while (end < editText.length && /[\p{L}\p{N}_]/u.test(editText[end])) end++;
      }
      input.current?.focus({ preventScroll: true }); setRange(start, end);
      pointer.current = { id: event.pointerId, anchor: start };
      layer.current?.setPointerCapture?.(event.pointerId);
    }
  };
  useEffect(() => {
    if (mode !== 'text' || !pendingTextEditId) return;
    const block = pageBlocks.find(block => block.id === pendingTextEditId && block.editable);
    if (!block) return;
    finish(); useHistoryStore.getState().endGroup();
    focusedBlock.current = block.id; group.current = `text:${block.id}:${crypto.randomUUID()}`;
    const previous = layouts.get(block.id);
    const text = previous?.reflow || (previous && !previous.keepBaseline) ? block.text : originalParagraphText(block.text);
    selectBlock(block.id); setEditText(text); setEditingBlockId(block.id);
    setSelection({ start: 0, end: 0 });
    clearTextEditRequest();
  }, [mode, pendingTextEditId, pageBlocks, layouts, finish, selectBlock, clearTextEditRequest]);
  const change = (value: string) => {
    pendingPoint.current = null;
    preferredColumn.current = null;
    setEditText(value);
    const previous = activeId ? layouts.get(activeId) : undefined;
    const automatic = previous?.translate ? { ...previous, ...(preview?.activeId === activeId && preview.availableRect ? { targetRect: preview.availableRect } : {}), reflow: true, autoGrow: true }
      : !previous || previous.keepBaseline ? { ...previous, ...(preview?.activeId === activeId && preview.availableRect ? { targetRect: preview.availableRect } : {}), keepBaseline: true, reflow: true } : undefined;
    if (activeId && group.current) updateBlockText(activeId, value, group.current, automatic);
    if (input.current) setSelection({ start: input.current.selectionStart, end: input.current.selectionEnd });
  };
  const keyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    pendingPoint.current = null;
    if (!['ArrowUp', 'ArrowDown', 'Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) preferredColumn.current = null;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); const key = group.current; group.current = null;
      if (key) cancelWorkspaceGroup(key);
      finish();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); finish();
    } else if (prepared && input.current && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      // Native vertical navigation would follow the hidden input's 1px rows.
      // Instead follow the same PDF glyph rows that paint the visible text.
      event.preventDefault();
      const element = input.current, backward = element.selectionDirection === 'backward';
      const offset = backward ? element.selectionStart : element.selectionEnd;
      const rows = inlineTextRows(prepared), row = rows.find(row => offset >= row.start && offset <= row.end) ?? rows.at(-1);
      let next = offset;
      if (event.key === 'Home') next = event.ctrlKey || event.metaKey ? 0 : row?.start ?? 0;
      else if (event.key === 'End') next = event.ctrlKey || event.metaKey ? editText.length : row?.end ?? editText.length;
      else {
        const caret = inlineCaret(prepared, offset), index = row ? rows.indexOf(row) : 0;
        preferredColumn.current ??= caret.x;
        const target = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))];
        if (target) next = inlineOffsetAt(prepared, preferredColumn.current, target.baseline - prepared.layout.fontSize * .3);
      }
      const anchor = event.shiftKey ? backward ? element.selectionEnd : element.selectionStart : next;
      setRange(anchor, next);
    }
  };
  const selectedBlock = pageBlocks.find(block => block.id === selectedBlockId && block.editable);
  const selectedRect = selectedBlock ? blockStyle(selectedBlock) : null;
  const readOnlyReason = pageBlocks.find(block => !block.editable)?.unsupportedReason;
  const caret = activeId && prepared ? rectStyle(inlineCaret(prepared, selection.end)) : null;
  const regions = activeId && prepared ? inlineSelection(prepared, selection.start, selection.end).map(rectStyle) : [];
  const toolbarHost = window.document.getElementById('pdf-text-edit-controls');
  const editActions = selectedBlock && selectedRect && <div ref={actions} className={`text-edit-actions ${toolbarHost ? 'in-toolbar' : ''}`} style={toolbarHost ? undefined : { left: Math.max(0, Math.min(selectedRect.left, (viewport.width || 500) - 270)), top: Math.max(0, selectedRect.top - 40) }}>
    {activeId && !toolbarHost && <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { finish(); setMode('none'); }}>{t("m.done.e9b450")}</button>}
    {onTextLayout && <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { finish(); onTextLayout(selectedBlock.id); }}>{t("m.text.layout.661a8e")}</button>}
    <span id="pdf-text-edit-help">{t("m.enter.new.line.ctrl.enter.done.bbf4cd")}</span>
  </div>;
  if (mode !== 'text' && !preview) return null;
  return <div ref={layer} data-preview-text={preview?.prepared?.input.text} className={`text-edit-layer ${mode === 'text' ? 'active' : 'preview-only'}`} onPointerDown={event => {
    if (event.target === event.currentTarget) { event.preventDefault(); finish(); }
  }} onDoubleClick={event => {
    if (!activeId || !prepared || (event.target as Element).closest('.text-edit-actions')) return;
    event.preventDefault(); pendingPoint.current = null;
    const point = pointAt(event);
    let start = inlineOffsetAt(prepared, point.x, point.y), end = start;
    while (start > 0 && /[\p{L}\p{N}_]/u.test(editText[start - 1])) start--;
    while (end < editText.length && /[\p{L}\p{N}_]/u.test(editText[end])) end++;
    setRange(start, end);
  }} onPointerMove={event => {
    const drag = pointer.current;
    if (!drag || !prepared || event.pointerId !== drag.id) return;
    pendingPoint.current = null;
    const point = pointAt(event), end = inlineOffsetAt(prepared, point.x, point.y);
    setRange(drag.anchor, end);
  }} onPointerUp={event => {
    if (layer.current?.hasPointerCapture?.(event.pointerId)) layer.current.releasePointerCapture(event.pointerId);
    pointer.current = null;
  }} onPointerCancel={() => { pointer.current = null; }}>
    {preview?.png && preview.bytes && <InlinePDFPreview png={preview.png} bytes={preview.bytes} pageNumber={pageNumber} scale={scale} rotation={rotation} editing={mode === 'text' || mode === 'object'} />}
    {mode === 'text' && <>
      {!hasBlocks && analysisError?.page !== page && <div className="text-edit-loading" role="status">{t("m.analyzing.text.297d65")}</div>}
      {analysisError?.page === page && <div className="text-edit-loading" role="alert">{translateError(analysisError.message)}</div>}
      {pageBlocks.map(block => <div key={block.id} className={`text-block ${!block.editable ? 'readonly' : ''} ${selectedBlockId === block.id ? 'selected' : ''} ${activeId === block.id ? 'editing' : ''}`} aria-disabled={!block.editable || undefined} title={translateError(block.unsupportedReason)} style={blockStyle(block)} onPointerDown={event => begin(block, event)}>
        <span className="text-block-content">{block.text}</span>
      </div>)}
      {activeId && <>
        {regions.map((style, index) => <div key={index} className="pdf-text-selection" style={style} />)}
        {caret && selection.start === selection.end && <div className="pdf-text-caret" style={{ ...caret, width: Math.max(1.5, caret.width) }} />}
        <textarea ref={input} className="pdf-text-input" aria-label={t("m.edit.text.on.page.1a4d7e", { v0: pageNumber })} aria-describedby="pdf-text-edit-help" value={editText} spellCheck={false} autoCapitalize="off" autoComplete="off" style={{ left: caret?.left ?? 0, top: caret?.top ?? 0 }} onChange={event => change(event.target.value)} onSelect={event => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onKeyDown={keyDown} onBlur={event => finish(!!actions.current?.contains(event.relatedTarget))} />
      </>}
      {toolbarHost ? createPortal(editActions, toolbarHost) : editActions}
      {!selectedBlock && readOnlyReason && <div className="text-edit-readonly" role="status">{translateError(readOnlyReason)} <button type="button" onClick={() => setMode('none')}>{t("m.exit.text.editing.6c1160")}</button></div>}
    </>}
    {(preview?.error || (prepared && !prepared.layout.fits)) && <div className="text-edit-notice" role="alert">{translateError(preview?.error) || t("m.text.exceeds.the.available.space.open.text.layou.c2d953")}</div>}
  </div>;
}
