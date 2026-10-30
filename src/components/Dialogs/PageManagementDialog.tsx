import { useEffect, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { parseExportPageRange } from '../../core/PageExport';
import { t, translateError, useLocale } from '../../i18n';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import './ConversionDialog.css';
import './PageManagementDialog.css';

export type PageManagementAction = 'duplicate' | 'extract' | 'replace' | 'crop';
export interface PageManagementRequest {
  action: PageManagementAction;
  pages: number[];
  beforePage?: number;
  source?: { data: ArrayBuffer; pages: number[] };
  margins?: { top: number; right: number; bottom: number; left: number };
  resetCrop?: boolean;
}
interface PageManagementDialogProps {
  action: PageManagementAction;
  totalPages: number;
  currentPage: number;
  selectedPages: number[];
  onClose: () => void;
  onRun: (request: PageManagementRequest, signal: AbortSignal, onCommit: () => void) => Promise<void>;
}
const mmToPoints = 72 / 25.4;
const sides = ['top', 'right', 'bottom', 'left'] as const;
function pageRange(value: string, count: number): number[] {
  if (!value.trim()) throw new Error('Enter at least one page number or range.');
  return parseExportPageRange(value, count);
}

export default function PageManagementDialog({ action, totalPages, currentPage, selectedPages, onClose, onRun }: PageManagementDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), firstInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false), submitting = useRef(false), fileJob = useRef(0);
  const committing = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [range, setRange] = useState(() => (selectedPages.length ? selectedPages : [currentPage]).join(', '));
  const [destination, setDestination] = useState('after');
  const [beforePage, setBeforePage] = useState(String(currentPage));
  const [source, setSource] = useState<{ data: ArrayBuffer; count: number; name: string } | null>(null);
  const [sourceRange, setSourceRange] = useState('');
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [commitStarted, setCommitStarted] = useState(false);
  const [margins, setMargins] = useState({ top: '0', right: '0', bottom: '0', left: '0' });
  const [resetCrop, setResetCrop] = useState(false);
  const [attempted, setAttempted] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    firstInput.current?.focus();
    return () => { mounted.current = false; controller.current?.abort(); element?.close(); };
  }, []);
  const close = () => { if (committing.current) return; fileJob.current++; controller.current?.abort(); onClose(); };
  let request: PageManagementRequest | null = null, validation: string | null = null;
  let pages: number[] = [], replacementPages: number[] = [];
  try {
    pages = pageRange(range, totalPages);
    request = { action, pages };
    if (action === 'duplicate') {
      const position = destination === 'end' ? 0 : destination === 'before' ? currentPage : destination === 'after' ? currentPage + 1 : Number(beforePage);
      if (destination === 'custom' && !beforePage.trim() || !Number.isInteger(position) || position < 0 || position > totalPages + 1) throw new Error('Choose a valid insertion page.');
      if (destination === 'custom' && position === 0) throw new Error('Choose a valid insertion page.');
      request.beforePage = position;
    }
    if (action === 'replace') {
      if (!source) throw new Error('Choose a replacement PDF first.');
      replacementPages = pageRange(sourceRange, source.count);
      if (replacementPages.length !== pages.length) throw new Error('Select the same number of original and replacement pages.');
      request.source = { data: source.data, pages: replacementPages };
    }
    if (action === 'crop') {
      request.resetCrop = resetCrop;
      const values = Object.fromEntries(sides.map(side => [side, Number(margins[side])])) as Record<typeof sides[number], number>;
      if (!resetCrop && sides.some(side => !margins[side].trim() || !Number.isFinite(values[side]) || values[side] < 0 || values[side] > 10_000)) throw new Error('Enter nonnegative crop margins in millimeters.');
      if (!resetCrop && sides.every(side => values[side] === 0)) throw new Error('Set at least one crop margin, or choose Restore full page.');
      if (!resetCrop) request.margins = Object.fromEntries(sides.map(side => [side, values[side] * mmToPoints])) as PageManagementRequest['margins'];
    }
  } catch (cause) { validation = (cause as Error).message; }
  const selectSource = async (file: File | undefined) => {
    if (!file) return;
    const job = ++fileJob.current;
    setSource(null); setSourceRange(''); setError(null); setReading(true); setAttempted(false);
    try {
      if (file.size > 256 * 1024 * 1024) throw new Error('Replacement PDFs must be smaller than 256 MB.');
      const data = await file.arrayBuffer();
      const pdf = await PDFDocument.load(data);
      if (pdf.isEncrypted) throw new Error('Unlock the replacement PDF before selecting it.');
      const count = pdf.getPageCount();
      if (!count) throw new Error('The PDF has no readable pages.');
      if (!mounted.current || job !== fileJob.current) return;
      setSource({ data, count, name: file.name });
      setSourceRange(Array.from({ length: Math.min(count, pages.length || 1) }, (_, index) => index + 1).join(', '));
    } catch (cause) {
      if (mounted.current && job === fileJob.current) setError(cause instanceof Error && /encrypted/i.test(cause.message)
        ? 'Unlock the replacement PDF before selecting it.' : cause instanceof Error && cause.message === 'Replacement PDFs must be smaller than 256 MB.'
          ? cause.message : 'Could not read the replacement PDF. Choose a valid, unlocked PDF.');
    } finally { if (mounted.current && job === fileJob.current) setReading(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || reading) return;
    setAttempted(true);
    if (validation || !request) return;
    submitting.current = true; setBusy(true); setError(null);
    const pending = new AbortController(); controller.current = pending;
    try {
      await onRun(request, pending.signal, () => {
        pending.signal.throwIfAborted();
        if (!mounted.current) throw new DOMException('Operation cancelled', 'AbortError');
        committing.current = true; setCommitStarted(true);
      });
      if (mounted.current && !pending.signal.aborted) onClose();
    } catch (cause) {
      if (mounted.current && !pending.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not update PDF pages.');
    } finally {
      submitting.current = false;
      committing.current = false;
      if (controller.current === pending) controller.current = null;
      if (mounted.current) { setBusy(false); setCommitStarted(false); }
    }
  };
  const updateRange = (value: string) => { setRange(value); setAttempted(false); setError(null); };
  return <dialog ref={dialog} className="conversion-dialog page-management-dialog" aria-labelledby="page-management-title" aria-describedby="page-management-description"
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
    }}>
    <form onSubmit={submit} noValidate aria-busy={busy || reading}>
      <header><h2 id="page-management-title">{t(`pages.${action}.title`)}</h2><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t('pages.close')} disabled={commitStarted} onClick={close}>×</button></header>
      <p id="page-management-description">{t(`pages.${action}.description`)}</p>
      <fieldset disabled={busy}>
        <label>{t('m.page.range.57245e')}<input ref={firstInput} aria-label={t('m.page.range.57245e')} value={range} onChange={event => updateRange(event.target.value)} placeholder={t('pdf.images.range.example')} aria-describedby="page-management-range-help" aria-invalid={attempted && pages.length === 0 ? true : undefined} /></label>
        <div className="page-management-presets">
          <button type="button" onClick={() => updateRange(String(currentPage))}>{t('pages.current')}</button>
          <button type="button" onClick={() => updateRange(`1-${totalPages}`)}>{t('pages.all')}</button>
          <button type="button" disabled={!selectedPages.length} onClick={() => updateRange(selectedPages.join(', '))}>{t('pages.selected')}</button>
        </div>
        <p className="conversion-hint" id="page-management-range-help">{t('pages.range.help', { total: totalPages })}</p>
        {action === 'duplicate' && <>
          <label>{t('pages.destination')}<select aria-label={t('pages.destination')} value={destination} onChange={event => setDestination(event.target.value)}>
            <option value="before">{t('pages.before.current', { page: currentPage })}</option><option value="after">{t('pages.after.current', { page: currentPage })}</option>
            <option value="end">{t('pages.at.end')}</option><option value="custom">{t('pages.before.specific')}</option>
          </select></label>
          {destination === 'custom' && <label>{t('pages.insert.before')}<input type="number" min={1} max={totalPages + 1} aria-label={t('pages.insert.before')} value={beforePage} onChange={event => setBeforePage(event.target.value)} /></label>}
        </>}
        {action === 'replace' && <>
          <div className="page-management-file-picker">
            <span>{t('pages.source')}</span>
            <input ref={sourceInput} type="file" hidden accept=".pdf,application/pdf" aria-label={t('pages.source')} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; void selectSource(file);
            }} />
            <div className="page-management-file-row">
              <button type="button" onClick={() => sourceInput.current?.click()}>{t('pages.source.choose')}</button>
              {!source && <span className="conversion-hint">{reading ? t('pages.reading') : t('pages.source.empty')}</span>}
            </div>
          </div>
          {source && <>
            <p className="page-management-source">{source.name} · {t('pages.source.count', { count: source.count })}</p>
            <label>{t('pages.source.range')}<input aria-label={t('pages.source.range')} value={sourceRange} onChange={event => { setSourceRange(event.target.value); setError(null); }} placeholder={t('pdf.images.range.example')} /></label>
            <p className="conversion-hint">{t('pages.replace.match', { count: pages.length })}</p>
          </>}
        </>}
        {action === 'crop' && <>
          <label className="page-management-checkbox"><input type="checkbox" checked={resetCrop} onChange={event => setResetCrop(event.target.checked)} />{t('pages.restore.crop')}</label>
          <div className="page-management-margins">{sides.map(side => <label key={side}>{t(`pages.crop.${side}`)}<input type="number" min={0} max={10000} step="0.1" disabled={resetCrop} aria-label={t(`pages.crop.${side}`)} value={margins[side]} onChange={event => { setMargins(value => ({ ...value, [side]: event.target.value })); setError(null); }} /></label>)}</div>
          <p className="conversion-hint">{t('pages.crop.help')}</p>
        </>}
        {pages.length > 0 && <p className="page-management-summary">{t('pages.count', { count: pages.length })}{action === 'replace' && source ? ` · ${t('pages.replacement.count', { count: replacementPages.length })}` : ''}</p>}
      </fieldset>
      {reading && <p role="status">{t('pages.reading')}</p>}
      {busy && <p role="status">{t('pages.working')}</p>}
      {((attempted && validation) || error) && <p className="conversion-error" role="alert">{translateError(error || validation)}</p>}
      <footer><button type="button" disabled={commitStarted} onClick={close}>{t('m.cancel.77dfd2')}</button><button type="submit" className="conversion-primary" disabled={busy || reading}>{busy ? t('pages.working') : t(`pages.${action}`)}</button></footer>
    </form>
  </dialog>;
}
