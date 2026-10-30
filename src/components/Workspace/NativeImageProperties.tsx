import { useEffect, useRef, useState } from 'react';
import { t, translateError, useLocale } from '../../i18n';
import { useEditingStore } from '../../store/editingStore';
import { useDocumentStore } from '../../store/documentStore';
import { useObjectTransformStore, type ObjectTransformDraft } from '../../store/objectTransformStore';
import { commitPendingEditors, registerPendingEditor } from '../../store/workspaceHistory';
import { changeImageAppearance, imageAppearance, type ImageAppearance } from '../../editing/imageAppearance';
import { moveObjectRect } from '../../editing/objectGeometry';
import type { PDFImage } from '../../editing/types';
import { useNativePage } from './useNativePage';
import { getEffectiveRotation } from '../../core/PDFRenderer';

export function NativeImageProperties({ image }: { image: PDFImage }) {
  useLocale();
  const editing = useEditingStore(), state = imageAppearance(image, editing.imageEdits), page = useNativePage(image.pageNumber);
  const viewRotation = useDocumentStore(store => store.navigation.rotation);
  const swapped = !!page && getEffectiveRotation(page, viewRotation) % 180 !== 0;
  const horizontal = swapped ? 'flipY' : 'flipX', vertical = swapped ? 'flipX' : 'flipY';
  const disabled = !image.source || !!image.unsupportedReason || image.source.insideForm || state.deleted || !page;
  const change = (patch: Partial<Pick<ImageAppearance, 'rotation' | 'flipX' | 'flipY'>>) => {
    if (disabled || !page) return;
    commitPendingEditors();
    const current = imageAppearance(image, useEditingStore.getState().imageEdits), edit = changeImageAppearance(image, current, patch);
    const bounds = page.getViewport({ scale: 1, rotation: 0 }), rect = edit.newRect!;
    const factor = Math.min(1, bounds.width / rect.width, bounds.height / rect.height);
    edit.newRect = moveObjectRect({ ...rect, width: rect.width * factor, height: rect.height * factor }, 0, 0, bounds);
    editing.addImageEdit(edit);
  };
  return <section className="inspector-card native-image-properties" aria-label={t('image.appearance')}>
    <h3>{t('objects.original.image')}</h3>
    <dl><dt>{t('objects.position')}</dt><dd>{state.rect.x.toFixed(1)}, {state.rect.y.toFixed(1)}{' '}{t('m.pt.bc8112')}</dd>
      <dt>{t('objects.size')}</dt><dd>{state.rect.width.toFixed(1)} × {state.rect.height.toFixed(1)}{' '}{t('m.pt.bc8112')}</dd></dl>
    <div className="native-button-grid">
      <button type="button" disabled={disabled} onClick={() => change({ rotation: state.rotation - 90 })}>{t('image.rotate.left')}</button>
      <button type="button" disabled={disabled} onClick={() => change({ rotation: state.rotation + 90 })}>{t('image.rotate.right')}</button>
      <button type="button" disabled={disabled} aria-pressed={state[horizontal]} onClick={() => change({ [horizontal]: !state[horizontal] })}>{t('image.flip.horizontal')}</button>
      <button type="button" disabled={disabled} aria-pressed={state[vertical]} onClick={() => change({ [vertical]: !state[vertical] })}>{t('image.flip.vertical')}</button>
    </div>
    {disabled ? <p>{translateError(image.unsupportedReason) || t(image.source?.insideForm ? 'objects.unsupported.move' : 'image.appearance.unavailable')}</p>
      : <CropSettings key={`${image.id}:${JSON.stringify(state)}`} image={image} state={state} />}
    <button type="button" className="inspector-link" onClick={() => { editing.setMode('image'); editing.selectImage(image.id); }}>{t('objects.image.options')}</button>
  </section>;
}
function CropSettings({ image, state }: { image: PDFImage; state: ImageAppearance }) {
  const round = (value: number) => Number((value * 100).toFixed(4));
  const initial = { top: String(round(state.crop.y)), right: String(round(1 - state.crop.x - state.crop.width)), bottom: String(round(1 - state.crop.y - state.crop.height)), left: String(round(state.crop.x)) };
  const [values, setValues] = useState(initial), [message, setMessage] = useState('');
  const owner = useRef(useDocumentStore.getState()), ownedDraft = useRef<ObjectTransformDraft | null>(null);
  const latest = useRef<() => void>(() => {});
  const dirty = Object.keys(initial).some(key => values[key as keyof typeof initial] !== initial[key as keyof typeof initial]);
  const numbers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim() ? Number(value) : NaN]));
  const valid = Object.values(numbers).every(value => Number.isFinite(value) && value >= 0 && value < 100) && numbers.left + numbers.right < 100 && numbers.top + numbers.bottom < 100;
  const edit = valid && dirty ? changeImageAppearance(image, state, { crop: { x: numbers.left / 100, y: numbers.top / 100, width: 1 - (numbers.left + numbers.right) / 100, height: 1 - (numbers.top + numbers.bottom) / 100 } }) : null;
  const clearDraft = () => { if (useObjectTransformStore.getState().draft === ownedDraft.current) useObjectTransformStore.getState().setDraft(null); ownedDraft.current = null; };
  const currentOwner = () => { const current = useDocumentStore.getState(); return current.document === owner.current.document && current.documentVersion === owner.current.documentVersion && current.loadRequestId === owner.current.loadRequestId && !current.isLoading; };
  useEffect(() => {
    if (edit && currentOwner()) {
      const draft = { pageNumber: image.pageNumber, imageEdit: edit }; ownedDraft.current = draft; useObjectTransformStore.getState().setDraft(draft);
    } else clearDraft();
    return clearDraft;
    // The scalar form values determine this transient preview, never the store's own draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, image]);
  const save = () => {
    if (!dirty) return;
    if (!valid || !edit) { setMessage('image.crop.invalid'); clearDraft(); return; }
    if (currentOwner()) useEditingStore.getState().addImageEdit(edit);
    clearDraft();
  };
  latest.current = save;
  useEffect(() => registerPendingEditor(() => latest.current()), []);
  const cancel = () => { clearDraft(); setValues(initial); setMessage(''); };
  return <div className="native-crop-settings" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <h4>{t('image.crop')}</h4><p>{t('image.crop.help')}</p>
    <div className="native-field-grid">{(['top', 'right', 'bottom', 'left'] as const).map(key => <label key={key}>{t(`image.crop.${key}`)}<input type="number" min="0" max="99.99" step="1" aria-label={t(`image.crop.${key}`)} value={values[key]} onChange={event => { setValues({ ...values, [key]: event.target.value }); setMessage(''); }} /></label>)}</div>
    {(message || (dirty && !valid)) && <p role="alert">{t(message || 'image.crop.invalid')}</p>}
    <div className="native-button-grid"><button type="button" disabled={!dirty || !valid} onClick={save}>{t('image.crop.apply')}</button><button type="button" disabled={!dirty} onClick={cancel}>{t('m.cancel.77dfd2')}</button></div>
    <button type="button" className="inspector-link" disabled={state.crop.x === 0 && state.crop.y === 0 && state.crop.width === 1 && state.crop.height === 1} onClick={() => { clearDraft(); if (currentOwner()) useEditingStore.getState().addImageEdit(changeImageAppearance(image, state, { crop: { x: 0, y: 0, width: 1, height: 1 } })); }}>{t('image.crop.reset')}</button>
  </div>;
}
