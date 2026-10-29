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
        <header><h2 id="encrypt-title">Encrypt and Export</h2><button type="button" aria-label="Close encryption dialog" disabled={busy} onClick={onClose}>×</button></header>
        <p id="encrypt-description">Download an AES-256 encrypted copy with your current edits.</p>
        <fieldset disabled={busy} className="encrypt-passwords">
          <label>Password to open<input ref={passwordRef} type="password" autoComplete="new-password" aria-label="Password to open" value={userPassword} onChange={event => setUserPassword(event.target.value)} required /></label>
          <label>Confirm opening password<input type="password" autoComplete="new-password" aria-label="Confirm opening password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
          <label>Owner password {restricted ? '(required)' : '(optional)'}<input type="password" autoComplete="new-password" aria-label="Owner password" value={ownerPassword} onChange={event => setOwnerPassword(event.target.value)} required={restricted} aria-describedby="encrypt-owner-help" /></label>
          <p id="encrypt-owner-help">The owner password controls permissions. {restricted ? 'Use a different password from the opening password.' : 'If blank, the opening password is used.'}</p>
        </fieldset>
        <fieldset disabled={busy} className="encrypt-permissions">
          <legend>Allow people using the opening password to:</legend>
          <div className="encrypt-permission-grid">{permissionLabels.map(([key, label]) => <label key={key}>
            <input type="checkbox" checked={permissions[key]} disabled={key === 'printHighQuality' && !permissions.print}
              onChange={event => {
                const checked = event.target.checked;
                setPermissions(previous => ({ ...previous, [key]: checked, ...(key === 'print' && !checked ? { printHighQuality: false } : {}) }));
              }} />{label}
          </label>)}</div>
          <p>Permissions depend on the PDF reader and cannot prevent every form of copying.</p>
        </fieldset>
        {error && <p className="encrypt-error" role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="encrypt-submit" type="submit" disabled={busy}>{busy ? 'Encrypting…' : 'Encrypt and download'}</button></footer>
      </form>
    </dialog>
  );
}
