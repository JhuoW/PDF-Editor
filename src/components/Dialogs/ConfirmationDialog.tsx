import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, translateMessage } from "../../i18n";
import { useEffect, useRef } from 'react';
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Focus cancel button when dialog opens
  useEffect(() => {
    if (isOpen && cancelButtonRef.current) {
      cancelButtonRef.current.focus();
    }
  }, [isOpen]);

  // Handle keyboard events
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  // Handle click outside dialog
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="confirmation-dialog-overlay" onClick={handleBackdropClick}>
      <div className="confirmation-dialog" ref={dialogRef} role="dialog" aria-modal="true">
        <div className="confirmation-dialog-header">
          <h2 className="confirmation-dialog-title">{translateMessage(title)}</h2>
        <div className="dialog-language"><LanguageSwitcher /></div></div>
        <div className="confirmation-dialog-body">
          <p className="confirmation-dialog-message">{translateMessage(message)}</p>
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
    </div>
  );
}
