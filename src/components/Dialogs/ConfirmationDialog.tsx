import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, translateMessage } from "../../i18n";
import { useEffect, useId, useRef, type ReactNode } from 'react';
import './ConfirmationDialog.css';

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** null shows a single acknowledgement button (alert). */
  cancelLabel?: string | null;
  confirmVariant?: 'danger' | 'primary';
  /** Extra content such as a prompt field; its first input receives focus. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  onConfirm,
  onCancel,
  children,
}: ConfirmationDialogProps) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId(), messageId = useId();

  // Native modal semantics keep focus and pointer interaction inside the decision.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    // Focus the safe choice; a prompt focuses its field, an alert its only button.
    const field = dialog?.querySelector<HTMLInputElement>('.confirmation-dialog-body input');
    if (field) { field.focus(); field.select(); }
    else (cancelButtonRef.current ?? confirmButtonRef.current)?.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // Handle click outside dialog
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  if (!isOpen) return null;

  return (
    <dialog ref={dialogRef} className="confirmation-dialog-overlay" aria-labelledby={titleId} aria-describedby={messageId}
      /* Stop propagation: React bubbles cancel/click to an enclosing dialog's handlers. */
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }} onClick={event => { event.stopPropagation(); handleBackdropClick(event); }} onKeyDown={event => event.stopPropagation()}>
      <div className="confirmation-dialog">
        <div className="confirmation-dialog-header">
          <h2 id={titleId} className="confirmation-dialog-title">{translateMessage(title)}</h2>
        <div className="dialog-language"><LanguageSwitcher /></div></div>
        <div className="confirmation-dialog-body">
          <p id={messageId} className="confirmation-dialog-message">{translateMessage(message)}</p>
          {children}
        </div>
        <div className="confirmation-dialog-footer">
          {cancelLabel !== null && <button
            type="button"
            ref={cancelButtonRef}
            className="confirmation-dialog-button cancel"
            onClick={onCancel}
          >
            {translateMessage(cancelLabel)}
          </button>}
          <button
            type="button"
            ref={confirmButtonRef}
            className={`confirmation-dialog-button confirm ${confirmVariant}`}
            onClick={onConfirm}
          >
            {translateMessage(confirmLabel)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
