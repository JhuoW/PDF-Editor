import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError } from "../../i18n";
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPDFFromImages, validateImageCollection, IMAGE_LIMITS, type PDFImageInput, type ImageInfo, type ImagePDFOptions } from '../../core/ImagePDF';
import './ConversionDialog.css';
import './CreatePDFDialog.css';

export interface CreatePDFDialogProps {
  onCreate: (file: File) => Promise<boolean | void>;
  onClose: () => void;
}
interface SelectedImage extends PDFImageInput { id: string; info: ImageInfo }

export function CreatePDFDialog({ onCreate, onClose }: CreatePDFDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const opening = useRef(false);
  const closeAfterCancel = useRef(false);
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [pageSize, setPageSize] = useState<ImagePDFOptions['pageSize']>('a4');
  const [orientation, setOrientation] = useState<ImagePDFOptions['orientation']>('portrait');
  const [margin, setMargin] = useState('10');
  const [fileName, setFileName] = useState('images.pdf');
  const [stage, setStage] = useState<'reading' | 'creating' | 'opening' | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 1 });
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal(); input.current?.focus();
    return () => {
      active.current = false;
      controller.current?.abort();
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const close = () => {
    if (opening.current) return;
    if (controller.current) {
      closeAfterCancel.current = true;
      controller.current.abort();
      setCanceling(true);
    } else onClose();
  };
  const finish = (operation: AbortController) => {
    if (controller.current === operation) controller.current = null;
    opening.current = false;
    if (active.current) {
      setStage(null); setCanceling(false);
      if (closeAfterCancel.current) onClose();
    }
  };

  const addImages = async (files: File[]) => {
    if (!files.length || controller.current) return;
    setError(null);
    const existingBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0);
    if (files.length + images.length > IMAGE_LIMITS.files
      || files.some(file => file.size < 1 || file.size > IMAGE_LIMITS.bytesPerFile)
      || existingBytes + files.reduce((sum, file) => sum + file.size, 0) > IMAGE_LIMITS.totalBytes) {
      setError('Choose up to 100 images, each at most 40 MB, with at most 150 MB in total.');
      return;
    }
    const operation = new AbortController(); controller.current = operation;
    closeAfterCancel.current = false; setStage('reading'); setProgress({ completed: 0, total: files.length });
    try {
      const additions: PDFImageInput[] = [];
      for (const [index, file] of files.entries()) {
        const data = await file.arrayBuffer();
        operation.signal.throwIfAborted();
        if (!active.current) return;
        additions.push({ name: file.name, data });
        setProgress({ completed: index + 1, total: files.length });
      }
      const collection = [...images, ...additions];
      const information = validateImageCollection(collection);
      operation.signal.throwIfAborted();
      if (active.current) setImages(collection.map((image, index) => ({ ...image, id: images[index]?.id ?? crypto.randomUUID(), info: information[index] })));
    } catch (cause) {
      if (active.current && !operation.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not read these images.');
    } finally { finish(operation); }
  };

  const move = (index: number, direction: -1 | 1) => setImages(previous => {
    const next = [...previous];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    return next;
  });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (controller.current || !active.current || !images.length) return;
    const millimeters = Number(margin), name = fileName.trim().replace(/[\\/]/g, '-');
    if (!margin.trim() || !Number.isFinite(millimeters) || millimeters < 0 || millimeters > 50.8) { setError('Enter a margin between 0 and 50.8 mm.'); return; }
    if (!name || name.toLowerCase() === '.pdf') { setError('Enter a PDF file name.'); return; }
    const operation = new AbortController(); controller.current = operation;
    closeAfterCancel.current = false; setError(null); setStage('creating'); setProgress({ completed: 0, total: images.length });
    try {
      const bytes = await createPDFFromImages(images, { pageSize, orientation, margin: millimeters * 72 / 25.4, signal: operation.signal,
        onProgress: (completed, total) => { if (active.current && !operation.signal.aborted) setProgress({ completed, total }); } });
      operation.signal.throwIfAborted();
      if (!active.current) return;
      opening.current = true; setStage('opening');
      const file = new File([new Uint8Array(bytes)], /\.pdf$/i.test(name) ? name : `${name}.pdf`, { type: 'application/pdf' });
      const opened = await onCreate(file);
      if (!active.current) return;
      if (opened === false) throw new Error('Could not open the created PDF. Please try again.');
      onClose();
    } catch (cause) {
      if (active.current && !operation.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not create the PDF.');
    } finally { finish(operation); }
  };

  return <dialog ref={dialog} className="conversion-dialog create-pdf-dialog" aria-labelledby="create-pdf-title"
    onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault(); }}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id="create-pdf-title">{t("m.create.pdf.from.images.0a9d94")}</h2><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.pdf.creation.f61d07")} disabled={stage === 'opening' || canceling} onClick={close}>×</button></header>
    <p>{t("m.choose.png.or.jpeg.images.each.image.becomes.one.ea81a1")}</p>
    <form onSubmit={create}>
      <fieldset disabled={busy}>
        <label>{t("m.images.09e871")}<input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={event => {
          const files = [...(event.target.files ?? [])]; event.target.value = ''; void addImages(files);
        }} /></label>
        {!!images.length && <ol className="create-pdf-images" aria-label={t("m.image.page.order.d0c46a")}>
          {images.map((image, index) => <li key={image.id}><span className="create-pdf-image-number">{index + 1}</span><div className="create-pdf-image-description"><strong>{image.name}</strong><span>{t("m.pixels.0503c5", { v0: image.info.width, v1: image.info.height, v2: image.info.format.toUpperCase() })}</span></div>
            <div className="create-pdf-image-actions"><button type="button" aria-label={t("m.move.image.earlier.2bdde1", { v0: index + 1 })} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={t("m.move.image.later.83f463", { v0: index + 1 })} disabled={busy || index === images.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={t("m.remove.image.eda196", { v0: index + 1, v1: image.name })} onClick={() => setImages(previous => previous.filter(item => item.id !== image.id))}>{t("m.remove.e96390")}</button></div></li>)}
        </ol>}
        <div className="create-pdf-options">
          <label>{t("m.page.size.c118e2")}<select value={pageSize} onChange={event => setPageSize(event.target.value as ImagePDFOptions['pageSize'])}><option value="a4">{t("m.a4.de69a6")}</option><option value="letter">{t("m.letter.ee1405")}</option><option value="image">{t("m.match.image.size.559142")}</option></select></label>
          <label>{t("m.orientation.86e4e3")}<select value={orientation} disabled={busy || pageSize === 'image'} onChange={event => setOrientation(event.target.value as ImagePDFOptions['orientation'])}><option value="portrait">{t("m.portrait.92b6b1")}</option><option value="landscape">{t("m.landscape.7dc4be")}</option></select></label>
          <label>{t("m.margin.mm.bcf854")}<input type="number" min="0" max="50.8" step="any" value={margin} onChange={event => setMargin(event.target.value)} /></label>
        </div>
        {pageSize === 'image' && <p className="conversion-hint">{t("m.match.image.size.uses.1.pdf.point.per.image.pixe.a90562")}</p>}
        <label>{t("m.pdf.file.name.917f85")}<input value={fileName} onChange={event => setFileName(event.target.value)} /></label>
      </fieldset>
      {busy && <div className="conversion-progress"><progress max={progress.total} value={progress.completed} aria-label={t("m.pdf.creation.progress.7a5ac7")} /><p role="status">{canceling ? t("m.canceling.9dd59f") : stage === 'reading' ? t("m.reading.images.8cec4e", { v0: progress.completed, v1: progress.total }) : stage === 'opening' ? t("m.opening.the.created.pdf.9f1a97") : t("m.creating.pdf.fb2d73", { v0: progress.completed, v1: progress.total })}</p></div>}
      {error && <p role="alert" className="conversion-error">{translateError(error)}</p>}
      <footer><button type="button" disabled={stage === 'opening' || canceling} onClick={close}>{t("m.cancel.77dfd2")}</button><button type="submit" className="conversion-primary" disabled={busy || !images.length}>{t("m.create.pdf.a18c88")}</button></footer>
    </form>
  </dialog>;
}

export default CreatePDFDialog;
