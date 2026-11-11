import { useEffect, useState } from 'react';
import { t, useLocale } from '../../i18n';
import { clearAppNotice, settleAppDialog, useAppDialogStore, type AppDialogRequest } from '../../store/appDialogStore';
import { ConfirmationDialog } from './ConfirmationDialog';

function AppDialog({ request }: { request: AppDialogRequest }) {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [showRequired, setShowRequired] = useState(false);
  const cancelValue = request.kind === 'confirm' ? false : request.kind === 'prompt' ? null : undefined;
  const confirm = () => {
    if (request.kind !== 'prompt') { settleAppDialog(request.id, request.kind === 'confirm' ? true : undefined); return; }
    if (!value.trim()) { setShowRequired(true); return; }
    settleAppDialog(request.id, value.trim());
  };
  const title = request.title ?? (request.kind === 'alert' ? t('dialog.notice.title') : t('dialog.confirm.title'));
  return <ConfirmationDialog
    isOpen
    title={title}
    message={request.message}
    confirmLabel={request.confirmLabel ?? t('dialog.ok')}
    cancelLabel={request.kind === 'alert' ? null : request.cancelLabel ?? t('m.cancel.77dfd2')}
    confirmVariant={request.danger ? 'danger' : 'primary'}
    onConfirm={confirm}
    onCancel={() => settleAppDialog(request.id, cancelValue)}
  >
    {request.kind === 'prompt' && <>
      <input className="confirmation-dialog-input" aria-label={request.message} value={value}
        onChange={event => { setValue(event.target.value); setShowRequired(false); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); confirm(); } }} />
      {showRequired && <p className="confirmation-dialog-error" role="alert">{t('dialog.value.required')}</p>}
    </>}
  </ConfirmationDialog>;
}

/** Renders queued in-app dialogs one at a time. */
export function AppDialogHost() {
  useLocale();
  const request = useAppDialogStore(state => state.queue[0]);
  return request ? <AppDialog key={request.id} request={request} /> : null;
}

/** Status-bar notice that disappears on its own. */
export function AppNotice() {
  useLocale();
  const notice = useAppDialogStore(state => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => clearAppNotice(notice.id), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return notice ? <span className="file-action-status app-notice" role="status">{notice.message}</span> : null;
}
