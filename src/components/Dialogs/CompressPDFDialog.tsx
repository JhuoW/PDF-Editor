import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inspectPDFOptimizationInWorker, optimizePDFInWorker } from '../../core/PDFOptimizerClient';
import { DEFAULT_OPTIMIZER_SETTINGS, type OptimizerInspection, type OptimizerProgress, type OptimizerResult, type OptimizerSettings } from '../../core/PDFOptimizerTypes';
import { DecorationPDFPreview } from './DecorationPDFPreview';
import type { CompressPDFDialogProps, CompressPDFSource } from './CompressPDFDialogTypes';
import './CompressPDFDialog.css';
export type { CompressPDFDialogProps, CompressPDFSource } from './CompressPDFDialogTypes';

const bytesLabel = (bytes: number) => `${bytes.toLocaleString()} bytes`;
function fileSize(bytes: number) {
  if (bytes < 1024) return bytesLabel(bytes);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
function progressLabel(progress: OptimizerProgress | null, compressing: boolean) {
  if (!progress) return compressing ? 'Preparing compression…' : 'Preparing current edits and analyzing the PDF…';
  const label = { inspect: 'Analyzing PDF', images: 'Optimizing images', save: 'Writing PDF', verify: 'Verifying result' }[progress.phase];
  return `${label}: ${progress.completed} / ${progress.total}`;
}
function downloadPDF(data: Uint8Array, name: string) {
  const safeName = Array.from(name.trim(), character => character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character).join('');
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
interface Loaded { key: object; source: CompressPDFSource; inspection: OptimizerInspection }

export function CompressPDFDialog(props: CompressPDFDialogProps) {
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision) {
    setSession({ key: props.documentKey, revision: props.revision, sequence: session.sequence + 1 }); return null;
  }
  return <CompressPDFSession key={session.sequence} {...props} />;
}
function CompressPDFSession({ currentPage, readPDF, onClose }: CompressPDFDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null), firstInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false), operation = useRef<AbortController | null>(null), readOperation = useRef<AbortController | null>(null);
  const downloadLatest = useRef<() => void>(() => {});
  const [retry, setRetry] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null);
  const loadKey = useMemo(() => ({ readPDF, retry }), [readPDF, retry]), activeKey = useRef(loadKey);
  const current = loaded?.key === loadKey ? loaded : null;
  const [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const [mode, setMode] = useState<OptimizerSettings['mode']>(DEFAULT_OPTIMIZER_SETTINGS.mode);
  const [dpi, setDpi] = useState<OptimizerSettings['dpi']>(DEFAULT_OPTIMIZER_SETTINGS.dpi), [quality, setQuality] = useState(DEFAULT_OPTIMIZER_SETTINGS.quality);
  const settings = useMemo<OptimizerSettings>(() => ({ mode, dpi, quality }), [mode, dpi, quality]), activeSettings = useRef(settings);
  const [pageNumber, setPageNumber] = useState(currentPage), [shown, setShown] = useState<'current' | 'compressed'>('current');
  const [zoom, setZoom] = useState('fit');
  const [fileName, setFileName] = useState('compressed.pdf'), [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState<OptimizerProgress | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<{ key: object; text: string } | null>(null);
  const [output, setOutput] = useState<{ source: Loaded; settings: OptimizerSettings; result: OptimizerResult } | null>(null);
  const result = output?.source === current && output.settings === settings ? output.result : null;
  const original = useMemo(() => current ? new Uint8Array(current.source.data) : null, [current]);
  const previewKey = useMemo(() => ({ current, result, pageNumber, zoom }), [current, result, pageNumber, zoom]);
  const [previewError, setPreviewError] = useState<{ key: object; message: string } | null>(null);
  const currentPreviewError = previewError?.key === previewKey ? previewError.message : null;
  const reading = !current && loadError?.key !== loadKey;
  const busy = reading || compressing;
  const canCompress = !!current?.inspection.canOptimize && !busy;
  const canDownload = !!result && !busy && !!fileName.trim() && !currentPreviewError;
  const warnings = [...new Set([...(current?.inspection.warnings ?? []), ...(result?.warnings ?? [])])];

  useLayoutEffect(() => { activeKey.current = loadKey; activeSettings.current = settings; });
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { mounted.current = false; readOperation.current?.abort(); operation.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const request = new AbortController(); readOperation.current = request;
    void (async () => {
      try {
        const source = await readPDF(request.signal);
        if (request.signal.aborted) return;
        const inspection = await inspectPDFOptimizationInWorker(source.data, { signal: request.signal, onProgress: value => { if (!request.signal.aborted) setProgress(value); } });
        if (request.signal.aborted) return;
        setLoaded({ key: loadKey, source, inspection }); setLoadError(null); setError(null); setProgress(null);
        setFileName(`${source.fileName.replace(/\.pdf$/i, '')}-compressed.pdf`);
        setPageNumber(previous => Math.max(1, Math.min(previous, inspection.pageCount)));
        requestAnimationFrame(() => { if (!request.signal.aborted) firstInput.current?.focus(); });
      } catch (cause) { if (!request.signal.aborted) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not analyze this PDF.' }); }
      finally { if (readOperation.current === request) readOperation.current = null; }
    })();
    return () => { request.abort(); operation.current?.abort(); };
  }, [loadKey, readPDF]);

  const close = () => { readOperation.current?.abort(); operation.current?.abort(); onClose(); };
  const compress = async () => {
    if (!canCompress || !current || operation.current) return;
    const request = new AbortController(); operation.current = request;
    setCompressing(true); setError(null); setNotice(null); setProgress(null);
    const valid = () => mounted.current && !request.signal.aborted && activeKey.current === loadKey && activeSettings.current === settings;
    try {
      const compressed = await optimizePDFInWorker(current.source.data, settings, { signal: request.signal, onProgress: value => { if (valid()) setProgress(value); } });
      if (!valid()) return;
      setOutput({ source: current, settings, result: compressed }); setShown('compressed');
    } catch (cause) { if (valid()) setError(cause instanceof Error ? cause.message : 'Could not compress this PDF.'); }
    finally {
      if (operation.current === request) {
        operation.current = null;
        if (mounted.current) { setCompressing(false); setProgress(null); if (request.signal.aborted) setNotice({ key: settings, text: 'Compression canceled. No file was downloaded.' }); }
      }
    }
  };
  const download = () => {
    if (!canDownload || !result || !mounted.current || activeKey.current !== loadKey || activeSettings.current !== settings) return;
    downloadPDF(result.data, fileName);
    setNotice({ key: settings, text: `Downloaded ${fileSize(result.outputBytes)}. Your open document and its history are unchanged.` });
  };
  useLayoutEffect(() => { downloadLatest.current = download; });
  return <dialog ref={dialog} className="compress-pdf-dialog" aria-labelledby="compress-pdf-title" aria-describedby="compress-pdf-description"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); downloadLatest.current(); } }}>
    <header><div><h2 id="compress-pdf-title">Compress PDF</h2><p id="compress-pdf-description">Save a smaller copy with your current edits. Text remains searchable; existing PDF forms and annotations are preserved.</p></div><button type="button" aria-label="Close PDF compression" onClick={close}>×</button></header>
    {loadError?.key === loadKey ? <div className="compress-loading"><p role="alert" className="compress-error">{loadError.message}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry analysis</button></div>
      : <div className="compress-body">
        <section className="compress-settings" aria-label="Compression settings">
          <fieldset disabled={busy || !current?.inspection.canOptimize}>
            <fieldset className="compress-modes"><legend>Compression mode</legend>
              <label><input ref={firstInput} type="radio" name="compression-mode" value="lossless" checked={mode === 'lossless'} onChange={() => setMode('lossless')} />Lossless</label>
              <label><input type="radio" name="compression-mode" value="images" checked={mode === 'images'} onChange={() => setMode('images')} />Optimize images</label>
            </fieldset>
            <p className="compress-help">{mode === 'lossless' ? 'Rewrites and compresses PDF structures without reducing image quality.' : 'Reduces eligible image resolution and uses JPEG compression. Fine details and image quality may change; compare the previews before downloading.'}</p>
            {mode === 'images' && <><label>Image resolution<select value={dpi} onChange={event => setDpi(Number(event.target.value) as OptimizerSettings['dpi'])}><option value={150}>150 dpi</option><option value={200}>200 dpi</option><option value={300}>300 dpi</option></select></label>
              <label>JPEG quality: {quality}%<input aria-label="JPEG quality" type="range" min={1} max={100} value={quality} onChange={event => setQuality(Number(event.target.value))} /></label>
              <p className="compress-help">Some images must stay unchanged to preserve transparency, color, form appearances, or editable decorations.</p></>}
            <label>PDF file name<input value={fileName} onChange={event => setFileName(event.target.value)} /></label>
          </fieldset>
          {current && <><p className="compress-help">{current.inspection.pageCount} {current.inspection.pageCount === 1 ? 'page' : 'pages'} · {current.inspection.imageCount} image resources · {current.inspection.eligibleImageCount} eligible for image optimization.</p>
            {!current.inspection.canOptimize && <p role="alert" className="compress-notice">{current.inspection.unsupportedReason || 'This PDF cannot be compressed safely.'}</p>}
            <dl className="compress-sizes"><div><dt>Current PDF</dt><dd>{fileSize(current.inspection.inputBytes)}<small>{bytesLabel(current.inspection.inputBytes)}</small></dd></div><div><dt>Compressed copy</dt><dd>{result ? <>{fileSize(result.outputBytes)}<small>{bytesLabel(result.outputBytes)}</small></> : '—'}</dd></div></dl></>}
          {result && <>{result.changed && result.outputBytes < result.inputBytes ? <p role="status" className="compress-savings">{((result.inputBytes - result.outputBytes) / result.inputBytes * 100).toFixed(1)}% smaller · saved {fileSize(result.inputBytes - result.outputBytes)}</p>
            : <p role="status" className="compress-notice">No size reduction with these settings. The download keeps the current PDF without increasing its size.</p>}
            <p className="compress-help">{result.imagesOptimized} images optimized · {result.imagesDeduplicated} duplicate image resources merged · {result.imagesSkipped} images kept unchanged.</p></>}
          {warnings.length > 0 && <details><summary>Compression notes ({warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          <p className="compress-help">Compression creates a separate copy. Your open document and undo history are not changed.</p>
        </section>
        <section className="compress-preview" aria-label="Compression preview">
          <div className="compress-preview-toolbar"><label>Preview page<select value={pageNumber} disabled={!current} onChange={event => setPageNumber(Number(event.target.value))}>{Array.from({ length: current?.inspection.pageCount ?? 1 }, (_, index) => <option key={index} value={index + 1}>Page {index + 1}</option>)}</select></label>
            <label>Preview zoom<select value={zoom} disabled={!current} onChange={event => setZoom(event.target.value)}><option value="fit">Fit width</option><option value="1">100%</option><option value="2">200%</option></select></label>
            <div className="compress-preview-switch"><button type="button" aria-pressed={shown === 'current'} onClick={() => setShown('current')}>Current</button><button type="button" aria-pressed={shown === 'compressed'} disabled={!result} onClick={() => setShown('compressed')}>Compressed</button></div></div>
          <div className="compress-preview-pages"><section className="compress-preview-page" aria-label="Current PDF preview" data-active={shown === 'current'}><h3>Current PDF</h3>
            {original ? <DecorationPDFPreview data={original} pageNumber={pageNumber} scale={zoom === 'fit' ? undefined : Number(zoom)} onError={message => setPreviewError({ key: previewKey, message })} /> : <p className="compress-preview-empty">The current PDF will appear after analysis.</p>}</section>
            <section className="compress-preview-page" aria-label="Compressed PDF preview" data-active={shown === 'compressed'}><h3>Compressed copy</h3>
              {result ? <DecorationPDFPreview data={result.data} pageNumber={pageNumber} scale={zoom === 'fit' ? undefined : Number(zoom)} onError={message => setPreviewError({ key: previewKey, message })} /> : <p className="compress-preview-empty">Choose settings and compress to preview the exact PDF that will be downloaded.</p>}</section></div>
        </section>
      </div>}
    <footer>{busy && <div className="compress-progress" role="status"><progress max={progress?.total || 1} value={progress?.completed} /><span>{progressLabel(progress, compressing)}</span></div>}
      {result && !busy && <p role="status">Compression ready</p>}
      {(error || currentPreviewError) && <p role="alert" className="compress-error">{error || currentPreviewError}</p>}
      {notice?.key === settings && <p role="status">{notice.text}</p>}
      <div><button type="button" onClick={() => { if (compressing) operation.current?.abort(); else close(); }}>{compressing ? 'Cancel compression' : reading ? 'Cancel analysis' : 'Close'}</button>
        <button type="button" disabled={!canCompress} onClick={() => void compress()}>{compressing ? 'Compressing…' : 'Compress PDF'}</button><button type="button" className="compress-primary" disabled={!canDownload} onClick={download}>Download PDF</button></div>
    </footer>
  </dialog>;
}
export default CompressPDFDialog;
