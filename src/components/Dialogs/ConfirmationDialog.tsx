import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, translateMessage } from "../../i18n";
import { useEffect, useId, useRef } from 'react';
import './ConfirmationDialog.css';

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
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
}: ConfirmationDialogProps) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId(), messageId = useId();

  // Native modal semantics keep focus and pointer interaction inside the decision.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    cancelButtonRef.current?.focus();
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
      onCancel={event => { event.preventDefault(); onCancel(); }} onClick={handleBackdropClick} onKeyDown={event => event.stopPropagation()}>
      <div className="confirmation-dialog">
        <div className="confirmation-dialog-header">
          <h2 id={titleId} className="confirmation-dialog-title">{translateMessage(title)}</h2>
        <div className="dialog-language"><LanguageSwitcher /></div></div>
        <div className="confirmation-dialog-body">
          <p id={messageId} className="confirmation-dialog-message">{translateMessage(message)}</p>
        </div>
        <div className="confirmation-dialog-footer">
          <button
            ref={cancelButtonRef}
            className="confirmation-dialog-button cancel"
            onClick={onCancel}
          >
            {translateMessage(cancelLabel)}
          </button>
          <button
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
