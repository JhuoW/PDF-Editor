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
  const [session, setSession] = useState({ documentKey: props.documentKey, sequence: 0 });
  if (!Object.is(session.documentKey, props.documentKey)) {
    setSession({ documentKey: props.documentKey, sequence: session.sequence + 1 });
    return null;
  }
  return props.isOpen ? <PropertiesSession key={session.sequence} {...props} /> : null;
}

function PropertiesSession({ revision, onClose, readPDF, onApply }: DocumentPropertiesDialogProps) {
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
      <div><h2 id="document-properties-title">Document Properties &amp; Attachments</h2><p>Changes apply to the open PDF and can be undone. Export to save a copy.</p></div>
      <button type="button" aria-label="Close document properties" disabled={!!busy} onClick={onClose}>×</button>
    </header>
    {loading && <p role="status" className="document-properties-status">Loading document properties…</p>}
    {loadError && <div role="alert" className="document-properties-error"><p>{loadError}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry loading</button></div>}
    <section aria-labelledby="document-metadata-heading" aria-busy={loading || !!busy}>
      <h3 id="document-metadata-heading">Document properties</h3>
      <form onSubmit={saveProperties}>
        <fieldset disabled={disabled} className="document-properties-fields">
          {metadataFields.map(([key, label]) => <label key={key}>{label}<input ref={key === 'title' ? title : undefined} aria-label={`Document ${label.toLowerCase()}`} value={metadata[key]} onChange={event => setMetadata(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        </fieldset>
        <p className="document-properties-help">Saving properties removes existing catalog XMP metadata to avoid conflicting values.{assets?.hasXmp && ' This document contains XMP metadata.'}</p>
        <div className="document-properties-actions"><button type="submit" className="properties-primary" disabled={disabled || !dirty && !assets?.hasXmp}>Save properties</button><button type="button" disabled={disabled} onClick={clearMetadata}>Clear document metadata</button></div>
      </form>
      <p className="document-properties-help">Clear removes the document Info dictionary and catalog XMP. It does not remove sensitive information from page content, annotations or attachments.</p>
    </section>
    <section aria-labelledby="document-attachments-heading" aria-busy={loading || !!busy}>
      <h3 id="document-attachments-heading">Attachments{assets ? ` (${assets.attachments.length})` : ''}</h3>
      {assets?.attachments.length === 0 && <p className="document-properties-empty">No attachments in this document.</p>}
      {!!assets?.attachments.length && <div className="document-attachments-scroll"><table>
        <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Description</th><th scope="col">Actions</th></tr></thead>
        <tbody>{assets.attachments.map((attachment, index) => <tr key={attachment.id} data-attachment-id={attachment.id}>
          <th scope="row"><span className="attachment-number">{index + 1}.</span> {attachment.name || 'Unnamed attachment'}</th>
          <td>{attachment.mimeType || 'Unknown'}</td><td title={`${attachment.size} bytes`}>{formatSize(attachment.size)}</td><td>{attachment.description || '—'}</td>
          <td><div className="attachment-actions"><button type="button" aria-label={`Download attachment ${index + 1}: ${attachment.name}`} disabled={disabled} onClick={() => downloadAttachment(attachment.id)}>Download</button><button type="button" aria-label={`Delete attachment ${index + 1}: ${attachment.name}`} disabled={disabled} onClick={() => deleteAttachment(attachment.id)}>Delete</button></div></td>
        </tr>)}</tbody>
      </table></div>}
      <form onSubmit={addAttachment} className="document-attachment-add">
        <fieldset disabled={disabled}>
          <label>Local file<input ref={fileInput} type="file" aria-label="Attachment file" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
          <label>Description (optional)<input aria-label="Attachment description" value={description} onChange={event => setDescription(event.target.value)} /></label>
          <button type="submit" disabled={disabled || !file}>Add attachment</button>
        </fieldset>
      </form>
    </section>
    {error && <p role="alert" className="document-properties-error">{error}</p>}
    <footer><p role="status" className="document-properties-status">{busy ?? status}</p><button type="button" disabled={!!busy} onClick={onClose}>Close</button></footer>
  </dialog>;
}
