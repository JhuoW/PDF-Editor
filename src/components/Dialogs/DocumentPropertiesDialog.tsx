import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError, translateMessage } from "../../i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addDocumentAttachment, clearDocumentMetadata, extractDocumentAttachment, inspectDocumentAssets,
  removeDocumentAttachment, updateDocumentMetadata, type DocumentMetadata,
} from '../../core/DocumentAssets';
import './DocumentPropertiesDialog.css';

export interface DocumentPropertiesDialogProps {
  isOpen: boolean;
  /** Stable identity of the opened document, e.g. its originalDocument object. */
  documentKey: unknown;
  /** Changes whenever the current PDF bytes change. Attachment IDs are revision-specific. */
  revision: number;
  onClose: () => void;
  readPDF: () => Promise<ArrayBuffer>;
  onApply: (label: string, transform: (data: ArrayBuffer) => Promise<Uint8Array>) => Promise<void>;
}

const EMPTY_METADATA: DocumentMetadata = { title: '', author: '', subject: '', keywords: '' };
const metadataFields = [['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'], ['keywords', 'Keywords']] as const;
type Assets = Awaited<ReturnType<typeof inspectDocumentAssets>>;

function equalMetadata(first: DocumentMetadata, second: DocumentMetadata) {
  return metadataFields.every(([key]) => first[key] === second[key]);
}
function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB'][exponent]}`;
}

export function DocumentPropertiesDialog(props: DocumentPropertiesDialogProps) {
  useLocale();
  const [session, setSession] = useState({ documentKey: props.documentKey, sequence: 0 });
  if (!Object.is(session.documentKey, props.documentKey)) {
    setSession({ documentKey: props.documentKey, sequence: session.sequence + 1 });
    return null;
  }
  return props.isOpen ? <PropertiesSession key={session.sequence} {...props} /> : null;
}

function PropertiesSession({ revision, onClose, readPDF, onApply }: DocumentPropertiesDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const operationPending = useRef(false);
  const currentRevision = useRef(revision);
  const savedMetadata = useRef<DocumentMetadata>(EMPTY_METADATA);
  const focused = useRef(false);
  const objectURLs = useRef(new Set<string>());
  const [reload, setReload] = useState(0);
  const loadKey = useMemo(() => ({ revision, reload, readPDF }), [revision, reload, readPDF]);
  const [loaded, setLoaded] = useState<{ key: typeof loadKey; assets?: Assets; error?: string } | null>(null);
  const [metadata, setMetadata] = useState<DocumentMetadata>(EMPTY_METADATA);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const loading = loaded?.key !== loadKey;
  const assets = loaded?.key === loadKey ? loaded.assets : undefined;
  const loadError = loaded?.key === loadKey ? loaded.error : undefined;
  const disabled = loading || !!busy || !assets;
  const dirty = !!assets && !equalMetadata(metadata, assets.metadata);

  useLayoutEffect(() => { currentRevision.current = revision; }, [revision]);
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const urls = objectURLs.current;
    if (element && !element.open) element.showModal();
    return () => {
      active.current = false;
      element?.close();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await readPDF();
        if (cancelled || !active.current) return;
        const next = await inspectDocumentAssets(data);
        if (cancelled || !active.current) return;
        const previousSaved = savedMetadata.current;
        savedMetadata.current = next.metadata;
        // Revision refreshes must not discard an unsaved metadata draft while
        // the user adds/removes attachments or saves another part of the dialog.
        setMetadata(previous => equalMetadata(previous, previousSaved) ? next.metadata : previous);
        setLoaded({ key: loadKey, assets: next });
      } catch (cause) {
        if (!cancelled && active.current) setLoaded({ key: loadKey, error: cause instanceof Error ? cause.message : 'Could not read document properties.' });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [loadKey, readPDF]);

  useEffect(() => {
    if (assets && !focused.current) {
      focused.current = true;
      title.current?.focus();
    }
  }, [assets]);

  const perform = useCallback(async (label: string, action: (assertCurrent: () => void) => Promise<void>, success: string) => {
    if (operationPending.current || !active.current || disabled) return;
    operationPending.current = true;
    const startingRevision = revision;
    const assertCurrent = () => {
      if (!active.current || currentRevision.current !== startingRevision) throw new Error('The document changed. Reopen this action for the current document.');
    };
    setBusy(label);
    setError(null);
    setStatus('');
    try {
      await action(assertCurrent);
      if (active.current) setStatus(success);
    } catch (cause) {
      if (active.current && currentRevision.current === startingRevision) setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      operationPending.current = false;
      if (active.current) setBusy(null);
    }
  }, [disabled, revision]);

  const apply = async (label: string, transform: (data: ArrayBuffer) => Promise<Uint8Array>, assertCurrent: () => void) => {
    assertCurrent();
    await onApply(label, async data => {
      assertCurrent();
      const result = await transform(data);
      assertCurrent();
      return result;
    });
    // App normally changes revision after a commit. Also support callers that
    // update their backing bytes without changing a revision until later.
    if (active.current && currentRevision.current === revision) setReload(value => value + 1);
  };

  const saveProperties = (event: React.FormEvent) => {
    event.preventDefault();
    const draft = { ...metadata };
    void perform('Saving properties…', async assertCurrent => {
      await apply('Update document properties', data => updateDocumentMetadata(data, draft), assertCurrent);
    }, 'Document properties saved.');
  };

  const clearMetadata = () => void perform('Clearing metadata…', async assertCurrent => {
    await apply('Clear document metadata', clearDocumentMetadata, assertCurrent);
    if (active.current) setMetadata({ ...EMPTY_METADATA });
  }, 'Document metadata cleared.');

  const addAttachment = (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    const selectedFile = file;
    const selectedDescription = description;
    void perform('Adding attachment…', async assertCurrent => {
      const bytes = new Uint8Array(await selectedFile.arrayBuffer());
      assertCurrent();
      await apply('Add attachment', data => addDocumentAttachment(data, {
        name: selectedFile.name, mimeType: selectedFile.type || 'application/octet-stream', description: selectedDescription, data: bytes,
      }), assertCurrent);
      if (active.current) {
        setFile(null);
        setDescription('');
        if (fileInput.current) fileInput.current.value = '';
      }
    }, 'Attachment added.');
  };

  const deleteAttachment = (id: string) => void perform('Removing attachment…', async assertCurrent => {
    await apply('Remove attachment', data => removeDocumentAttachment(data, id), assertCurrent);
  }, 'Attachment removed.');

  const downloadAttachment = (id: string) => void perform('Preparing download…', async assertCurrent => {
    const data = await readPDF();
    assertCurrent();
    const attachment = await extractDocumentAttachment(data, id);
    assertCurrent();
    const blob = new Blob([new Uint8Array(attachment.data)], { type: attachment.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    objectURLs.current.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.name.replace(/[/\\]/g, '_') || 'attachment';
    document.body.append(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); }
    setTimeout(() => {
      URL.revokeObjectURL(url);
      objectURLs.current.delete(url);
    }, 1000);
  }, 'Attachment download started.');

  return <dialog ref={dialog} className="document-properties-dialog" aria-labelledby="document-properties-title"
    onCancel={event => { event.preventDefault(); if (!operationPending.current) onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
    }}>
    <header>
      <div><h2 id="document-properties-title">{t("m.document.properties.attachments.6edb2a")}</h2><p>{t("m.changes.apply.to.the.open.pdf.and.can.be.undone..01137d")}</p></div>
      <div className="dialog-language"><LanguageSwitcher /></div>
    <button type="button" aria-label={t("m.close.document.properties.5d934c")} disabled={!!busy} onClick={onClose}>×</button></header>
    {loading && <p role="status" className="document-properties-status">{t("m.loading.document.properties.3f510b")}</p>}
    {loadError && <div role="alert" className="document-properties-error"><p>{translateError(loadError)}</p><button type="button" onClick={() => setReload(value => value + 1)}>{t("m.retry.loading.54b15f")}</button></div>}
    <section aria-labelledby="document-metadata-heading" aria-busy={loading || !!busy}>
      <h3 id="document-metadata-heading">{t("m.document.properties.e6de11")}</h3>
      <form onSubmit={saveProperties}>
        <fieldset disabled={disabled} className="document-properties-fields">
          {metadataFields.map(([key, label]) => <label key={key}>{translateMessage(label)}<input ref={key === 'title' ? title : undefined} aria-label={t("m.document.d5092a", { v0: label.toLowerCase() })} value={metadata[key]} onChange={event => setMetadata(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        </fieldset>
        <p className="document-properties-help">{t("m.saving.properties.removes.existing.catalog.xmp.m.9327e0")}{assets?.hasXmp && t("m.this.document.contains.xmp.metadata.c49f4e")}</p>
        <div className="document-properties-actions"><button type="submit" className="properties-primary" disabled={disabled || !dirty && !assets?.hasXmp}>{t("m.save.properties.974640")}</button><button type="button" disabled={disabled} onClick={clearMetadata}>{t("m.clear.document.metadata.adf756")}</button></div>
      </form>
      <p className="document-properties-help">{t("m.clear.removes.the.document.info.dictionary.and.c.bb91e5")}</p>
    </section>
    <section aria-labelledby="document-attachments-heading" aria-busy={loading || !!busy}>
      <h3 id="document-attachments-heading">{t("m.attachments.6771ad")}{assets ? ` (${assets.attachments.length})` : ''}</h3>
      {assets?.attachments.length === 0 && <p className="document-properties-empty">{t("m.no.attachments.in.this.document.837de1")}</p>}
      {!!assets?.attachments.length && <div className="document-attachments-scroll"><table>
        <thead><tr><th scope="col">{t("m.name.709a23")}</th><th scope="col">{t("m.type.3deb74")}</th><th scope="col">{t("m.size.b71523")}</th><th scope="col">{t("m.description.55f8eb")}</th><th scope="col">{t("m.actions.c3cd63")}</th></tr></thead>
        <tbody>{assets.attachments.map((attachment, index) => <tr key={attachment.id} data-attachment-id={attachment.id}>
          <th scope="row"><span className="attachment-number">{index + 1}.</span> {attachment.name || t("m.unnamed.attachment.d6ccb8")}</th>
          <td>{attachment.mimeType || t("m.unknown.bc7819")}</td><td title={t("m.bytes.c098e8", { v0: attachment.size })}>{formatSize(attachment.size)}</td><td>{attachment.description || '—'}</td>
          <td><div className="attachment-actions"><button type="button" aria-label={t("m.download.attachment.7a8604", { v0: index + 1, v1: attachment.name })} disabled={disabled} onClick={() => downloadAttachment(attachment.id)}>{t("m.download.a479c9")}</button><button type="button" aria-label={t("m.delete.attachment.54fc80", { v0: index + 1, v1: attachment.name })} disabled={disabled} onClick={() => deleteAttachment(attachment.id)}>{t("m.delete.f6fdbe")}</button></div></td>
        </tr>)}</tbody>
      </table></div>}
      <form onSubmit={addAttachment} className="document-attachment-add">
        <fieldset disabled={disabled}>
          <label>{t("m.local.file.576d5a")}<input ref={fileInput} type="file" aria-label={t("m.attachment.file.b68ff1")} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
          <label>{t("m.description.optional.388de6")}<input aria-label={t("m.attachment.description.b2b22e")} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <button type="submit" disabled={disabled || !file}>{t("m.add.attachment.8577ca")}</button>
        </fieldset>
      </form>
    </section>
    {error && <p role="alert" className="document-properties-error">{translateError(error)}</p>}
    <footer><p role="status" className="document-properties-status">{translateMessage(busy ?? status)}</p><button type="button" disabled={!!busy} onClick={onClose}>{t("m.close.bbfa77")}</button></footer>
  </dialog>;
}
