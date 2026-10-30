import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { currentLocale, useLocale, t, translateMessage , translateError } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inspectPDFOptimizationInWorker, optimizePDFInWorker } from '../../core/PDFOptimizerClient';
import { DEFAULT_OPTIMIZER_SETTINGS, type OptimizerInspection, type OptimizerProgress, type OptimizerResult, type OptimizerSettings } from '../../core/PDFOptimizerTypes';
import { DecorationPDFPreview } from './DecorationPDFPreview';
import type { CompressPDFDialogProps, CompressPDFSource } from './CompressPDFDialogTypes';
import './CompressPDFDialog.css';
export type { CompressPDFDialogProps, CompressPDFSource } from './CompressPDFDialogTypes';

const bytesLabel = (bytes: number) => `${bytes.toLocaleString(currentLocale())} bytes`;
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
  useLocale();
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision) {
    setSession({ key: props.documentKey, revision: props.revision, sequence: session.sequence + 1 }); return null;
  }
  return <CompressPDFSession key={session.sequence} {...props} />;
}
function CompressPDFSession({ currentPage, readPDF, onClose }: CompressPDFDialogProps) {
  useLocale();
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
    <header><div><h2 id="compress-pdf-title">{t("m.compress.pdf.c81566")}</h2><p id="compress-pdf-description">{t("m.save.a.smaller.copy.with.your.current.edits.text.96c760")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.pdf.compression.a00867")} onClick={close}>×</button></header>
    {loadError?.key === loadKey ? <div className="compress-loading"><p role="alert" className="compress-error">{translateError(loadError.message)}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("m.retry.analysis.b6d531")}</button></div>
      : <div className="compress-body">
        <section className="compress-settings" aria-label={t("m.compression.settings.6784ba")}>
          <fieldset disabled={busy || !current?.inspection.canOptimize}>
            <fieldset className="compress-modes"><legend>{t("m.compression.mode.89c7f4")}</legend>
              <label><input ref={firstInput} type="radio" name="compression-mode" value="lossless" checked={mode === 'lossless'} onChange={() => setMode('lossless')} />{t("m.lossless.f3b36f")}</label>
              <label><input type="radio" name="compression-mode" value="images" checked={mode === 'images'} onChange={() => setMode('images')} />{t("m.optimize.images.b849c3")}</label>
            </fieldset>
            <p className="compress-help">{mode === 'lossless' ? t("m.rewrites.and.compresses.pdf.structures.without.r.aaa62c") : t("m.reduces.eligible.image.resolution.and.uses.jpeg..10f392")}</p>
            {mode === 'images' && <><label>{t("m.image.resolution.ddd8f4")}<select value={dpi} onChange={event => setDpi(Number(event.target.value) as OptimizerSettings['dpi'])}><option value={150}>{t("m.150.dpi.88e3c1")}</option><option value={200}>{t("m.200.dpi.1d6ea3")}</option><option value={300}>{t("m.300.dpi.c735d3")}</option></select></label>
              <label>{t("m.jpeg.quality.8fba9c")}{' '}{quality}%<input aria-label={t("m.jpeg.quality.e85408")} type="range" min={1} max={100} value={quality} onChange={event => setQuality(Number(event.target.value))} /></label>
              <p className="compress-help">{t("m.some.images.must.stay.unchanged.to.preserve.tran.13c3c9")}</p></>}
            <label>{t("m.pdf.file.name.917f85")}<input value={fileName} onChange={event => setFileName(event.target.value)} /></label>
          </fieldset>
          {current && <><p className="compress-help">{current.inspection.pageCount} {current.inspection.pageCount === 1 ? t("m.page.767013") : t("m.pages.eec654")} · {t("m.image.resources.eligible.for.image.optimization.fdc8ca", { v0: current.inspection.imageCount, v1: current.inspection.eligibleImageCount })}</p>
            {!current.inspection.canOptimize && <p role="alert" className="compress-notice">{translateError(current.inspection.unsupportedReason) || t("m.this.pdf.cannot.be.compressed.safely.968d40")}</p>}
            <dl className="compress-sizes"><div><dt>{t("m.current.pdf.3c39ba")}</dt><dd>{fileSize(current.inspection.inputBytes)}<small>{translateMessage(bytesLabel(current.inspection.inputBytes))}</small></dd></div><div><dt>{t("m.compressed.copy.5b4ae1")}</dt><dd>{result ? <>{fileSize(result.outputBytes)}<small>{translateMessage(bytesLabel(result.outputBytes))}</small></> : '—'}</dd></div></dl></>}
          {result && <>{result.changed && result.outputBytes < result.inputBytes ? <p role="status" className="compress-savings">{((result.inputBytes - result.outputBytes) / result.inputBytes * 100).toFixed(1)}{t("m.smaller.saved.9a9407")}{' '}{fileSize(result.inputBytes - result.outputBytes)}</p>
            : <p role="status" className="compress-notice">{t("m.no.size.reduction.with.these.settings.the.downlo.7ac16f")}</p>}
            <p className="compress-help">{result.imagesOptimized}{' '}{t("m.images.optimized.b37bd2")}{' '}{result.imagesDeduplicated}{' '}{t("m.duplicate.image.resources.merged.bf56c9")}{' '}{result.imagesSkipped}{' '}{t("m.images.kept.unchanged.c6a2a2")}</p></>}
          {warnings.length > 0 && <details><summary>{t("m.compression.notes.8c975f")}{warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{translateMessage(warning)}</li>)}</ul></details>}
          <p className="compress-help">{t("m.compression.creates.a.separate.copy.your.open.do.257581")}</p>
        </section>
        <section className="compress-preview" aria-label={t("m.compression.preview.d0d78b")}>
          <div className="compress-preview-toolbar"><label>{t("m.preview.page.d24958")}<select value={pageNumber} disabled={!current} onChange={event => setPageNumber(Number(event.target.value))}>{Array.from({ length: current?.inspection.pageCount ?? 1 }, (_, index) => <option key={index} value={index + 1}>{t("m.page.fb0627")}{' '}{index + 1}</option>)}</select></label>
            <label>{t("m.preview.zoom.e32787")}<select value={zoom} disabled={!current} onChange={event => setZoom(event.target.value)}><option value="fit">{t("m.fit.width.0071b9")}</option><option value="1">100%</option><option value="2">200%</option></select></label>
            <div className="compress-preview-switch"><button type="button" aria-pressed={shown === 'current'} onClick={() => setShown('current')}>{t("m.current.4fc0e2")}</button><button type="button" aria-pressed={shown === 'compressed'} disabled={!result} onClick={() => setShown('compressed')}>{t("m.compressed.1238ea")}</button></div></div>
          <div className="compress-preview-pages"><section className="compress-preview-page" aria-label={t("m.current.pdf.preview.5c35aa")} data-active={shown === 'current'}><h3>{t("m.current.pdf.3c39ba")}</h3>
            {original ? <DecorationPDFPreview data={original} pageNumber={pageNumber} scale={zoom === 'fit' ? undefined : Number(zoom)} onError={message => setPreviewError({ key: previewKey, message })} /> : <p className="compress-preview-empty">{t("m.the.current.pdf.will.appear.after.analysis.ce1ec8")}</p>}</section>
            <section className="compress-preview-page" aria-label={t("m.compressed.pdf.preview.6c194a")} data-active={shown === 'compressed'}><h3>{t("m.compressed.copy.5b4ae1")}</h3>
              {result ? <DecorationPDFPreview data={result.data} pageNumber={pageNumber} scale={zoom === 'fit' ? undefined : Number(zoom)} onError={message => setPreviewError({ key: previewKey, message })} /> : <p className="compress-preview-empty">{t("m.choose.settings.and.compress.to.preview.the.exac.d61462")}</p>}</section></div>
        </section>
      </div>}
    <footer>{busy && <div className="compress-progress" role="status"><progress max={progress?.total || 1} value={progress?.completed} /><span>{translateMessage(progressLabel(progress, compressing))}</span></div>}
      {result && !busy && <p role="status">{t("m.compression.ready.c2b036")}</p>}
      {(error || currentPreviewError) && <p role="alert" className="compress-error">{error || translateError(currentPreviewError)}</p>}
      {notice?.key === settings && <p role="status">{translateMessage(notice.text)}</p>}
      <div><button type="button" onClick={() => { if (compressing) operation.current?.abort(); else close(); }}>{compressing ? t("m.cancel.compression.55312d") : reading ? t("m.cancel.analysis.df18d1") : t("m.close.bbfa77")}</button>
        <button type="button" disabled={!canCompress} onClick={() => void compress()}>{compressing ? t("m.compressing.84c5e4") : t("m.compress.pdf.c81566")}</button><button type="button" className="compress-primary" disabled={!canDownload} onClick={download}>{t("m.download.pdf.98e5ef")}</button></div>
    </footer>
  </dialog>;
}
export default CompressPDFDialog;
