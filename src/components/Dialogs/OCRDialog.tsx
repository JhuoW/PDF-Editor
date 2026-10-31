import { ErrorMessage } from '../Feedback/ErrorMessage';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateMessage } from "../../i18n";
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OCRLanguage, OCRPageResult, OCRProgress } from '../../ocr/recognizePDF';
import './OCRDialog.css';

export interface OCRRunOptions {
  pages: number[];
  language: OCRLanguage;
  skipExistingText: boolean;
}
export type OCRDialogProgress = OCRProgress | (Omit<OCRProgress, 'phase'> & { phase: 'committing' });
export interface OCRDialogProps {
  documentKey: unknown;
  totalPages: number;
  currentPage: number;
  onClose: () => void;
  onRun: (options: OCRRunOptions, signal: AbortSignal, onProgress: (progress: OCRDialogProgress) => void) => Promise<OCRPageResult[]>;
}

function parsePages(value: string, total: number): number[] {
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    const first = Number(match?.[1]), last = Number(match?.[2] ?? match?.[1]);
    if (!match || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > total) {
      throw new Error(`Enter pages from 1 to ${total}, such as 1, 3-5.`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function OCRDialog(props: OCRDialogProps) {
  useLocale();
  const [session, setSession] = useState({ key: props.documentKey, sequence: 0 });
  if (!Object.is(session.key, props.documentKey)) {
    setSession({ key: props.documentKey, sequence: session.sequence + 1 });
    return null;
  }
  return <OCRSession key={session.sequence} {...props} />;
}

function OCRSession({ totalPages, currentPage, onClose, onRun }: OCRDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const pagesInput = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const committing = useRef(false);
  const closeAfterCancel = useRef(false);
  const [pages, setPages] = useState(totalPages === 1 ? '1' : `1-${totalPages}`);
  const [language, setLanguage] = useState<OCRLanguage>('eng');
  const [skipExistingText, setSkipExistingText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState<OCRDialogProgress | null>(null);
  const [results, setResults] = useState<OCRPageResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const saving = busy && progress?.phase === 'committing';

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    pagesInput.current?.focus();
    return () => {
      active.current = false;
      controller.current?.abort();
      element?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const cancel = (close = false) => {
    if (committing.current) return;
    if (controller.current) {
      closeAfterCancel.current ||= close;
      controller.current.abort();
      setCanceling(true);
    } else if (close) onClose();
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (controller.current || !active.current) return;
    let selectedPages: number[];
    try { selectedPages = parsePages(pages, totalPages); }
    catch (cause) {
      setError((cause as Error).message);
      pagesInput.current?.focus();
      return;
    }
    const operation = new AbortController();
    controller.current = operation;
    closeAfterCancel.current = false;
    committing.current = false;
    setBusy(true); setCanceling(false); setError(null); setResults(null); setMessage('');
    setProgress({ phase: 'initializing', pageNumber: null, completedPages: 0, totalPages: selectedPages.length, progress: 0, status: 'Preparing OCR…' });
    try {
      const result = await onRun({ pages: selectedPages, language, skipExistingText }, operation.signal, next => {
        if (!active.current || operation.signal.aborted) return;
        committing.current = next.phase === 'committing';
        setProgress(next);
      });
      if (!active.current) return;
      if (operation.signal.aborted && !committing.current) setMessage('OCR canceled. The document was not changed.');
      else {
        setResults(result);
        const recognized = result.filter(page => page.status === 'recognized').length;
        setMessage(recognized ? `Searchable text added to ${recognized} ${recognized === 1 ? 'page' : 'pages'}. You can undo this change.` : 'No text was added. The document was not changed.');
      }
    } catch (cause) {
      if (!active.current) return;
      if (operation.signal.aborted || cause instanceof Error && cause.name === 'AbortError') setMessage('OCR canceled. The document was not changed.');
      else setError(cause instanceof Error ? cause.message : 'OCR could not finish. Try again.');
    } finally {
      if (controller.current === operation) controller.current = null;
      committing.current = false;
      if (active.current) {
        setBusy(false); setCanceling(false);
        if (closeAfterCancel.current) onClose();
      }
    }
  };

  return <dialog ref={dialog} className="ocr-dialog" aria-labelledby="ocr-title" aria-describedby="ocr-description"
    onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault(); }}
    onCancel={event => { event.preventDefault(); cancel(true); }}>
    <header><h2 id="ocr-title">{t("m.scan.ocr.5c62d6")}</h2><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.ocr.00ec64")} disabled={saving || canceling} onClick={() => cancel(true)}>×</button></header>
    <p id="ocr-description">{t("m.add.searchable.selectable.text.to.scanned.pages..c2fe59")}</p>
    <form onSubmit={start}>
      <fieldset disabled={busy}>
        <label htmlFor="ocr-pages">{t("m.pages.600584")}</label>
        <div className="ocr-page-range"><input ref={pagesInput} id="ocr-pages" value={pages} onChange={event => setPages(event.target.value)} aria-describedby="ocr-range-help" />
          <button type="button" onClick={() => setPages(totalPages === 1 ? '1' : `1-${totalPages}`)}>{t("m.all.pages.921a7e")}</button>
          <button type="button" onClick={() => setPages(String(currentPage))}>{t("m.current.page.af778b")}</button></div>
        <p id="ocr-range-help" className="ocr-help">{t("m.use.page.numbers.and.ranges.for.example.1.3.5.th.dd4118")}{' '}{totalPages} {totalPages === 1 ? t("m.page.767013") : t("m.pages.eec654")}.</p>
        <label htmlFor="ocr-language">{t("m.recognition.language.9f7dbf")}</label>
        <select id="ocr-language" value={language} onChange={event => setLanguage(event.target.value as OCRLanguage)}>
          <option value="eng">{t("m.english.649df0")}</option><option value="chi_sim+eng">{t("m.simplified.chinese.english.c53863")}</option>
        </select>
        <label className="ocr-checkbox"><input type="checkbox" checked={skipExistingText} onChange={event => setSkipExistingText(event.target.checked)} />{t("m.skip.pages.that.already.contain.text.534523")}</label>
        {!skipExistingText && <p className="ocr-help">{t("m.recognizing.pages.that.already.have.text.can.add.aab305")}</p>}
      </fieldset>
      <p className="ocr-help">{t("m.recognition.runs.on.this.device.form.fields.and..69c931")}</p>
      {busy && <div className="ocr-progress" aria-busy="true">
        <progress max={1} value={Math.min(1, Math.max(0, progress?.progress ?? 0))} aria-label={t("m.ocr.progress.e67739")} />
        <p role="status">{canceling ? t("m.canceling.ocr.2023cd") : saving ? t("m.saving.recognized.text.c42061") : translateMessage(progress?.status)}{!saving && !canceling && progress?.pageNumber ? t("m.page.completed.dd308b", { v0: progress.pageNumber, v1: progress.completedPages, v2: progress.totalPages }) : ''}</p>
      </div>}
      {!busy && message && <p role="status" className="ocr-result-message">{translateMessage(message)}</p>}
      {results && <div className="ocr-results"><table><caption>{t("m.recognition.results.174b57")}</caption><thead><tr><th>{t("m.page.fb0627")}</th><th>{t("m.result.5faa59")}</th><th>{t("m.words.d26d55")}</th></tr></thead><tbody>
        {results.map(result => <tr key={result.pageNumber}><th scope="row">{result.pageNumber}</th><td>{result.status === 'recognized' ? t("m.text.added.f668a2") : result.status === 'skipped-existing-text' ? t("m.skipped.existing.text.c09e0c") : t("m.no.text.detected.a4c994")}</td><td>{result.wordCount}</td></tr>)}
      </tbody></table></div>}
      {error && <p role="alert" className="ocr-error"><ErrorMessage error={error} /></p>}
      <footer>{busy ? <button type="button" disabled={saving || canceling} onClick={() => cancel()}>{t("m.cancel.ocr.7ab338")}</button> : <button type="button" onClick={() => cancel(true)}>{t("m.close.bbfa77")}</button>}
        <button type="submit" className="ocr-primary" disabled={busy}>{t("m.start.ocr.b616fd")}</button></footer>
    </form>
  </dialog>;
}

export default OCRDialog;
