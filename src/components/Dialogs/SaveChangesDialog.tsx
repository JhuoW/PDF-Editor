import { ErrorMessage } from '../Feedback/ErrorMessage';
import { isAbortError } from '../../utils/cancellation';
import { useEffect, useId, useRef, useState } from 'react';
import { t, useLocale } from '../../i18n';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import './ConversionDialog.css';
import './SaveChangesDialog.css';

interface SaveChangesDialogProps {
  fileName: string;
  busy?: boolean;
  purpose?: 'open' | 'close';
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
}

export function SaveChangesDialog({ fileName, busy = false, purpose = 'close', onSave, onDiscard, onCancel }: SaveChangesDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), saveButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false), submitting = useRef(false), closed = useRef(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const titleId = useId(), descriptionId = useId();
  const locked = busy || saving;
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current, opener = document.activeElement;
    if (element && !element.open) element.showModal();
    saveButton.current?.focus();
    return () => {
      mounted.current = false; element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const decide = (action: () => void) => {
    if (busy || submitting.current || closed.current) return;
    closed.current = true; dialog.current?.close(); action();
  };
  const save = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (busy || submitting.current || closed.current) return;
    submitting.current = true; setSaving(true); setError(null);
    try {
      await onSave();
      if (mounted.current) { closed.current = true; dialog.current?.close(); }
    } catch (cause) {
      const cancelled = isAbortError(cause);
      if (mounted.current && !cancelled) setError(cause instanceof Error ? cause.message : 'Could not save the PDF.');
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return <dialog ref={dialog} className="conversion-dialog save-changes-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); decide(onCancel); }} onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!event.shiftKey) void save(event);
      }
    }}>
    <form onSubmit={save} aria-busy={locked}>
      <header><h2 id={titleId}>{t('file.unsaved.title')}</h2><div className="dialog-language"><LanguageSwitcher /></div></header>
      <p id={descriptionId} data-document-content>{t(purpose === 'open' ? 'file.unsaved.beforeOpen' : 'file.unsaved.beforeClose', { fileName })}</p>
      <p className="conversion-hint">{t('file.unsaved.description')}</p>
      {error && <p className="conversion-error" role="alert"><ErrorMessage error={error} /></p>}
      {locked && <p role="status" aria-live="polite">{t('file.saving')}</p>}
      <footer>
        <button type="button" disabled={locked} onClick={() => decide(onCancel)}>{t('m.cancel.77dfd2')}</button>
        <button type="button" disabled={locked} onClick={() => decide(onDiscard)}>{t('file.unsaved.discard')}</button>
        <button ref={saveButton} type="submit" className="conversion-primary" disabled={locked}>{locked ? t('file.saving') : t('file.save')}</button>
      </footer>
    </form>
  </dialog>;
}
export default SaveChangesDialog;
