import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { prepareTextEditLayoutInWorker } from '../../editing/TextLayoutClient';
import { TEXT_LAYOUT_FONTS, TEXT_LAYOUT_LIMITS, type TextLayoutInput } from '../../editing/TextLayout';
import type { TextEditOperation, TextLayoutOptions, TextRect } from '../../editing/types';
import type { PreparedTextEditLayout } from '../../editing/TextEditApplier';
import { DecorationNumberInput } from './DecorationNumberInput';
import { TextLayoutPreview } from './TextLayoutPreview';
import type { TextLayoutDialogProps, TextLayoutSource } from './TextLayoutDialogTypes';
import './TextLayoutDialog.css';
export type { TextLayoutDialogProps, TextLayoutSource } from './TextLayoutDialogTypes';

interface Loaded { key: object; source: TextLayoutSource; initial: TextEditOperation }
function signature(edit: TextEditOperation) {
  const layout = edit.layout, rect = layout?.targetRect;
  return JSON.stringify([edit.newText, rect ? [rect.x, rect.y, rect.width, rect.height] : null, layout?.fontName, layout?.fontSize, layout?.fontColor, layout?.alignment, layout?.lineHeight]);
}
export function TextLayoutDialog(props: TextLayoutDialogProps) {
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, blockId: props.blockId, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision || session.blockId !== props.blockId) {
    setSession({ key: props.documentKey, revision: props.revision, blockId: props.blockId, sequence: session.sequence + 1 }); return null;
  }
  return <TextLayoutSession key={session.sequence} {...props} />;
}
function TextLayoutSession({ blockId, readPDF, onSave, onClose }: TextLayoutDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null), textarea = useRef<HTMLTextAreaElement>(null), active = useRef(false);
  const reading = useRef<AbortController | null>(null), measuring = useRef<AbortController | null>(null), savingRequest = useRef<AbortController | null>(null), saveLatest = useRef<() => Promise<void>>(async () => {});
  const [retry, setRetry] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null), [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const loadKey = useMemo(() => ({ readPDF, retry }), [readPDF, retry]);
  const current = loaded?.key === loadKey ? loaded : null;
  const [draft, setDraft] = useState<TextEditOperation | null>(null), [resetSequence, setResetSequence] = useState(0), [dragging, setDragging] = useState(false);
  const [dirtyNumbers, setDirtyNumbers] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState<string | null>(null), [zoom, setZoom] = useState('fit');
  const requestKey = useMemo(() => ({ current, draft }), [current, draft]), latestKey = useRef(requestKey);
  const [measurement, setMeasurement] = useState<{ key: object; source: Loaded; prepared?: PreparedTextEditLayout; error?: string } | null>(null);
  const measured = measurement?.key === requestKey ? measurement : null;
  const resolved = measurement?.source === current ? measurement.prepared : undefined;
  const [preview, setPreview] = useState<{ key: object; source: Loaded; data: Uint8Array } | null>(null);
  const sourceBytes = useMemo(() => current ? new Uint8Array(current.source.data) : null, [current]);
  const shownData = preview?.source === current ? preview.data : sourceBytes;
  const displayKey = useMemo(() => ({ data: shownData, zoom }), [shownData, zoom]);
  const [renderedKey, setRenderedKey] = useState<object | null>(null);
  const ready = preview?.key === requestKey && !!measured?.prepared?.layout.fits && renderedKey === displayKey;
  const [renderError, setRenderError] = useState<{ key: object; message: string } | null>(null);
  const page = resolved?.page;
  const block = current?.source.block;
  const input: TextLayoutInput | null = block && draft ? {
    text: draft.newText, rect: draft.layout?.targetRect ?? resolved?.input.rect ?? block.rect,
    fontName: draft.layout?.fontName ?? resolved?.input.fontName ?? ((TEXT_LAYOUT_FONTS as readonly string[]).includes(block.style.fontName) ? block.style.fontName : 'Helvetica'),
    fontSize: draft.layout?.fontSize ?? resolved?.input.fontSize ?? block.style.fontSize,
    fontColor: draft.layout?.fontColor ?? resolved?.input.fontColor ?? block.style.fontColor ?? '#000000',
    alignment: draft.layout?.alignment ?? resolved?.input.alignment ?? block.style.alignment,
    lineHeight: draft.layout?.lineHeight ?? resolved?.input.lineHeight ?? block.style.lineHeight,
  } : null;
  const changed = !!current && !!draft && signature(draft) !== signature(current.initial);
  const canSave = changed && ready && !saving && !dragging && !dirtyNumbers.size && renderError?.key !== displayKey;

  useLayoutEffect(() => { latestKey.current = requestKey; });
  useEffect(() => {
    active.current = true;
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { active.current = false; reading.current?.abort(); measuring.current?.abort(); savingRequest.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const request = new AbortController(); reading.current = request;
    void readPDF(request.signal).then(source => {
      if (request.signal.aborted) return;
      if (source.block.id !== blockId || !source.block.editable) throw new Error(source.block.unsupportedReason || 'This text block is no longer editable.');
      const initial = structuredClone(source.edit ?? { blockId, originalText: source.block.text, newText: source.block.text, timestamp: Date.now() });
      setLoaded({ key: loadKey, source, initial }); setDraft(structuredClone(initial)); setLoadError(null); setSaveError(null);
      requestAnimationFrame(() => { if (!request.signal.aborted) textarea.current?.focus(); });
    }).catch(cause => { if (!request.signal.aborted) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not prepare this text block.' }); });
    return () => request.abort();
  }, [readPDF, blockId, loadKey]);
  useEffect(() => {
    if (!current || !draft || dragging) return;
    const request = new AbortController(); measuring.current = request;
    const timer = window.setTimeout(() => { void (async () => {
      let prepared: PreparedTextEditLayout | undefined;
      try {
        prepared = await prepareTextEditLayoutInWorker(current.source.data, current.source.block, draft, { signal: request.signal });
        if (request.signal.aborted) return;
        setMeasurement({ key: requestKey, source: current, prepared });
        if (!prepared.layout.fits) return;
        const data = await current.source.preview(draft, request.signal);
        if (!request.signal.aborted) setPreview({ key: requestKey, source: current, data });
      } catch (cause) { if (!request.signal.aborted) setMeasurement({ key: requestKey, source: current, prepared, error: cause instanceof Error ? cause.message : 'Could not preview text layout.' }); }
    })(); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [current, draft, requestKey, dragging]);

  const change = (patch: TextLayoutOptions) => {
    setDraft(previous => previous ? { ...previous, layout: { ...previous.layout, ...patch }, timestamp: Date.now() } : previous); setSaveError(null);
  };
  const changeRect = (rect: TextRect) => change({ targetRect: rect });
  const numberDraft = (label: string, dirty: boolean) => setDirtyNumbers(previous => {
    if (previous.has(label) === dirty) return previous;
    const next = new Set(previous); if (dirty) next.add(label); else next.delete(label); return next;
  });
  const close = () => { reading.current?.abort(); measuring.current?.abort(); savingRequest.current?.abort(); onClose(); };
  const save = async () => {
    if (!canSave || !draft || savingRequest.current) return;
    const request = new AbortController(); savingRequest.current = request; setSaving(true); setSaveError(null);
    try {
      if (latestKey.current !== requestKey) return;
      await onSave({ ...draft, timestamp: Date.now() }, request.signal);
      if (active.current && !request.signal.aborted) onClose();
    } catch (cause) { if (active.current && !request.signal.aborted) setSaveError(cause instanceof Error ? cause.message : 'Could not save the text layout draft.'); }
    finally { if (savingRequest.current === request) savingRequest.current = null; if (active.current) setSaving(false); }
  };
  useLayoutEffect(() => { saveLatest.current = save; });
  const layout = measured?.prepared?.layout;
  const fitHeight = layout ? Math.max(1, Math.ceil((layout.suggestedHeight ?? layout.requiredHeight) * 100) / 100) : 0;
  const canFitHeight = !dirtyNumbers.size && !!layout && !!input && !!page && layout.requiredHeight > 0 && fitHeight <= page.height - input.rect.y && fitHeight <= TEXT_LAYOUT_LIMITS.dimension;
  const canShrink = !dirtyNumbers.size && !!layout?.suggestedFontSize && !!input && layout.suggestedFontSize < input.fontSize;
  return <dialog ref={dialog} className="text-layout-dialog" aria-labelledby="text-layout-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); const element = document.activeElement;
      if (element instanceof HTMLInputElement && element.type === 'number') flushSync(() => element.blur());
      void saveLatest.current();
    }
  }}>
    <header><div><h2 id="text-layout-title">Text layout</h2><p>Reflow original PDF text and preview the exported page before saving a draft.</p></div><button type="button" aria-label="Close text layout" onClick={close}>×</button></header>
    {!current && loadError?.key !== loadKey && <p role="status" className="text-layout-loading">Preparing text layout…</p>}
    {loadError?.key === loadKey && <div className="text-layout-loading"><p role="alert" className="text-layout-error">{loadError.message}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {current && draft && input && <div className="text-layout-body">
      <section className="text-layout-settings" aria-label="Text layout settings">
        <fieldset disabled={saving} key={resetSequence}>
          <label>Text<textarea ref={textarea} rows={6} maxLength={TEXT_LAYOUT_LIMITS.characters} value={draft.newText} onChange={event => { const newText = event.target.value; setDraft(previous => previous ? { ...previous, newText, timestamp: Date.now() } : previous); setSaveError(null); }} /></label>
          <p className="text-layout-help">Leave the text empty to delete the original block.</p>
          <h3>Target text area</h3><div className="text-layout-numbers">
            <DecorationNumberInput label="X" value={input.rect.x} min={0} max={page ? Math.max(0, page.width - input.rect.width) : TEXT_LAYOUT_LIMITS.dimension} onDraftChange={dirty => numberDraft('x', dirty)} onChange={x => changeRect({ ...input.rect, x })} />
            <DecorationNumberInput label="Y" value={input.rect.y} min={0} max={page ? Math.max(0, page.height - input.rect.height) : TEXT_LAYOUT_LIMITS.dimension} onDraftChange={dirty => numberDraft('y', dirty)} onChange={y => changeRect({ ...input.rect, y })} />
            <DecorationNumberInput label="Width" value={input.rect.width} min={1} max={Math.min(TEXT_LAYOUT_LIMITS.dimension, page ? page.width - input.rect.x : TEXT_LAYOUT_LIMITS.dimension)} onDraftChange={dirty => numberDraft('width', dirty)} onChange={width => changeRect({ ...input.rect, width })} />
            <DecorationNumberInput label="Height" value={input.rect.height} min={1} max={Math.min(TEXT_LAYOUT_LIMITS.dimension, page ? page.height - input.rect.y : TEXT_LAYOUT_LIMITS.dimension)} onDraftChange={dirty => numberDraft('height', dirty)} onChange={height => changeRect({ ...input.rect, height })} />
          </div>
          <p className="text-layout-help">Positions use unrotated page points. Drag the blue area or its corner handle to move or resize it.</p>
          <label>Font<select value={input.fontName} onChange={event => change({ fontName: event.target.value })}>{TEXT_LAYOUT_FONTS.map(font => <option key={font} value={font}>{font}</option>)}</select></label>
          <div className="text-layout-numbers"><DecorationNumberInput label="Font size" value={input.fontSize} min={1} max={TEXT_LAYOUT_LIMITS.fontSize} onDraftChange={dirty => numberDraft('fontSize', dirty)} onChange={fontSize => change({ fontSize })} />
            <DecorationNumberInput label="Line spacing" value={input.lineHeight} min={1} max={TEXT_LAYOUT_LIMITS.lineHeight} onDraftChange={dirty => numberDraft('lineHeight', dirty)} onChange={lineHeight => change({ lineHeight })} /></div>
          {dirtyNumbers.size > 0 && <p role="status" className="text-layout-help">Press Enter or leave the numeric field to update the preview.</p>}
          <label>Text color<input type="color" value={input.fontColor} onChange={event => change({ fontColor: event.target.value })} /></label>
          <label>Alignment<select value={input.alignment} onChange={event => change({ alignment: event.target.value as TextLayoutInput['alignment'] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option></select></label>
          <div className="text-layout-fit-actions"><button type="button" disabled={!canFitHeight || saving} onClick={() => changeRect({ ...input.rect, height: fitHeight })}>Fit height</button>
            <button type="button" disabled={!canShrink || saving} onClick={() => { if (layout?.suggestedFontSize) change({ fontSize: layout.suggestedFontSize }); }}>Shrink font to fit</button></div>
        </fieldset>
        <p className="text-layout-help">Standard replacement fonts are used. The preview shows the actual font and any supported character fallback.</p>
        {!!layout?.warnings.length && <ul className="text-layout-help">{layout.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      </section>
      <section className="text-layout-preview-column" aria-label="Text layout preview">
        <div className="text-layout-preview-toolbar"><label>Preview zoom<select value={zoom} disabled={dragging} onChange={event => setZoom(event.target.value)}><option value="fit">Fit width</option><option value="1">100%</option><option value="2">200%</option></select></label>
          <p role="status">{dirtyNumbers.size ? 'Finish numeric input to update the preview.' : ready ? 'Preview ready' : dragging ? 'Adjusting target area…' : measured?.error ? 'Preview unavailable' : layout && !layout.fits ? 'Text does not fit' : 'Updating preview…'}</p>
          <div className="text-layout-legend"><span>Original removal area</span><span>Target text area</span></div></div>
        {shownData && <TextLayoutPreview data={shownData} pageNumber={current.source.block.pageNumber} sourceRect={current.source.block.rect} targetRect={input.rect} scale={zoom === 'fit' ? undefined : Number(zoom)} disabled={saving || !!dirtyNumbers.size} onChange={changeRect} onInteractionChange={setDragging} onReady={() => setRenderedKey(displayKey)} onError={message => setRenderError({ key: displayKey, message })} />}
        {layout && !layout.fits && <p className="text-layout-help">The last valid preview is shown. Adjust the area or font before saving.</p>}
      </section>
    </div>}
    <footer><p className="text-layout-help">The original removal area stays unchanged. Moving or resizing the target only changes where replacement text is placed.</p>
      {(layout?.overflow || measured?.error || saveError || (renderError?.key === displayKey && renderError.message)) && <p role="alert" className="text-layout-error">{saveError || measured?.error || layout?.overflow || renderError?.message}</p>}
      {layout?.fits && <p className="text-layout-fit-status">Text fits · {layout.lines.length} {layout.lines.length === 1 ? 'line' : 'lines'} · {layout.requiredHeight.toFixed(1)} points high</p>}
      <div><button type="button" disabled={!current || saving} onClick={() => { if (current) { setDraft({ blockId, originalText: current.initial.originalText, newText: current.initial.originalText, timestamp: Date.now() }); setResetSequence(value => value + 1); setDirtyNumbers(new Set()); setSaveError(null); } }}>Reset to original</button>
        <button type="button" onClick={close}>Cancel</button><button type="button" className="text-layout-primary" disabled={!canSave} onClick={() => void save()}>{saving ? 'Saving…' : 'Save draft'}</button></div>
    </footer>
  </dialog>;
}
export default TextLayoutDialog;
