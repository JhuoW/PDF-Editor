import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError } from "../../i18n";
import { useState, useEffect, useRef } from 'react';
import './GoToPageDialog.css';

interface GoToPageDialogProps {
  currentPage: number;
  totalPages: number;
  onGoToPage: (page: number) => void;
  onClose: () => void;
}

export function GoToPageDialog({
  currentPage,
  totalPages,
  onGoToPage,
  onClose,
}: GoToPageDialogProps) {
  useLocale();
  const [pageInput, setPageInput] = useState(currentPage.toString());
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const validateAndGo = () => {
    const pageNum = Number(pageInput);

    if (!pageInput.trim() || !Number.isSafeInteger(pageNum)) {
      setError('Please enter a whole page number');
      return;
    }

    if (pageNum < 1) {
      setError('Page must be at least 1');
      return;
    }

    if (pageNum > totalPages) {
      setError(`Page must be at most ${totalPages}`);
      return;
    }

    onGoToPage(pageNum);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    validateAndGo();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value);
    setError(null);
  };

  return (
    <dialog ref={dialogRef} className="goto-page-dialog" aria-labelledby="goto-page-title" onCancel={event => {
      event.preventDefault();
      onClose();
    }} onClick={event => {
      if (event.target === event.currentTarget) {
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }
    }}>
        <div className="goto-page-header">
          <h3 id="goto-page-title">{t("m.go.to.page.af1382")}</h3>
          <div className="dialog-language"><LanguageSwitcher /></div>
        <button className="goto-page-close" onClick={onClose} aria-label={t("m.close.go.to.page.93ce04")}>
            &times;
          </button></div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="goto-page-content">
            <label htmlFor="page-input">
              {t("m.enter.page.number.1.6cc7ab")}{' '}{totalPages}):
            </label>
            <input
              ref={inputRef}
              id="page-input"
              type="number"
              min={1}
              max={totalPages}
              step={1}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "goto-page-error" : undefined}
              value={pageInput}
              onChange={handleInputChange}
              className={error ? 'error' : ''}
            />
            {error && <div className="goto-page-error" id="goto-page-error" role="alert">{translateError(error)}</div>}
          </div>

          <div className="goto-page-actions">
            <button type="button" className="goto-page-cancel" onClick={onClose}>
              {t("m.cancel.77dfd2")}</button>
            <button type="submit" className="goto-page-submit">
              {t("m.go.2e0b45")}</button>
          </div>
        </form>
    </dialog>
  );
}
