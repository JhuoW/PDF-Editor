import { ErrorMessage } from '../Feedback/ErrorMessage';
import { useLocale, t, translateMessage } from "../../i18n";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useEditingStore } from '../../store/editingStore';
import { useUIStore } from '../../store/uiStore';
import { detectImages } from '../../editing/ImageDetector';
import type { PDFImage } from '../../editing/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportRect } from '../../utils/viewportMapping';
import './ImageEditLayer.css';

interface ImageEditLayerProps { page: PDFPageProxy; pageNumber: number; scale: number; rotation: number }

export function ImageEditLayer({ page, pageNumber, scale, rotation }: ImageEditLayerProps) {
  useLocale();
  const { mode, images, setImages, selectedImageId, selectImage, imageEdits, addImageEdit, resetImageEdits } = useEditingStore();
  const [error, setError] = useState<{ page: PDFPageProxy; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageImages = images.get(pageNumber) ?? [];
  const hasImages = images.has(pageNumber);
  const selected = pageImages.find(image => image.id === selectedImageId);
  const editsFor = (image: PDFImage) => imageEdits.filter(edit => edit.imageId === image.id);
  const effectiveRect = (image: PDFImage) => editsFor(image).reduce((rect, edit) => edit.newRect ?? rect, image.rect);
  const isDeleted = (image: PDFImage) => editsFor(image).reduce((deleted, edit) => edit.type === 'delete' ? true : edit.type === 'replace' ? false : deleted, false);
  const unsupported = selected?.unsupportedReason ?? (selected && !selected.source ? 'This older image selection must be detected again. Reopen the document before editing it.' : '');

  useEffect(() => {
    if (mode !== 'image' || hasImages) return;
    let cancelled = false;
    detectImages(page).then(detected => {
      if (cancelled) return;
      setError(null);
      setImages(pageNumber, detected);
    }).catch(err => {
      if (!cancelled) setError({ page, message: err instanceof Error ? err.message : 'Could not detect images' });
    });
    return () => { cancelled = true; };
  }, [mode, page, pageNumber, hasImages, setImages]);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const state = useEditingStore.getState();
    const image = state.images.get(pageNumber)?.find(candidate => candidate.id === state.selectedImageId);
    event.target.value = '';
    if (!file || !image?.source || image.unsupportedReason) return;
    try {
      const data = await file.arrayBuffer();
      // A file dialog/read can finish after a new document or page is loaded.
      if (!useEditingStore.getState().images.get(pageNumber)?.some(candidate => candidate.id === image.id)) return;
      addImageEdit({ imageId: image.id, type: 'replace', newImageData: data, timestamp: Date.now() });
      setError(null);
    } catch (err) { setError({ page, message: err instanceof Error ? err.message : 'Could not read replacement image' }); }
  }, [page, pageNumber, addImageEdit]);

  const handleDelete = useCallback(() => {
    const state = useEditingStore.getState();
    const image = state.images.get(pageNumber)?.find(item => item.id === state.selectedImageId);
    if (!image?.source || image.unsupportedReason) return;
    state.addImageEdit({ imageId: image.id, type: 'delete', timestamp: Date.now() });
  }, [pageNumber]);

  if (mode !== 'image') return null;
  const baseViewport = page.getViewport({ scale: 1, rotation: 0 });
  const displayViewport = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });

  return (
    <div className="image-edit-layer" onClick={() => selectImage(null)}>
      {!hasImages && error?.page !== page && <div className="image-edit-loading">{t("m.detecting.images.1965f5")}</div>}
      {error?.page === page && <div className="image-edit-loading" role="alert"><ErrorMessage error={error.message} /></div>}
      {hasImages && pageImages.length === 0 && <div className="image-edit-loading">{t("m.no.supported.image.xobjects.found.on.this.page.5abfa8")}</div>}
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" aria-label={t("m.replacement.image.c25591")} hidden onChange={handleFileChange} />
      {pageImages.map(image => {
        const rect = mapViewportRect(effectiveRect(image), baseViewport, displayViewport);
        const pending = editsFor(image).length > 0;
        return (
          <div key={image.id} className={`image-box ${selectedImageId === image.id ? 'selected' : ''} ${pending ? 'pending' : ''} ${isDeleted(image) ? 'pending-delete' : ''}`}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            role="button" aria-label={t("m.select.original.image.c625e4", { v0: pageImages.indexOf(image) + 1 })} tabIndex={0}
            onClick={event => { event.stopPropagation(); selectImage(image.id); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); selectImage(image.id); } }}>
            <span className="image-label">{isDeleted(image) ? t("m.delete.pending.cf92e6") : pending ? t("m.image.edit.pending.89087c") : t("m.image.e1003c")}</span>
          </div>
        );
      })}
      {selected && (
        <div className="image-controls" onClick={event => event.stopPropagation()}>
          <div className="image-control-actions">
            <button className="image-btn replace" disabled={!!unsupported} onClick={() => fileInputRef.current?.click()}>{t("m.replace.a7cf7b")}</button>
            <button className="image-btn delete" disabled={!!unsupported || isDeleted(selected)} onClick={handleDelete}>{t("m.delete.f6fdbe")}</button>
            <button className="image-btn" disabled={editsFor(selected).length === 0} onClick={() => resetImageEdits(selected.id)}>{t("m.reset.image.edits.5e69da")}</button>
            <button className="image-btn" onClick={() => useUIStore.getState().setInspectorOpen(true)}>{t('image.appearance')}</button>
          </div>
          {unsupported ? <p role="status">{translateMessage(unsupported)}</p> : selected.source?.insideForm ? <p>{t("m.images.inside.pdf.forms.support.replace.and.dele.567f73")}</p> : (
            <form key={`${selected.id}-${JSON.stringify(effectiveRect(selected))}`} className="image-geometry" onSubmit={event => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const newRect = { x: Number(values.get('x')), y: Number(values.get('y')), width: Number(values.get('width')), height: Number(values.get('height')) };
              if (!Object.values(newRect).every(Number.isFinite) || newRect.width <= 0 || newRect.height <= 0) return;
              addImageEdit({ imageId: selected.id, type: 'resize', newRect, timestamp: Date.now() });
            }}>
              {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{translateMessage(key)}<input name={key} aria-label={t("m.image.fc57bf", { v0: key })} type="number" step="any" min={key === 'width' || key === 'height' ? 0.01 : undefined} required disabled={isDeleted(selected)} defaultValue={Number(effectiveRect(selected)[key].toFixed(2))} /></label>)}
              <button className="image-btn" type="submit" disabled={isDeleted(selected)}>{t("m.set.position.and.size.25aac6")}</button>
            </form>
          )}
          <p>{t("m.use.apply.content.changes.or.export.to.update.th.642225")}</p>
        </div>
      )}
    </div>
  );
}
