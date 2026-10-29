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
    <header><h2 id="create-pdf-title">Create PDF from Images</h2><button type="button" aria-label="Close PDF creation" disabled={stage === 'opening' || canceling} onClick={close}>×</button></header>
    <p>Choose PNG or JPEG images. Each image becomes one page, in the order shown.</p>
    <form onSubmit={create}>
      <fieldset disabled={busy}>
        <label>Images<input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,image/png,image/jpeg" onChange={event => {
          const files = [...(event.target.files ?? [])]; event.target.value = ''; void addImages(files);
        }} /></label>
        {!!images.length && <ol className="create-pdf-images" aria-label="Image page order">
          {images.map((image, index) => <li key={image.id}><span className="create-pdf-image-number">{index + 1}</span><div className="create-pdf-image-description"><strong>{image.name}</strong><span>{image.info.width} × {image.info.height} pixels · {image.info.format.toUpperCase()}</span></div>
            <div className="create-pdf-image-actions"><button type="button" aria-label={`Move image ${index + 1} earlier`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={`Move image ${index + 1} later`} disabled={busy || index === images.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={`Remove image ${index + 1}: ${image.name}`} onClick={() => setImages(previous => previous.filter(item => item.id !== image.id))}>Remove</button></div></li>)}
        </ol>}
        <div className="create-pdf-options">
          <label>Page size<select value={pageSize} onChange={event => setPageSize(event.target.value as ImagePDFOptions['pageSize'])}><option value="a4">A4</option><option value="letter">Letter</option><option value="image">Match image size</option></select></label>
          <label>Orientation<select value={orientation} disabled={busy || pageSize === 'image'} onChange={event => setOrientation(event.target.value as ImagePDFOptions['orientation'])}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
          <label>Margin (mm)<input type="number" min="0" max="50.8" step="any" value={margin} onChange={event => setMargin(event.target.value)} /></label>
        </div>
        {pageSize === 'image' && <p className="conversion-hint">Match image size uses 1 PDF point per image pixel, plus the margins. JPEG orientation is applied automatically.</p>}
        <label>PDF file name<input value={fileName} onChange={event => setFileName(event.target.value)} /></label>
      </fieldset>
      {busy && <div className="conversion-progress"><progress max={progress.total} value={progress.completed} aria-label="PDF creation progress" /><p role="status">{canceling ? 'Canceling…' : stage === 'reading' ? `Reading images (${progress.completed}/${progress.total})…` : stage === 'opening' ? 'Opening the created PDF…' : `Creating PDF (${progress.completed}/${progress.total})…`}</p></div>}
      {error && <p role="alert" className="conversion-error">{error}</p>}
      <footer><button type="button" disabled={stage === 'opening' || canceling} onClick={close}>Cancel</button><button type="submit" className="conversion-primary" disabled={busy || !images.length}>Create PDF</button></footer>
    </form>
  </dialog>;
}

export default CreatePDFDialog;
