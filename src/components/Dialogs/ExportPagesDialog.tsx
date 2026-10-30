import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError } from "../../i18n";
import { useEffect, useRef, useState } from 'react';
import { downloadPageExport, exportPagesInWorker } from '../../core/PageExportClient';
import { parseExportPageRange, type PageExportProgress, type PageExportSettings } from '../../core/PageExport';
import './ConversionDialog.css';

interface ExportPagesDialogProps {
  readPDF: () => Promise<{ data: Uint8Array | ArrayBuffer; fileName: string }>;
  onClose: () => void;
  imagesOnly?: boolean;
  totalPages?: number;
  currentPage?: number;
  selectedPages?: number[];
}

type PageScope = 'all' | 'current' | 'selection' | 'custom';

export function ExportPagesDialog({ readPDF, onClose, imagesOnly = false, totalPages, currentPage = 1, selectedPages = [] }: ExportPagesDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstInput = useRef<HTMLSelectElement>(null);
  const mounted = useRef(false), submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [format, setFormat] = useState<PageExportSettings['format']>('png');
  const [range, setRange] = useState('');
  const [scope, setScope] = useState<PageScope>('all');
  const [rangeAttempted, setRangeAttempted] = useState(false);
  const [dpi, setDpi] = useState<150 | 300>(150);
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PageExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selection = [...new Set(selectedPages.filter(page => Number.isInteger(page) && page > 0 && (totalPages === undefined || page <= totalPages)))].sort((a, b) => a - b);
  const exportRange = scope === 'current' ? String(currentPage) : scope === 'selection' ? selection.join(',') : scope === 'custom' ? range : '';
  let pages: number[] | null = null;
  let rangeError: string | null = null;
  try {
    if (scope === 'custom' && !range.trim()) throw new Error('Enter at least one page number or range.');
    if (scope === 'selection' && !selection.length) throw new Error('Select pages in the thumbnail sidebar first.');
    if (totalPages !== undefined) pages = parseExportPageRange(exportRange, totalPages);
  } catch (cause) {
    rangeError = (cause as Error).message;
  }
  const visibleRangeError = Boolean(rangeError && (rangeAttempted || (scope === 'custom' && range.trim()) || scope === 'selection'));
  const chooseScope = (value: PageScope) => { setScope(value); setRangeAttempted(false); setError(null); };
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
    if (rangeError) { setRangeAttempted(true); return; }
    submitting.current = true;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(null); setProgress(null);
    try {
      const source = await readPDF();
      if (!mounted.current || request.signal.aborted) return;
      const result = await exportPagesInWorker(source.data, { format, range: exportRange, dpi, quality, fileName: source.fileName }, {
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
    <dialog ref={dialog} className="conversion-dialog page-export-dialog" aria-labelledby="export-pages-title" aria-describedby="export-pages-description"
      onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
      }}>
      <form onSubmit={submit} aria-busy={busy}>
        <header><h2 id="export-pages-title">{imagesOnly ? t('pdf.images.title') : t("m.export.pages.93a12e")}</h2><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.page.export.dialog.54da7b")} onClick={close}>×</button></header>
        <p id="export-pages-description">{imagesOnly ? t('pdf.images.description') : t("m.export.selected.pages.with.your.current.edits.mu.752b04")}</p>
        <fieldset disabled={busy}>
          <label>{t("m.export.format.483a5d")}<select ref={firstInput} aria-label={t("m.export.format.483a5d")} value={format} onChange={event => setFormat(event.target.value as PageExportSettings['format'])}>
            <option value="png">{t("m.png.images.66f5d9")}</option><option value="jpeg">{t("m.jpeg.images.1eed6d")}</option>{!imagesOnly && <option value="text">{t("m.utf.8.text.0f62e2")}</option>}
          </select></label>
          {imagesOnly && totalPages !== undefined && <fieldset className="page-export-scope">
            <legend>{t('pdf.images.pages')}</legend>
            <div className="page-export-choices">
              {([
                ['all', t('pdf.images.all', { count: totalPages })],
                ['current', t('pdf.images.current', { page: currentPage })],
                ['selection', t('pdf.images.selected', { count: selection.length })],
                ['custom', t('pdf.images.custom')],
              ] as const).map(([value, label]) => <label key={value} className={scope === value ? 'is-selected' : undefined}>
                <input type="radio" name="export-page-scope" value={value} checked={scope === value} disabled={value === 'selection' && !selection.length} onChange={() => chooseScope(value)} />
                <span>{label}</span>
              </label>)}
            </div>
            {!selection.length && <p className="conversion-hint">{t('pdf.images.selection.help')}</p>}
          </fieldset>}
          {(!imagesOnly || scope === 'custom') && <>
            <label>{t("m.page.range.57245e")}<input aria-label={t("m.page.range.57245e")} placeholder={imagesOnly ? t('pdf.images.range.example') : t("m.all.pages.or.1.3.5.359452")} value={range} onChange={event => {
              setRange(event.target.value); chooseScope(imagesOnly || event.target.value.trim() ? 'custom' : 'all');
            }} aria-invalid={visibleRangeError ? true : undefined} aria-describedby={`export-pages-range-help${visibleRangeError ? ' export-pages-range-error' : ''}`} /></label>
            <p className="conversion-hint" id="export-pages-range-help">{imagesOnly ? t('pdf.images.range.help') : t("m.leave.blank.for.all.pages.pages.follow.the.liste.deab9c")}</p>
          </>}
          {visibleRangeError && <p className="conversion-error" id="export-pages-range-error" role="alert">{translateError(rangeError)}</p>}
          {format !== 'text' && <label>{t("m.resolution.516aae")}<select aria-label={t("m.resolution.516aae")} value={dpi} onChange={event => setDpi(Number(event.target.value) as 150 | 300)}>
            <option value={150}>{t("m.150.dpi.88e3c1")}</option><option value={300}>{t("m.300.dpi.c735d3")}</option>
          </select></label>}
          {format === 'jpeg' && <label>{t("m.jpeg.quality.8fba9c")}{' '}{quality}%<input aria-label={t("m.jpeg.quality.e85408")} type="range" min="1" max="100" value={quality} onChange={event => setQuality(Number(event.target.value))} /></label>}
          <p className="conversion-hint">{format === 'text' ? t("m.extracts.existing.text.including.visible.form.va.444490") : t("m.images.use.the.visible.page.area.including.its.r.9117b8")}</p>
          {pages && !busy && <div className="page-export-summary" role="status" aria-live="polite">
            <strong>{t('pdf.images.count', { count: pages.length, total: totalPages })}</strong>
            {format !== 'text' && <span>{pages.length === 1 ? t('pdf.images.single') : t('pdf.images.multiple')}</span>}
          </div>}
        </fieldset>
        {busy && <div className="conversion-progress" role="status" aria-live="polite">
          <progress max={progress?.total || 1} value={progress?.completed} />
          <span>{!progress ? t("m.preparing.current.edits.7a228e") : progress.phase === 'archive' ? t("m.building.zip.c74536") : t("m.processed.of.pages.180e95", { v0: progress.completed, v1: progress.total })}</span>
        </div>}
        {error && <p className="conversion-error" role="alert">{translateError(error)}</p>}
        <footer><button type="button" onClick={close}>{busy ? t("m.cancel.export.aefe72") : t("m.cancel.77dfd2")}</button><button type="submit" className="conversion-primary" disabled={busy}>{busy ? t("m.exporting.583ccc") : imagesOnly ? t('pdf.images.convert') : t("m.export.pages.d4dc1c")}</button></footer>
      </form>
    </dialog>
  );
}
export default ExportPagesDialog;
