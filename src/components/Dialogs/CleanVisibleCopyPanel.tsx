import { useEffect, useMemo, useRef, useState } from 'react';
import { createVisibleCopyInWorker, inspectVisibleCopyInWorker } from '../../core/VisibleCopyClient';
import { DEFAULT_VISIBLE_COPY_SETTINGS, type VisibleCopyInspection, type VisibleCopyProgress, type VisibleCopyResult, type VisibleCopySettings } from '../../core/VisibleCopyTypes';
import { DecorationPDFPreview } from './DecorationPDFPreview';
import type { CleanDocumentSource } from './CleanDocumentDialogTypes';

interface Props { source: CleanDocumentSource; currentPage: number; active: boolean; onClose: () => void; onBusy: (busy: boolean) => void }
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function progressLabel(progress: VisibleCopyProgress | null) {
  if (!progress) return 'Preparing visible pages…';
  return `${{ inspect: 'Checking', render: 'Rendering', verify: 'Verifying', save: 'Saving' }[progress.phase]} ${progress.completed} of ${progress.total} pages`;
}
function downloadCopy(data: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = fileName;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CleanVisibleCopyPanel({ source, currentPage, active, onClose, onBusy }: Props) {
  const mounted = useRef(false), isActive = useRef(active), onBusyRef = useRef(onBusy);
  const generation = useRef<AbortController | null>(null);
  const cache = useRef<{ data: ArrayBuffer; dpi: number; inspection: VisibleCopyInspection } | null>(null);
  const [read, setRead] = useState<{ source: CleanDocumentSource; data?: ArrayBuffer; error?: string } | null>(null);
  const [reload, setReload] = useState(0), [pageNumber, setPageNumber] = useState(currentPage);
  const [dpi, setDpi] = useState<150 | 300>(DEFAULT_VISIBLE_COPY_SETTINGS.dpi);
  const [compression, setCompression] = useState<VisibleCopySettings['compression']>(DEFAULT_VISIBLE_COPY_SETTINGS.compression);
  const [quality, setQuality] = useState(DEFAULT_VISIBLE_COPY_SETTINGS.quality ?? 90);
  const [fileName, setFileName] = useState(`${source.fileName.replace(/\.pdf$/i, '')}-visible-copy.pdf`);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<VisibleCopyProgress | null>(null);
  const [error, setError] = useState<string | null>(null), [success, setSuccess] = useState<string | null>(null);
  const data = read?.source === source ? read.data : undefined;
  const settings = useMemo<VisibleCopySettings>(() => ({ dpi, compression, ...(compression === 'jpeg' ? { quality } : {}) }), [dpi, compression, quality]);
  const previewKey = useMemo(() => ({ data, settings, pageNumber, reload }), [data, settings, pageNumber, reload]);
  const [preview, setPreview] = useState<{ key: object; inspection?: VisibleCopyInspection; result?: VisibleCopyResult; error?: string } | null>(null);
  const current = preview?.key === previewKey ? preview : null;
  const canGenerate = active && !busy && !source.pendingRedactions && !!data && !!current?.result && !!fileName.trim();
  useEffect(() => { isActive.current = active; onBusyRef.current = onBusy; if (!active) generation.current?.abort(); }, [active, onBusy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = generation.current;
      generation.current = null;
      request?.abort();
      if (request) onBusyRef.current(false);
    };
  }, []);
  useEffect(() => {
    if (!active || source.pendingRedactions || data) return;
    const request = new AbortController();
    void source.readVisiblePDF(request.signal).then(value => { if (!request.signal.aborted) setRead({ source, data: value }); }, cause => {
      if (!request.signal.aborted) setRead({ source, error: cause instanceof Error ? cause.message : 'Could not prepare visible pages.' });
    });
    return () => request.abort();
  }, [active, source, data, reload]);
  useEffect(() => {
    if (!active || !data || source.pendingRedactions) return;
    const request = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const inspection = cache.current?.data === data && cache.current.dpi === settings.dpi ? cache.current.inspection : await inspectVisibleCopyInWorker(data, settings, { signal: request.signal });
        if (request.signal.aborted) return;
        cache.current = { data, dpi: settings.dpi, inspection }; setPreview({ key: previewKey, inspection });
        const result = await createVisibleCopyInWorker(data, settings, { previewPage: pageNumber, signal: request.signal });
        if (!request.signal.aborted) setPreview({ key: previewKey, inspection, result });
      } catch (cause) { if (!request.signal.aborted) setPreview({ key: previewKey, error: cause instanceof Error ? cause.message : 'Could not create the visible-page preview.' }); }
    })(); }, 200);
    return () => { clearTimeout(timer); request.abort(); };
  }, [active, data, settings, previewKey, pageNumber, source.pendingRedactions]);
  const generate = async () => {
    if (!canGenerate || generation.current || !data) return;
    const request = new AbortController(); generation.current = request;
    setBusy(true); onBusyRef.current(true); setProgress(null); setError(null); setSuccess(null);
    try {
      const result = await createVisibleCopyInWorker(data, settings, { signal: request.signal, onProgress: value => { if (mounted.current && !request.signal.aborted) setProgress(value); } });
      if (!mounted.current || !isActive.current || request.signal.aborted) return;
      const name = Array.from(fileName.trim(), character => character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character).join('');
      downloadCopy(result.data, /\.pdf$/i.test(name) ? name : `${name}.pdf`);
      setSuccess(`Downloaded ${result.pageCount} pages · ${size(result.data.byteLength)}. Your open document is unchanged.`);
    } catch (cause) { if (mounted.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not create the visible copy.'); }
    finally {
      if (generation.current === request) {
        generation.current = null;
        onBusyRef.current(false);
        if (mounted.current) { setBusy(false); if (request.signal.aborted) setSuccess('Generation canceled. No file was downloaded.'); }
      }
    }
  };
  const inspected = current?.inspection, sample = current?.result;
  const samplePixels = inspected?.pages.find(page => page.pageNumber === pageNumber)?.pixels;
  const estimate = sample && samplePixels && inspected ? sample.encodedImageBytes * inspected.totalPixels / samplePixels : null;
  return <section role="tabpanel" id="clean-visible-panel" aria-labelledby="clean-visible-tab" className="clean-panel" hidden={!active}>
    <div className="clean-body">
      <div className="clean-settings">
        <h3>Save a visible pages copy</h3>
        <p className="clean-notice">Creates a new PDF containing page images only. Text cannot be searched or copied. Forms and links are no longer interactive, and digital signatures are not retained.</p>
        <p className="clean-help">All pages and their current visible edits are included. Visible sensitive information stays visible. Your open document and its history remain unchanged.</p>
        {source.pendingRedactions > 0 && <p role="alert" className="clean-error">Apply or discard the {source.pendingRedactions} marked content {source.pendingRedactions === 1 ? 'area' : 'areas'} before creating a visible copy.</p>}
        <fieldset disabled={busy || !!source.pendingRedactions}>
          <label>Resolution<select value={dpi} onChange={event => setDpi(Number(event.target.value) as 150 | 300)}><option value={150}>150 dpi</option><option value={300}>300 dpi</option></select></label>
          <label>Image compression<select value={compression} onChange={event => setCompression(event.target.value as VisibleCopySettings['compression'])}><option value="lossless">Lossless</option><option value="jpeg">JPEG (smaller file)</option></select></label>
          {compression === 'jpeg' && <label>JPEG quality: {quality}%<input aria-label="JPEG quality" type="range" min={1} max={100} value={quality} onChange={event => setQuality(Number(event.target.value))} /></label>}
          <label>PDF file name<input value={fileName} onChange={event => setFileName(event.target.value)} /></label>
        </fieldset>
        {inspected && <p className="clean-size">{inspected.pageCount} pages · {(inspected.totalPixels / 1_000_000).toFixed(1)} megapixels at {dpi} dpi.</p>}
        {sample && <p className="clean-size">Preview page PDF: {size(sample.data.byteLength)}.{estimate !== null && <> Rough total estimate: {size(estimate)}.</>}</p>}
        {estimate !== null && <p className="clean-help">The estimate uses this preview page's image size. Different page content can make the final file much smaller or larger.</p>}
        {!!inspected?.warnings.length && <details className="clean-font-warnings"><summary>Font substitutions ({inspected.warnings.length}{inspected.warningsTruncated ? '+' : ''})</summary><p className="clean-help">Review the affected pages: substitute fonts can change their appearance.</p><ul>{inspected.warnings.map((warning, index) => <li key={index}>Page {warning.pageNumber} · {warning.fontName}: {warning.message}</li>)}</ul>{inspected.warningsTruncated && <p>Additional substitutions are not listed.</p>}</details>}
        {read?.source === source && read.error && <><p role="alert" className="clean-error">{read.error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry</button></>}
      </div>
      <div className="clean-preview" aria-label="Visible copy preview">
        <div className="clean-preview-toolbar"><label>Copy preview page<select value={pageNumber} disabled={busy || !inspected} onChange={event => setPageNumber(Number(event.target.value))}>{(inspected?.pages ?? [{ pageNumber }]).map(page => <option key={page.pageNumber} value={page.pageNumber}>Page {page.pageNumber}</option>)}</select></label>
          {!source.pendingRedactions && !read?.error && <p role="status">{sample ? 'Visible copy preview ready' : 'Preparing image-only preview…'}</p>}</div>
        {sample && <DecorationPDFPreview data={sample.data} pageNumber={1} onError={message => setPreview({ key: previewKey, error: message })} />}
        {current?.error && <p role="alert" className="clean-error">{current.error}</p>}
      </div>
    </div>
    <footer>{busy && <div className="clean-progress" role="status"><progress max={progress?.total || 1} value={progress?.completed} /><span>{progressLabel(progress)}</span></div>}
      {error && <p role="alert" className="clean-error">{error}</p>}{success && <p role="status">{success}</p>}
      <div><button type="button" onClick={() => { if (busy) generation.current?.abort(); else onClose(); }}>{busy ? 'Cancel generation' : 'Close'}</button><button type="button" className="clean-primary" disabled={!canGenerate} onClick={() => void generate()}>Download image-only PDF</button></div>
    </footer>
  </section>;
}
