import { useState, type SyntheticEvent } from 'react';
import { t } from '../../i18n';
import { ConfirmationDialog } from './ConfirmationDialog';

/**
 * Guards implicit closes (Escape, the × button) of dialogs that collect
 * changes before applying them. Explicit "Discard changes" buttons call the
 * close function directly; only accidental exits ask first.
 */
export function useDiscardConfirmation(hasChanges: boolean, discard: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => { if (hasChanges) setAsking(true); else discard(); };
  // Escape on the dialog. Browsers may make a repeated Escape non-cancelable;
  // the dialog then closes natively, so the session must end with it.
  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    const cancelable = event.cancelable;
    event.preventDefault();
    if (cancelable) requestClose(); else discard();
  };
  const confirmation = <ConfirmationDialog
    isOpen={asking}
    title={t('dialog.discard.title')}
    message={t('dialog.discard.message')}
    confirmLabel={t('m.discard.changes.fa8fc0')}
    cancelLabel={t('dialog.discard.keep')}
    confirmVariant="danger"
    onConfirm={() => { setAsking(false); discard(); }}
    onCancel={() => setAsking(false)}
  />;
  return { requestClose, handleCancel, confirmation };
}
