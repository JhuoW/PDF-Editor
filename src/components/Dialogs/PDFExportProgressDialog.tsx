import { useEffect, useId, useRef } from 'react';
import { t, useLocale } from '../../i18n';
import type { PDFExportProgress } from '../../core/PDFExportTypes';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import './ConversionDialog.css';

export function PDFExportProgressDialog({ progress, onCancel }: { progress: PDFExportProgress; onCancel: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    const element = dialog.current, opener = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="conversion-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={id}>{t('export.job.title')}</h2><LanguageSwitcher /></header>
    <div className="pdf-export-progress" role="status"><span>{t(`export.stage.${progress.stage}`)}</span>
      <progress max={1} value={progress.progress} aria-label={t('export.job.progress')} />
      <button type="button" onClick={onCancel}>{t('export.job.cancel')}</button>
    </div>
  </dialog>;
}
