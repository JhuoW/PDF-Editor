import { TextFontPicker } from '../Fonts/TextFontPicker';
import type { FontAsset } from '../../fonts/fontAsset';
import { ErrorMessage } from '../Feedback/ErrorMessage';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateMessage } from "../../i18n";
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
  return JSON.stringify([edit.newText, rect ? [rect.x, rect.y, rect.width, rect.height] : null, layout?.fontName, layout?.fontSize, layout?.fontColor, layout?.alignment, layout?.lineHeight, layout?.keepBaseline]);
}
export function TextLayoutDialog(props: TextLayoutDialogProps) {
  useLocale();
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, blockId: props.blockId, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision || session.blockId !== props.blockId) {
    setSession({ key: props.documentKey, revision: props.revision, blockId: props.blockId, sequence: session.sequence + 1 }); return null;
  }
  return <TextLayoutSession key={session.sequence} {...props} />;
}
function TextLayoutSession({ blockId, readPDF, onSave, onClose }: TextLayoutDialogProps) {
  useLocale();
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

  const change = (patch: TextLayoutOptions, asset?: FontAsset) => {
    setDraft(previous => previous ? { ...previous, font: 'fontName' in patch ? asset : previous.font, layout: { ...previous.layout, ...patch, keepBaseline: false }, timestamp: Date.now() } : previous); setSaveError(null);
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
    <header><div><h2 id="text-layout-title">{t("m.text.layout.2392cb")}</h2><p>{t("m.reflow.original.pdf.text.and.preview.the.exporte.0ffea2")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.text.layout.45632f")} onClick={close}>×</button></header>
    {!current && loadError?.key !== loadKey && <p role="status" className="text-layout-loading">{t("m.preparing.text.layout.dfd862")}</p>}
    {loadError?.key === loadKey && <div className="text-layout-loading"><p role="alert" className="text-layout-error"><ErrorMessage error={loadError.message} /></p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("m.retry.9f5cd8")}</button></div>}
    {current && draft && input && <div className="text-layout-body">
      <section className="text-layout-settings" aria-label={t("m.text.layout.settings.b8b81d")}>
        <fieldset disabled={saving} key={resetSequence}>
          <label>{t("m.text.c3328c")}<textarea ref={textarea} rows={6} maxLength={TEXT_LAYOUT_LIMITS.characters} value={draft.newText} onChange={event => { const newText = event.target.value; setDraft(previous => previous ? { ...previous, newText, timestamp: Date.now() } : previous); setSaveError(null); }} /></label>
          <p className="text-layout-help">{t("m.leave.the.text.empty.to.delete.the.original.bloc.aa3df2")}</p>
          <h3>{t("m.target.text.area.85c23d")}</h3><div className="text-layout-numbers">
            <DecorationNumberInput label={t("m.x.c032ad")} value={input.rect.x} min={0} max={page ? Math.max(0, page.width - input.rect.width) : TEXT_LAYOUT_LIMITS.dimension} onDraftChange={dirty => numberDraft('x', dirty)} onChange={x => changeRect({ ...input.rect, x })} />
            <DecorationNumberInput label={t("m.y.23eb4d")} value={input.rect.y} min={0} max={page ? Math.max(0, page.height - input.rect.height) : TEXT_LAYOUT_LIMITS.dimension} onDraftChange={dirty => numberDraft('y', dirty)} onChange={y => changeRect({ ...input.rect, y })} />
            <DecorationNumberInput label={t("m.width.a58ddf")} value={input.rect.width} min={1} max={Math.min(TEXT_LAYOUT_LIMITS.dimension, page ? page.width - input.rect.x : TEXT_LAYOUT_LIMITS.dimension)} onDraftChange={dirty => numberDraft('width', dirty)} onChange={width => changeRect({ ...input.rect, width })} />
            <DecorationNumberInput label={t("m.height.3f608b")} value={input.rect.height} min={1} max={Math.min(TEXT_LAYOUT_LIMITS.dimension, page ? page.height - input.rect.y : TEXT_LAYOUT_LIMITS.dimension)} onDraftChange={dirty => numberDraft('height', dirty)} onChange={height => changeRect({ ...input.rect, height })} />
          </div>
          <p className="text-layout-help">{t("m.positions.use.unrotated.page.points.drag.the.blu.f1dd43")}</p>
          <TextFontPicker value={draft.layout?.fontName} asset={draft.font} onChange={(fontName, asset) => change({ fontName }, asset)} />
          <div className="text-layout-numbers"><DecorationNumberInput label={t("m.font.size.83ca9e")} value={input.fontSize} min={1} max={TEXT_LAYOUT_LIMITS.fontSize} onDraftChange={dirty => numberDraft('fontSize', dirty)} onChange={fontSize => change({ fontSize })} />
            <DecorationNumberInput label={t("m.line.spacing.18f550")} value={input.lineHeight} min={1} max={TEXT_LAYOUT_LIMITS.lineHeight} onDraftChange={dirty => numberDraft('lineHeight', dirty)} onChange={lineHeight => change({ lineHeight })} /></div>
          {dirtyNumbers.size > 0 && <p role="status" className="text-layout-help">{t("m.press.enter.or.leave.the.numeric.field.to.update.bffe6e")}</p>}
          <label>{t("m.text.color.1c7a30")}<input type="color" value={input.fontColor} onChange={event => change({ fontColor: event.target.value })} /></label>
          <label>{t("m.alignment.7f8c51")}<select value={input.alignment} onChange={event => change({ alignment: event.target.value as TextLayoutInput['alignment'] })}><option value="left">{t("m.left.8ae1c3")}</option><option value="center">{t("m.center.a23911")}</option><option value="right">{t("m.right.954daa")}</option><option value="justify">{t("m.justify.536d27")}</option></select></label>
          <div className="text-layout-fit-actions"><button type="button" disabled={!canFitHeight || saving} onClick={() => changeRect({ ...input.rect, height: fitHeight })}>{t("m.fit.height.e33d68")}</button>
            <button type="button" disabled={!canShrink || saving} onClick={() => { if (layout?.suggestedFontSize) change({ fontSize: layout.suggestedFontSize }); }}>{t("m.shrink.font.to.fit.f613cf")}</button></div>
        </fieldset>
        <p className="text-layout-help">{t("m.standard.replacement.fonts.are.used.the.preview..05f58c")}</p>
        {!!layout?.warnings.length && <ul className="text-layout-help">{layout.warnings.map((warning, index) => <li key={index}>{translateMessage(warning)}</li>)}</ul>}
      </section>
      <section className="text-layout-preview-column" aria-label={t("m.text.layout.preview.e6eadf")}>
        <div className="text-layout-preview-toolbar"><label>{t("m.preview.zoom.e32787")}<select value={zoom} disabled={dragging} onChange={event => setZoom(event.target.value)}><option value="fit">{t("m.fit.width.0071b9")}</option><option value="1">100%</option><option value="2">200%</option></select></label>
          <p role="status">{dirtyNumbers.size ? t("m.finish.numeric.input.to.update.the.preview.4415fd") : ready ? t("m.preview.ready.8a0295") : dragging ? t("m.adjusting.target.area.3340cf") : measured?.error ? t("m.preview.unavailable.36d31d") : layout && !layout.fits ? t("m.text.does.not.fit.cc08d5") : t("m.updating.preview.3b1b2b")}</p>
          <div className="text-layout-legend"><span>{t("m.original.removal.area.d9b664")}</span><span>{t("m.target.text.area.85c23d")}</span></div></div>
        {shownData && <TextLayoutPreview data={shownData} pageNumber={current.source.block.pageNumber} sourceRect={current.source.block.rect} targetRect={input.rect} scale={zoom === 'fit' ? undefined : Number(zoom)} disabled={saving || !!dirtyNumbers.size} onChange={changeRect} onInteractionChange={setDragging} onReady={() => setRenderedKey(displayKey)} onError={message => setRenderError({ key: displayKey, message })} />}
        {layout && !layout.fits && <p className="text-layout-help">{t("m.the.last.valid.preview.is.shown.adjust.the.area..74c3f4")}</p>}
      </section>
    </div>}
    <footer><p className="text-layout-help">{t("m.the.original.removal.area.stays.unchanged.moving.fc42d5")}</p>
      {(layout?.overflow || measured?.error || saveError || (renderError?.key === displayKey && renderError.message)) && <p role="alert" className="text-layout-error"><ErrorMessage error={saveError || measured?.error || layout?.overflow || renderError?.message} /></p>}
      {layout?.fits && <p className="text-layout-fit-status">{t("m.text.fits.f97d99")}{' '}{layout.lines.length} {layout.lines.length === 1 ? t("m.line.264f39") : t("m.lines.8525aa")} · {layout.requiredHeight.toFixed(1)}{' '}{t("m.points.high.e92e6d")}</p>}
      <div><button type="button" disabled={!current || saving} onClick={() => { if (current) { setDraft({ blockId, originalText: current.initial.originalText, newText: current.initial.originalText, timestamp: Date.now() }); setResetSequence(value => value + 1); setDirtyNumbers(new Set()); setSaveError(null); } }}>{t("m.reset.to.original.352488")}</button>
        <button type="button" onClick={close}>{t("m.cancel.77dfd2")}</button><button type="button" className="text-layout-primary" disabled={!canSave} onClick={() => void save()}>{saving ? t("m.saving.56a228") : t("m.save.draft.4f2563")}</button></div>
    </footer>
  </dialog>;
}
export default TextLayoutDialog;
