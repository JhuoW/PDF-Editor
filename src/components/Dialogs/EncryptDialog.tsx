import { ErrorMessage } from '../Feedback/ErrorMessage';
import { isAbortError } from '../../utils/cancellation';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateMessage } from "../../i18n";
import { useEffect, useRef, useState } from 'react';
import { ALL_PDF_PERMISSIONS, encryptPDF, type PDFPermissions } from '../../core/PDFEncryption';
import { downloadPDF } from '../../core/PDFManipulator';
import './EncryptDialog.css';

interface EncryptDialogProps {
  preparePDF: () => Promise<{ data: Uint8Array; fileName: string }>;
  onClose: () => void;
}

const permissionLabels: [keyof PDFPermissions, string][] = [
  ['print', 'Print'], ['printHighQuality', 'Print in high quality'],
  ['copy', 'Copy text and images'], ['edit', 'Edit document content'],
  ['annotate', 'Add or edit annotations'], ['form', 'Fill form fields'],
  ['accessibility', 'Extract for accessibility'], ['assemble', 'Assemble and reorder pages'],
];

export function EncryptDialog({ preparePDF, onClose }: EncryptDialogProps) {
  useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const submitting = useRef(false);
  const [userPassword, setUserPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [permissions, setPermissions] = useState<PDFPermissions>({ ...ALL_PDF_PERMISSIONS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restricted = Object.values(permissions).some(allowed => !allowed);

  useEffect(() => {
    active.current = true;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    passwordRef.current?.focus();
    return () => {
      active.current = false;
      dialog?.close();
    };
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!userPassword) { setError('Enter a password to open the exported PDF.'); passwordRef.current?.focus(); return; }
    if (confirmation !== userPassword) { setError('The password confirmation does not match.'); return; }
    if (restricted && (!ownerPassword || ownerPassword === userPassword)) {
      setError('Restricted permissions require a separate owner password that differs from the opening password.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { data, fileName } = await preparePDF();
      if (!active.current) return;
      // Copy the exact byte view. A returned Uint8Array may have an offset into
      // a larger buffer, and the export must never encrypt unrelated bytes.
      const encrypted = await encryptPDF(new Uint8Array(data).buffer, {
        userPassword, ownerPassword: ownerPassword || userPassword, permissions,
      });
      if (!active.current) return;
      await downloadPDF(new Uint8Array(encrypted), `${fileName.replace(/\.pdf$/i, '')}-encrypted.pdf`);
      if (active.current) onClose();
    } catch (cause) {
      if (isAbortError(cause)) return;
      if (active.current) setError(cause instanceof Error ? cause.message : 'Could not encrypt the PDF.');
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="encrypt-dialog" aria-labelledby="encrypt-title" aria-describedby="encrypt-description"
      onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}
      onKeyDown={event => {
        // Native modal focus containment does not stop global app shortcuts.
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
      }}>
      <form onSubmit={submit} noValidate aria-busy={busy}>
        <header><h2 id="encrypt-title">{t("m.encrypt.and.export.65c449")}</h2><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.encryption.dialog.f32ced")} disabled={busy} onClick={onClose}>×</button></header>
        <p id="encrypt-description">{t("m.download.an.aes.256.encrypted.copy.with.your.cur.725fd5")}</p>
        <fieldset disabled={busy} className="encrypt-passwords">
          <label>{t("m.password.to.open.b9b5a0")}<input ref={passwordRef} type="password" autoComplete="new-password" aria-label={t("m.password.to.open.b9b5a0")} value={userPassword} onChange={event => setUserPassword(event.target.value)} required /></label>
          <label>{t("m.confirm.opening.password.4d1f6d")}<input type="password" autoComplete="new-password" aria-label={t("m.confirm.opening.password.4d1f6d")} value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
          <label>{t("m.owner.password.9f04b8")}{' '}{restricted ? t("m.required.0002fd") : t("m.optional.b16c7a")}<input type="password" autoComplete="new-password" aria-label={t("m.owner.password.9f04b8")} value={ownerPassword} onChange={event => setOwnerPassword(event.target.value)} required={restricted} aria-describedby="encrypt-owner-help" /></label>
          <p id="encrypt-owner-help">{t("m.the.owner.password.controls.permissions.5468ad")}{' '}{restricted ? t("m.use.a.different.password.from.the.opening.passwo.cea32c") : t("m.if.blank.the.opening.password.is.used.7642ec")}</p>
        </fieldset>
        <fieldset disabled={busy} className="encrypt-permissions">
          <legend>{t("m.allow.people.using.the.opening.password.to.87435c")}</legend>
          <div className="encrypt-permission-grid">{permissionLabels.map(([key, label]) => <label key={key}>
            <input type="checkbox" checked={permissions[key]} disabled={key === 'printHighQuality' && !permissions.print}
              onChange={event => {
                const checked = event.target.checked;
                setPermissions(previous => ({ ...previous, [key]: checked, ...(key === 'print' && !checked ? { printHighQuality: false } : {}) }));
              }} />{translateMessage(label)}
          </label>)}</div>
          <p>{t("m.permissions.depend.on.the.pdf.reader.and.cannot..0b277a")}</p>
        </fieldset>
        {error && <p className="encrypt-error" role="alert"><ErrorMessage error={error} /></p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>{t("m.cancel.77dfd2")}</button><button className="encrypt-submit" type="submit" disabled={busy}>{busy ? t("m.encrypting.788f55") : t("m.encrypt.and.download.b3ba75")}</button></footer>
      </form>
    </dialog>
  );
}
