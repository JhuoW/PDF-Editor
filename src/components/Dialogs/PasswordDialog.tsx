import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import { useLocale, t } from "../../i18n";
import { useEffect, useRef } from 'react';
import type { PDFPasswordRequest } from '../../hooks/usePDFDocument';
import './PasswordDialog.css';

interface PasswordDialogProps {
  request: PDFPasswordRequest | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordDialog({ request, onSubmit, onCancel }: PasswordDialogProps) {
  useLocale();
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
        <div className="dialog-language"><LanguageSwitcher /></div><h2 id="pdf-password-title">{t("m.unlock.pdf.f7ea75")}</h2>
        <p className="password-dialog-filename">{request.fileName}</p>
        <p id="pdf-password-description">{t("m.enter.the.pdf.password.to.create.an.unlocked.wor.5d9721")}</p>
        {request.reason === 'incorrect' && <p className="password-dialog-error" role="alert">{t("m.incorrect.password.please.try.again.f6a1b2")}</p>}
        <label htmlFor="pdf-open-password">{t("m.pdf.password.6a7921")}</label>
        <input ref={input} id="pdf-open-password" name="pdf-password" type="password" autoComplete="off" />
        <div className="password-dialog-actions">
          <button type="submit" className="password-dialog-submit">{t("m.unlock.pdf.f7ea75")}</button>
          <button type="button" onClick={onCancel}>{t("m.cancel.77dfd2")}</button>
        </div>
      </form>
    </dialog>
  );
}
