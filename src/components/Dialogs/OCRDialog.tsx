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
  const [session, setSession] = useState({ key: props.documentKey, sequence: 0 });
  if (!Object.is(session.key, props.documentKey)) {
    setSession({ key: props.documentKey, sequence: session.sequence + 1 });
    return null;
  }
  return <OCRSession key={session.sequence} {...props} />;
}

function OCRSession({ totalPages, currentPage, onClose, onRun }: OCRDialogProps) {
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
    <header><h2 id="ocr-title">Scan OCR</h2><button type="button" aria-label="Close OCR" disabled={saving || canceling} onClick={() => cancel(true)}>×</button></header>
    <p id="ocr-description">Add searchable, selectable text to scanned pages while keeping their appearance.</p>
    <form onSubmit={start}>
      <fieldset disabled={busy}>
        <label htmlFor="ocr-pages">Pages</label>
        <div className="ocr-page-range"><input ref={pagesInput} id="ocr-pages" value={pages} onChange={event => setPages(event.target.value)} aria-describedby="ocr-range-help" />
          <button type="button" onClick={() => setPages(totalPages === 1 ? '1' : `1-${totalPages}`)}>All pages</button>
          <button type="button" onClick={() => setPages(String(currentPage))}>Current page</button></div>
        <p id="ocr-range-help" className="ocr-help">Use page numbers and ranges, for example 1, 3-5. This PDF has {totalPages} {totalPages === 1 ? 'page' : 'pages'}.</p>
        <label htmlFor="ocr-language">Recognition language</label>
        <select id="ocr-language" value={language} onChange={event => setLanguage(event.target.value as OCRLanguage)}>
          <option value="eng">English</option><option value="chi_sim+eng">Simplified Chinese + English</option>
        </select>
        <label className="ocr-checkbox"><input type="checkbox" checked={skipExistingText} onChange={event => setSkipExistingText(event.target.checked)} />Skip pages that already contain text</label>
        {!skipExistingText && <p className="ocr-help">Recognizing pages that already have text can add duplicate text.</p>}
      </fieldset>
      <p className="ocr-help">Recognition runs on this device. Form fields and annotations are preserved and excluded from recognition. Pending text and image edits are included.</p>
      {busy && <div className="ocr-progress" aria-busy="true">
        <progress max={1} value={Math.min(1, Math.max(0, progress?.progress ?? 0))} aria-label="OCR progress" />
        <p role="status">{canceling ? 'Canceling OCR…' : saving ? 'Saving recognized text…' : progress?.status}{!saving && !canceling && progress?.pageNumber ? ` — Page ${progress.pageNumber} (${progress.completedPages}/${progress.totalPages} completed)` : ''}</p>
      </div>}
      {!busy && message && <p role="status" className="ocr-result-message">{message}</p>}
      {results && <div className="ocr-results"><table><caption>Recognition results</caption><thead><tr><th>Page</th><th>Result</th><th>Words</th></tr></thead><tbody>
        {results.map(result => <tr key={result.pageNumber}><th scope="row">{result.pageNumber}</th><td>{result.status === 'recognized' ? 'Text added' : result.status === 'skipped-existing-text' ? 'Skipped: existing text' : 'No text detected'}</td><td>{result.wordCount}</td></tr>)}
      </tbody></table></div>}
      {error && <p role="alert" className="ocr-error">{error}</p>}
      <footer>{busy ? <button type="button" disabled={saving || canceling} onClick={() => cancel()}>Cancel OCR</button> : <button type="button" onClick={() => cancel(true)}>Close</button>}
        <button type="submit" className="ocr-primary" disabled={busy}>Start OCR</button></footer>
    </form>
  </dialog>;
}

export default OCRDialog;
