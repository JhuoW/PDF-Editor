import { useEffect, useRef, useState } from 'react';
import { downloadPageExport, exportPagesInWorker } from '../../core/PageExportClient';
import type { PageExportProgress, PageExportSettings } from '../../core/PageExport';
import './ConversionDialog.css';

interface ExportPagesDialogProps {
  readPDF: () => Promise<{ data: Uint8Array | ArrayBuffer; fileName: string }>;
  onClose: () => void;
}

export function ExportPagesDialog({ readPDF, onClose }: ExportPagesDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const firstInput = useRef<HTMLSelectElement>(null);
  const mounted = useRef(false), submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [format, setFormat] = useState<PageExportSettings['format']>('png');
  const [range, setRange] = useState('');
  const [dpi, setDpi] = useState<150 | 300>(150);
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PageExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    firstInput.current?.focus();
    return () => { mounted.current = false; controller.current?.abort(); element?.close(); };
  }, []);
  const close = () => { controller.current?.abort(); onClose(); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(null); setProgress(null);
    try {
      const source = await readPDF();
      if (!mounted.current || request.signal.aborted) return;
      const result = await exportPagesInWorker(source.data, { format, range, dpi, quality, fileName: source.fileName }, {
        signal: request.signal,
        onProgress: value => { if (mounted.current && !request.signal.aborted) setProgress(value); },
      });
      if (!mounted.current || request.signal.aborted) return;
      downloadPageExport(result);
      onClose();
    } catch (cause) {
      if (mounted.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not export pages.');
    } finally {
      if (controller.current === request) controller.current = null;
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <dialog ref={dialog} className="conversion-dialog" aria-labelledby="export-pages-title" aria-describedby="export-pages-description"
      onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
      }}>
      <form onSubmit={submit} aria-busy={busy}>
        <header><h2 id="export-pages-title">Export Pages</h2><button type="button" aria-label="Close page export dialog" onClick={close}>×</button></header>
        <p id="export-pages-description">Export selected pages with your current edits. Multiple images download as one ZIP file.</p>
        <fieldset disabled={busy}>
          <label>Export format<select ref={firstInput} aria-label="Export format" value={format} onChange={event => setFormat(event.target.value as PageExportSettings['format'])}>
            <option value="png">PNG images</option><option value="jpeg">JPEG images</option><option value="text">UTF-8 text</option>
          </select></label>
          <label>Page range<input aria-label="Page range" placeholder="All pages, or 1-3, 5" value={range} onChange={event => setRange(event.target.value)} aria-describedby="export-pages-range-help" /></label>
          <p className="conversion-hint" id="export-pages-range-help">Leave blank for all pages. Pages follow the listed order; duplicates are exported once.</p>
          {format !== 'text' && <label>Resolution<select aria-label="Resolution" value={dpi} onChange={event => setDpi(Number(event.target.value) as 150 | 300)}>
            <option value={150}>150 dpi</option><option value={300}>300 dpi</option>
          </select></label>}
          {format === 'jpeg' && <label>JPEG quality: {quality}%<input aria-label="JPEG quality" type="range" min="1" max="100" value={quality} onChange={event => setQuality(Number(event.target.value))} /></label>}
          <p className="conversion-hint">{format === 'text' ? 'Extracts existing text, including visible form values. Scanned pages need OCR first.' : 'Images use the visible page area, including its rotation, annotations, and form appearances.'}</p>
        </fieldset>
        {busy && <div className="conversion-progress" role="status" aria-live="polite">
          <progress max={progress?.total || 1} value={progress?.completed} />
          <span>{!progress ? 'Preparing current edits…' : progress.phase === 'archive' ? 'Building ZIP…' : `Processed ${progress.completed} of ${progress.total} pages`}</span>
        </div>}
        {error && <p className="conversion-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={close}>{busy ? 'Cancel export' : 'Cancel'}</button><button type="submit" className="conversion-primary" disabled={busy}>{busy ? 'Exporting…' : 'Export pages'}</button></footer>
      </form>
    </dialog>
  );
}
export default ExportPagesDialog;
