import { useEffect, useRef } from 'react';
import type { PDFPasswordRequest } from '../../hooks/usePDFDocument';
import './PasswordDialog.css';

interface PasswordDialogProps {
  request: PDFPasswordRequest | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordDialog({ request, onSubmit, onCancel }: PasswordDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!request) return;
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    if (input.current) {
      input.current.value = '';
      input.current.focus();
    }
    return () => { element?.close(); previousFocus?.focus(); };
  }, [request]);

  if (!request) return null;
  return (
    <dialog ref={dialog} className="password-dialog" aria-labelledby="pdf-password-title"
      aria-describedby="pdf-password-description" onCancel={event => { event.preventDefault(); onCancel(); }}>
      <form onSubmit={event => {
          event.preventDefault();
          const password = input.current?.value ?? '';
          if (input.current) input.current.value = '';
          onSubmit(password);
        }} onKeyDown={event => {
          event.stopPropagation();
        }}>
        <h2 id="pdf-password-title">Unlock PDF</h2>
        <p className="password-dialog-filename">{request.fileName}</p>
        <p id="pdf-password-description">Enter the PDF password to create an unlocked working copy. Your password is not saved. The unlocked copy is saved in this browser for recovery. Ordinary exports are unencrypted; use encrypted export to protect the result.</p>
        {request.reason === 'incorrect' && <p className="password-dialog-error" role="alert">Incorrect password. Please try again.</p>}
        <label htmlFor="pdf-open-password">PDF password</label>
        <input ref={input} id="pdf-open-password" name="pdf-password" type="password" autoComplete="off" />
        <div className="password-dialog-actions">
          <button type="submit" className="password-dialog-submit">Unlock PDF</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}
