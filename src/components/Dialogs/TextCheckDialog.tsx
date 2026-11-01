import { useEffect, useId, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { t, translateError, useLocale } from '../../i18n';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import type { TextBlock } from '../../editing/types';
import type { TextCheckIssue, TextCheckReport } from '../../editing/TextCheckTypes';
import { inspectWorkspaceTextInWorker } from '../../core/PDFExportClient';
import { captureWorkspace } from '../../store/workspaceSnapshot';
import { useDocumentStore } from '../../store/documentStore';
import { useEditingStore } from '../../store/editingStore';
import { ErrorMessage } from '../Feedback/ErrorMessage';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import './ConversionDialog.css';
import './TextCheckDialog.css';

export function TextCheckDialog({ pdf, revision, onClose, onLocate }: {
  pdf: PDFDocumentProxy; revision: number; onClose: () => void;
  onLocate: (issue: TextCheckIssue, blocks: TextBlock[]) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [retry, setRetry] = useState(0), [limit, setLimit] = useState(100);
  const [result, setResult] = useState<{ report: TextCheckReport; blocks: Map<number, TextBlock[]> } | null>(null);
  const [progress, setProgress] = useState(0), [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const element = dialog.current, opener = document.activeElement; element?.showModal();
    return () => { element?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && useDocumentStore.getState().document === pdf && useDocumentStore.getState().documentVersion === revision;
    const unsubscribe = useDocumentStore.subscribe(() => { if (!current()) controller.abort(); });
    void (async () => {
      try {
        const workspace = captureWorkspace();
        // Keep diagnostics at the active detection granularity so locating a
        // result never requires rewriting other pages' pending row edits.
        const kind = [...workspace.editing.textBlocks.values()].flat().find(block => block.kind)?.kind
          ?? (useEditingStore.getState().mode === 'object' ? 'line' : 'paragraph');
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          controller.signal.throwIfAborted();
          if (!workspace.editing.textBlocks.has(pageNumber)) {
            const page = await pdf.getPage(pageNumber);
            controller.signal.throwIfAborted();
            workspace.editing.textBlocks.set(pageNumber, await detectTextBlocks(page, kind));
          }
          if (!current()) return;
          setProgress(.4 * pageNumber / pdf.numPages);
        }
        const data = new Uint8Array(await pdf.getData()).buffer;
        controller.signal.throwIfAborted();
        const report = await inspectWorkspaceTextInWorker(data, workspace, { signal: controller.signal,
          onProgress: value => { if (current()) setProgress(.4 + .6 * value.progress); } });
        if (current()) setResult({ report, blocks: workspace.editing.textBlocks });
      } catch (cause) { if (current()) setError(cause); }
    })();
    return () => { unsubscribe(); controller.abort(); };
  }, [pdf, revision, retry]);
  const complete = !!result || !!error;
  return <dialog ref={dialog} className="conversion-dialog text-check-dialog" aria-labelledby={id}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={id}>{t('text.check.title')}</h2><LanguageSwitcher /><button type="button" onClick={onClose} aria-label={t('text.check.close')}>{'×'}</button></header>
    <p>{t('text.check.help')}</p>
    {!complete && <div role="status"><span>{t('text.check.running')}</span><progress max={1} value={progress} aria-label={t('text.check.progress')} /></div>}
    {!!error && <div role="alert"><ErrorMessage error={error} operation="Check document text" /></div>}
    {result && <>
      <p role="status">{t('text.check.summary', { blocks: result.report.checked, issues: result.report.issues.length })}</p>
      {!result.report.issues.length && <p>{t('text.check.clear')}</p>}
      <ol className="text-check-issues">{result.report.issues.slice(0, limit).map((issue, index) => <li key={index}>
        <div><strong>{issue.pageNumber ? t('text.check.page', { page: issue.pageNumber }) : t('text.check.document')}</strong>
          <span className={issue.blocking ? 'text-check-blocking' : ''}>{t(issue.blocking ? 'text.check.blocking' : 'text.check.information')}</span></div>
        <p>{issue.kind === 'font' ? translateError(issue.message) : <ErrorMessage error={issue.message} operation="Check document text" />}</p>
        {issue.pageNumber && <button type="button" onClick={() => onLocate(issue, result.blocks.get(issue.pageNumber!) ?? [])}>{t('text.check.locate')}</button>}
      </li>)}</ol>
      {result.report.issues.length > limit && <button type="button" onClick={() => setLimit(value => value + 100)}>{t('text.check.more')}</button>}
    </>}
    <footer>{complete && <button type="button" onClick={() => { setResult(null); setError(null); setProgress(0); setLimit(100); setRetry(value => value + 1); }}>{t('text.check.again')}</button>}
      <button type="button" onClick={onClose}>{t(complete ? 'text.check.close' : 'text.check.cancel')}</button></footer>
  </dialog>;
}
