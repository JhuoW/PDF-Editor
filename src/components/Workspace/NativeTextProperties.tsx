import { useEffect, useMemo, useRef, useState } from 'react';
import { t, translateError, useLocale } from '../../i18n';
import { useEditingStore } from '../../store/editingStore';
import { useDocumentStore } from '../../store/documentStore';
import { useHistoryStore } from '../../store/historyStore';
import { commitPendingEditors } from '../../store/workspaceHistory';
import { prepareTextEditLayoutInWorker } from '../../editing/TextLayoutClient';
import { TEXT_LAYOUT_FONTS, standardTextFont } from '../../editing/TextLayout';
import { objectRect } from '../../editing/objectOperations';
import type { PreparedTextEditLayout } from '../../editing/TextEditApplier';
import type { TextBlock, TextLayoutOptions } from '../../editing/types';
import { DecorationNumberInput } from '../Dialogs/DecorationNumberInput';

export function NativeTextProperties({ block, onTextLayout }: { block: TextBlock; onTextLayout: (id: string) => void }) {
  useLocale();
  const document = useDocumentStore(state => state.document), edits = useEditingStore(state => state.textEdits);
  const key = useMemo(() => ({ document, id: block.id }), [document, block.id]);
  const [result, setResult] = useState<{ key: object; prepared?: PreparedTextEditLayout; error?: string } | null>(null);
  const colorGroup = useRef<string | undefined>(undefined);
  const current = result?.key === key ? result : null, layout = edits.find(edit => edit.blockId === block.id)?.layout;
  useEffect(() => {
    if (!document || !block.editable) return;
    const controller = new AbortController();
    void document.getData().then(data => prepareTextEditLayoutInWorker(data, block, undefined, { signal: controller.signal }))
      .then(prepared => { if (!controller.signal.aborted) setResult({ key, prepared }); })
      .catch(cause => { if (!controller.signal.aborted) setResult({ key, error: cause instanceof Error ? cause.message : 'Could not prepare text formatting.' }); });
    return () => controller.abort();
    // Original style is tied to the PDF and block identity, not each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const prepared = current?.prepared, disabled = !block.editable || !prepared || !!current?.error;
  const font = layout?.fontName ?? prepared?.input.fontName ?? standardTextFont(block.style.fontName);
  const commitTextEditor = () => {
    const selected = useEditingStore.getState().selectedBlockId === block.id;
    commitPendingEditors();
    // Finishing inline typing clears its selection. A property change still
    // belongs to this block and must not unmount its own controls on focus.
    if (selected && useDocumentStore.getState().document === key.document && useEditingStore.getState().getBlock(block.id)) {
      useEditingStore.getState().selectBlock(block.id);
    }
  };
  const change = (patch: TextLayoutOptions, groupKey?: string) => {
    if (disabled) return;
    if (!groupKey) commitTextEditor();
    const state = useEditingStore.getState(), latest = state.getBlock(block.id), previous = state.textEdits.find(edit => edit.blockId === block.id);
    if (!latest?.editable || useDocumentStore.getState().document !== key.document) return;
    const previousLayout = previous?.layout;
    const next: TextLayoutOptions = { keepBaseline: true, ...previousLayout, targetRect: objectRect({ kind: 'text', item: latest }),
      autoGrow: false, fitToContent: true, ...patch };
    state.updateBlockLayout({ blockId: block.id, originalText: previous?.originalText ?? latest.text, newText: latest.text, layout: next, timestamp: Date.now() }, groupKey);
  };
  const bold = /Bold/.test(font), italic = /Italic|Oblique/.test(font);
  const variant = (isBold: boolean, isItalic: boolean) => {
    if (font.startsWith('Times')) return isBold ? isItalic ? 'Times-BoldItalic' : 'Times-Bold' : isItalic ? 'Times-Italic' : 'Times-Roman';
    const family = font.startsWith('Courier') ? 'Courier' : 'Helvetica';
    return `${family}${isBold ? '-Bold' : ''}${isItalic ? isBold ? 'Oblique' : '-Oblique' : ''}`;
  };
  return <section className="inspector-card native-text-properties" aria-label={t('text.format')}>
    <h3>{t('m.original.pdf.text.9acab0')}</h3>
    {!prepared && !current?.error && block.editable && <p role="status">{t('text.format.loading')}</p>}
    {(current?.error || !block.editable) && <p role="alert">{translateError(current?.error ?? block.unsupportedReason)}</p>}
    <fieldset disabled={disabled}>
      <label>{t('m.font.b97c4d')}<select aria-label={t('text.format.font')} value={layout?.fontName ?? 'original'} onChange={event => change({ fontName: event.target.value === 'original' ? undefined : event.target.value })}>
        <option value="original">{t('m.original.pdf.font.0d4133')}</option>{TEXT_LAYOUT_FONTS.map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>
      <div className="native-field-grid"><DecorationNumberInput label={t('m.font.size.83ca9e')} value={layout?.fontSize ?? prepared?.input.fontSize ?? block.style.fontSize} min={1} max={500} onChange={fontSize => change({ fontSize })} />
        <DecorationNumberInput label={t('m.line.spacing.18f550')} value={layout?.lineHeight ?? prepared?.input.lineHeight ?? block.style.lineHeight} min={layout?.keepBaseline === false ? 1 : .25} max={5} step={.1} onChange={lineHeight => change({ lineHeight })} /></div>
      <div className="native-button-grid"><button type="button" aria-pressed={bold} onClick={() => change({ fontName: variant(!bold, italic) })}>{t('text.format.bold')}</button><button type="button" aria-pressed={italic} onClick={() => change({ fontName: variant(bold, !italic) })}>{t('text.format.italic')}</button></div>
      <label>{t('m.text.color.1c7a30')}<input type="color" aria-label={t('m.text.color.1c7a30')} value={layout?.fontColor ?? prepared?.input.fontColor ?? '#000000'} onFocus={() => { commitTextEditor(); colorGroup.current = `format:${block.id}:${crypto.randomUUID()}`; }} onBlur={() => { useHistoryStore.getState().endGroup(); colorGroup.current = undefined; }} onChange={event => change({ fontColor: event.target.value }, colorGroup.current)} /></label>
      <label>{t('m.alignment.7f8c51')}<select aria-label={t('text.format.alignment')} value={layout?.alignment ?? prepared?.input.alignment ?? block.style.alignment} onChange={event => change({ alignment: event.target.value as TextLayoutOptions['alignment'] })}>
        {(['left', 'center', 'right', 'justify'] as const).map(value => <option key={value} value={value}>{t(`text.format.align.${value}`)}</option>)}
      </select></label>
    </fieldset>
    <button className="inspector-primary" disabled={!block.editable} onClick={() => { commitTextEditor(); onTextLayout(block.id); }}>{t('m.text.layout.661a8e')}</button>
    <p>{t('text.format.help')}</p>
  </section>;
}
