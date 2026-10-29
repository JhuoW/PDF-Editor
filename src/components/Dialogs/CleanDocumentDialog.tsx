import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cleanPDF, inspectPDFCleanup } from '../../core/DocumentCleanup';
import type { CleanupCategory, CleanupControl, CleanupOptions, CleanupReport, CleanupResult } from '../../core/DocumentCleanupTypes';
import { DecorationPDFPreview } from './DecorationPDFPreview';
import { CleanVisibleCopyPanel } from './CleanVisibleCopyPanel';
import type { CleanDocumentDialogProps, CleanDocumentSource } from './CleanDocumentDialogTypes';
import './CleanDocumentDialog.css';
export type { CleanDocumentDialogProps, CleanDocumentSource } from './CleanDocumentDialogTypes';

const categories: Array<{ key: CleanupCategory; label: string; description: string }> = [
  { key: 'metadata', label: 'Document metadata', description: 'Remove document properties and identified metadata.' },
  { key: 'attachments', label: 'Attachments', description: 'Remove embedded files and their attachment entries.' },
  { key: 'activeContent', label: 'Scripts and active content', description: 'Remove automatic scripts, unsafe actions and multimedia. Ordinary web links and internal page links can be removed separately.' },
  { key: 'comments', label: 'Comments and annotations', description: 'Remove comments and annotation marks, including your current editable annotations. Visible marks may disappear.' },
  { key: 'links', label: 'Links', description: 'Remove clickable links. Their underlying page text remains.' },
  { key: 'forms', label: 'Form fields and values', description: 'Remove fields, widgets, entered values and defaults. Visible form content and interaction will be lost.' },
  { key: 'privateData', label: 'Private application data', description: 'Remove identified application data and decoration editing templates. Visible decorations remain, but cannot be managed as templates.' },
];
const emptyOptions: CleanupOptions = { metadata: false, attachments: false, activeContent: false, comments: false, links: false, forms: false, privateData: false };
const defaultOptions: CleanupOptions = { ...emptyOptions, metadata: true, attachments: true, activeContent: true };
const zeroCounts: Record<CleanupCategory, number> = { metadata: 0, attachments: 0, activeContent: 0, comments: 0, links: 0, forms: 0, privateData: 0 };
type Progress = Parameters<NonNullable<CleanupControl['onProgress']>>[0];
interface Loaded { key: object; source: CleanDocumentSource; report: CleanupReport }

export function CleanDocumentDialog(props: CleanDocumentDialogProps) {
  const [session, setSession] = useState({ key: props.documentKey, sequence: 0 });
  if (!Object.is(session.key, props.documentKey)) { setSession({ key: props.documentKey, sequence: session.sequence + 1 }); return null; }
  return <CleanDocumentSession key={session.sequence} {...props} />;
}
function CleanDocumentSession({ revision, currentPage, readPDF, onApply, onClose }: CleanDocumentDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null), firstTab = useRef<HTMLButtonElement>(null);
  const active = useRef(false), committing = useRef(false), closeAfterCancel = useRef(false), currentRevision = useRef(revision);
  const operation = useRef<AbortController | null>(null), saveLatest = useRef<() => Promise<void>>(async () => {});
  const [tab, setTab] = useState<'native' | 'visible'>('native'), [copyBusy, setCopyBusy] = useState(false);
  const [reload, setReload] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null), [loadError, setLoadError] = useState<{ key: object; error: string } | null>(null);
  const loadKey = useMemo(() => ({ revision, readPDF, reload }), [revision, readPDF, reload]);
  const current = loaded?.key === loadKey ? loaded : null;
  const [options, setOptions] = useState<CleanupOptions>(defaultOptions), [pageNumber, setPageNumber] = useState(currentPage), [showAfter, setShowAfter] = useState(true);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null), [progress, setProgress] = useState<Progress | null>(null);
  const previewKey = useMemo(() => ({ current, options }), [current, options]);
  const [preview, setPreview] = useState<{ key: object; data?: Uint8Array; result?: CleanupResult; error?: string } | null>(null);
  const [before, setBefore] = useState<{ source: CleanDocumentSource; data?: Uint8Array; error?: string } | null>(null);
  const currentPreview = preview?.key === previewKey ? preview : null;
  const beforePreview = before?.source === current?.source ? before : null;
  const counts = current ? { ...current.report.counts, comments: current.report.counts.comments + current.source.workspaceAnnotations.count } : zeroCounts;
  const selectedCount = categories.reduce((sum, item) => sum + (options[item.key] ? counts[item.key] : 0), 0);
  const canApply = !!current?.report.canClean && selectedCount > 0 && !!currentPreview?.data && !!currentPreview.result && !busy && !copyBusy;

  useLayoutEffect(() => { currentRevision.current = revision; });
  useEffect(() => {
    active.current = true; const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal(); firstTab.current?.focus();
    return () => { active.current = false; operation.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const source = await readPDF(request.signal); if (request.signal.aborted) return;
        const report = source.report ?? await inspectPDFCleanup(source.data, { signal: request.signal });
        if (request.signal.aborted) return;
        setLoaded({ key: loadKey, source, report }); setLoadError(null); setError(null); setOptions(defaultOptions);
        setPageNumber(previous => Math.max(1, Math.min(previous, report.pageCount)));
      } catch (cause) { if (!request.signal.aborted) setLoadError({ key: loadKey, error: cause instanceof Error ? cause.message : 'Could not scan this document.' }); }
    })();
    return () => request.abort();
  }, [loadKey, readPDF]);
  useEffect(() => {
    if (!current || tab !== 'native') return;
    const request = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const result: CleanupResult = current.report.canClean && selectedCount ? await cleanPDF(current.source.data, options, { expectedRevision: current.report.revision, signal: request.signal })
          : { data: new Uint8Array(current.source.data), report: current.report, removed: zeroCounts };
        if (request.signal.aborted) return;
        const data = await current.source.preparePreview(result.data, options, request.signal);
        if (!request.signal.aborted) setPreview({ key: previewKey, data, result });
      } catch (cause) { if (!request.signal.aborted) setPreview({ key: previewKey, error: cause instanceof Error ? cause.message : 'Could not preview cleanup.' }); }
    })(); }, selectedCount ? 250 : 0);
    return () => { clearTimeout(timer); request.abort(); };
  }, [current, tab, options, selectedCount, previewKey]);
  useEffect(() => {
    if (!current || tab !== 'native' || showAfter || beforePreview) return;
    const request = new AbortController();
    void current.source.preparePreview(new Uint8Array(current.source.data), emptyOptions, request.signal).then(data => {
      if (!request.signal.aborted) setBefore({ source: current.source, data });
    }, cause => { if (!request.signal.aborted) setBefore({ source: current.source, error: cause instanceof Error ? cause.message : 'Could not preview the current document.' }); });
    return () => request.abort();
  }, [current, tab, showAfter, beforePreview]);
  const close = () => {
    if (committing.current) return;
    if (operation.current) { closeAfterCancel.current = true; operation.current.abort(); setCanceling(true); }
    else onClose();
  };
  const apply = async () => {
    if (!canApply || operation.current || !current) return;
    const request = new AbortController(), startedRevision = revision; operation.current = request;
    closeAfterCancel.current = false; setBusy(true); setError(null); setProgress(null);
    try {
      await onApply(options, request.signal, () => {
        if (!active.current || request.signal.aborted || currentRevision.current !== startedRevision) throw new DOMException('Cleanup canceled.', 'AbortError');
        committing.current = true; setSaving(true);
      }, value => { if (active.current && !request.signal.aborted) setProgress(value); });
      if (active.current && !request.signal.aborted) onClose();
    } catch (cause) { if (active.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not apply cleanup.'); }
    finally {
      if (operation.current === request) operation.current = null; committing.current = false;
      if (active.current) { setBusy(false); setSaving(false); setCanceling(false); if (closeAfterCancel.current) onClose(); }
    }
  };
  useLayoutEffect(() => { saveLatest.current = apply; });
  const shown = showAfter ? currentPreview : beforePreview;
  const remaining = currentPreview?.result ? Object.values(currentPreview.result.report.counts).reduce((sum, value) => sum + value, 0) + (options.comments ? 0 : current?.source.workspaceAnnotations.count ?? 0) : null;
  return <dialog ref={dialog} className="clean-document-dialog" aria-labelledby="clean-document-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
    event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (tab === 'native') void saveLatest.current(); }
  }}>
    <header><div><h2 id="clean-document-title">Clean Document</h2><p>Review identified content, or save a new copy of the visible pages.</p></div><button type="button" aria-label="Close document cleanup" disabled={saving || canceling} onClick={close}>×</button></header>
    <div className="clean-tabs" role="tablist" aria-label="Cleanup method" onKeyDown={event => {
      if (!busy && !copyBusy && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 'native' : event.key === 'End' ? 'visible' : tab === 'native' ? 'visible' : 'native';
        setTab(next); document.getElementById(`clean-${next}-tab`)?.focus();
      }
    }}>
      <button ref={firstTab} id="clean-native-tab" type="button" role="tab" tabIndex={tab === 'native' ? 0 : -1} aria-selected={tab === 'native'} aria-controls="clean-native-panel" disabled={busy || copyBusy} onClick={() => setTab('native')}>Review &amp; remove</button>
      <button id="clean-visible-tab" type="button" role="tab" tabIndex={tab === 'visible' ? 0 : -1} aria-selected={tab === 'visible'} aria-controls="clean-visible-panel" disabled={busy || copyBusy} onClick={() => setTab('visible')}>Save visible copy</button>
    </div>
    {!current && loadError?.key !== loadKey && <p role="status" className="clean-loading">Preparing current edits and scanning the PDF…</p>}
    {loadError?.key === loadKey && <div className="clean-loading"><p role="alert" className="clean-error">{loadError.error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry</button></div>}
    {current && <>
      <section role="tabpanel" id="clean-native-panel" aria-labelledby="clean-native-tab" className="clean-panel" hidden={tab !== 'native'}>
        <div className="clean-body">
          <div className="clean-settings"><h3>Choose what to remove</h3>
            <p className="clean-help">Selections apply to the whole document. This scan identifies supported PDF features; it does not detect every kind of hidden page content.</p>
            {!current.report.canClean && <p role="status" className="clean-notice">{current.report.unsupportedReason || 'Selective cleanup is unavailable for this document.'}</p>}
            <fieldset disabled={busy || !current.report.canClean}>
              {categories.map(category => {
                const findings = current.report.findings.filter(item => item.category === category.key);
                return <div key={category.key} className="clean-category">
                  <label className="clean-category-label"><input type="checkbox" aria-label={category.label} checked={options[category.key]} disabled={!counts[category.key]} onChange={event => { setOptions(previous => ({ ...previous, [category.key]: event.target.checked })); setError(null); }} /><span>{category.label}</span><span className="clean-category-count">{counts[category.key]} found</span></label>
                  <p className="clean-help">{category.description}</p>
                  {counts[category.key] > 0 && <details><summary>Review {category.label.toLowerCase()}</summary><ul>{findings.map(item => <li key={item.id}>{item.label}{item.pages.length > 0 && <> · Page {item.pages.join(', ')}</>}{item.details && <p>{item.details}</p>}{item.affectsAppearance && <p className="clean-help">May change visible page content.</p>}</li>)}
                    {category.key === 'comments' && current.source.workspaceAnnotations.count > 0 && <li>Current editable annotations: {current.source.workspaceAnnotations.count}{current.source.workspaceAnnotations.pages.length > 0 && <> · Page {current.source.workspaceAnnotations.pages.join(', ')}</>}</li>}
                  </ul></details>}
                </div>;
              })}
            </fieldset>
            {current.report.limitations.length > 0 && <details><summary>Scan limitations</summary><ul className="clean-help">{current.report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
          </div>
          <div className="clean-preview" aria-label="Cleanup preview"><div className="clean-preview-toolbar">
            <label>Preview page<select value={pageNumber} disabled={busy} onChange={event => setPageNumber(Number(event.target.value))}>{Array.from({ length: current.report.pageCount }, (_, index) => <option key={index} value={index + 1}>Page {index + 1}</option>)}</select></label>
            <div className="clean-preview-toggle"><button type="button" aria-pressed={!showAfter} onClick={() => setShowAfter(false)}>Current</button><button type="button" aria-pressed={showAfter} onClick={() => setShowAfter(true)}>After cleanup</button></div>
            <p role="status">{shown?.data ? showAfter ? 'Cleanup preview ready' : 'Current document preview' : shown?.error ? 'Preview unavailable' : 'Preparing preview…'}</p>
          </div>{shown?.data && <DecorationPDFPreview data={shown.data} pageNumber={pageNumber} onError={message => { if (showAfter) setPreview({ key: previewKey, error: message }); else setBefore({ source: current.source, error: message }); }} />}
            {shown?.error && <p role="alert" className="clean-error">{shown.error}</p>}
          </div>
        </div>
        <footer>{error && <p role="alert" className="clean-error">{error}</p>}
          {busy ? <div className="clean-progress" role="status"><progress max={progress?.total || 1} value={progress?.completed} /><span>{canceling ? 'Canceling cleanup…' : saving ? 'Saving the cleaned document…' : progress ? `${{ inspect: 'Checking document', clean: 'Removing selected items', verify: 'Verifying cleanup', save: 'Rewriting PDF' }[progress.phase]}: ${progress.completed} / ${progress.total}` : 'Applying cleanup…'}</span></div>
            : <p>{selectedCount} identified {selectedCount === 1 ? 'item' : 'items'} selected.{remaining !== null && <> {remaining} remain after this cleanup.</>}</p>}
          <p className="clean-help">The original file and this workspace's undo history remain available. Cleanup is not an erasure of those copies.</p>
          <div><button type="button" disabled={saving || canceling} onClick={close}>{busy ? 'Cancel cleanup' : 'Close'}</button><button type="button" className="clean-primary" disabled={!canApply} onClick={() => void apply()}>Apply cleanup</button></div>
        </footer>
      </section>
      <CleanVisibleCopyPanel key={revision} source={current.source} currentPage={pageNumber} active={tab === 'visible'} onClose={close} onBusy={setCopyBusy} />
    </>}
  </dialog>;
}
export default CleanDocumentDialog;
