import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { inspectPDFLinksInWorker } from '../../core/PDFLinksClient';
import { PDF_LINK_LIMITS, type PDFLinkDefinition, type PDFLinkInfo, type PDFLinkInspection, type PDFLinkRect } from '../../core/PDFLinkTypes';
import { PDFLinksPreview } from './PDFLinksPreview';
import { PDFLinksSettings } from './PDFLinksSettings';
import { buildLinkOperations, fitLinkRect, linkSummary } from './pdfLinksDraft';
import type { PDFLinksDialogProps, PDFLinksSource } from './PDFLinksDialogTypes';
import './PDFLinksDialog.css';
export type { PDFLinksDialogProps, PDFLinksSource } from './PDFLinksDialogTypes';
interface Loaded { key: object; source: PDFLinksSource; report: PDFLinkInspection }
export function PDFLinksDialog(props: PDFLinksDialogProps) {
  const [committingSequence, setCommittingSequence] = useState<number | null>(null);
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision) {
    // Our atomic commit publishes a new revision before its promise resolves. Keep that
    // session alive to close normally, while external revisions still abort and reload.
    const ownCommit = Object.is(session.key, props.documentKey) && committingSequence === session.sequence;
    setSession({ key: props.documentKey, revision: props.revision, sequence: session.sequence + (ownCommit ? 0 : 1) }); return null;
  }
  return <PDFLinksSession key={session.sequence} {...props} onCommitState={value => setCommittingSequence(previous => value ? session.sequence : previous === session.sequence ? null : previous)} />;
}
function PDFLinksSession({ currentPage, readPDF, onApply, onClose, onCommitState }: PDFLinksDialogProps & { onCommitState: (value: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), pageInput = useRef<HTMLSelectElement>(null), active = useRef(false), committing = useRef(false);
  const reading = useRef<AbortController | null>(null), previewRequest = useRef<AbortController | null>(null), applying = useRef<AbortController | null>(null), saveLatest = useRef<() => Promise<void>>(async () => {});
  const [retry, setRetry] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null), [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const loadKey = useMemo(() => ({ readPDF, retry }), [readPDF, retry]), current = loaded?.key === loadKey ? loaded : null;
  const [links, setLinks] = useState<PDFLinkInfo[]>([]), [selectedId, setSelectedId] = useState<string | null>(null), [pageNumber, setPageNumber] = useState(currentPage), [filter, setFilter] = useState('all');
  const [placing, setPlacing] = useState(false), [dragging, setDragging] = useState(false), [showAreas, setShowAreas] = useState(true), [zoom, setZoom] = useState('fit');
  const [dirtyNumbers, setDirtyNumbers] = useState<Set<string>>(() => new Set()), [saving, setSaving] = useState(false), [committed, setCommitted] = useState(false), [saveError, setSaveError] = useState<string | null>(null);
  const selected = links.find(item => item.id === selectedId), operations = useMemo(() => current ? buildLinkOperations(current.report.links, links) : [], [current, links]);
  const requestKey = useMemo(() => ({ current, operations }), [current, operations]), latestKey = useRef(requestKey);
  const [preview, setPreview] = useState<{ key: object; source: Loaded; data: Uint8Array } | null>(null), [previewError, setPreviewError] = useState<{ key: object; message: string } | null>(null);
  const sourceBytes = useMemo(() => current ? new Uint8Array(current.source.data) : null, [current]), shownData = preview?.source === current ? preview.data : sourceBytes;
  const displayKey = useMemo(() => ({ data: shownData, pageNumber, zoom }), [shownData, pageNumber, zoom]);
  const [renderedKey, setRenderedKey] = useState<object | null>(null), [renderError, setRenderError] = useState<{ key: object; message: string } | null>(null);
  const ready = preview?.key === requestKey && renderedKey === displayKey && renderError?.key !== displayKey;
  const canApply = !!current?.report.canEdit && operations.length > 0 && ready && !saving && !dragging && !dirtyNumbers.size;
  const filtered = filter === 'all' ? links : links.filter(item => item.pageNumber === Number(filter));
  const previewItems = useMemo(() => links.map(item => ({ id: item.id, label: item.definition ? linkSummary(item.definition) : item.summary, pageNumber: item.pageNumber, rect: item.rect ?? undefined, editable: item.editable })), [links]);
  useLayoutEffect(() => { latestKey.current = requestKey; });
  useEffect(() => {
    active.current = true; const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; element?.showModal();
    return () => { active.current = false; reading.current?.abort(); previewRequest.current?.abort(); applying.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const request = new AbortController(); reading.current = request;
    void (async () => {
      try {
        const source = await readPDF(request.signal); request.signal.throwIfAborted();
        const report = source.report ?? await inspectPDFLinksInWorker(source.data, { signal: request.signal }); request.signal.throwIfAborted();
        setLoaded({ key: loadKey, source, report }); setLinks(structuredClone(report.links)); setSelectedId(null); setPlacing(false); setDirtyNumbers(new Set()); setSaveError(null); setLoadError(null);
        setPageNumber(previous => Math.max(1, Math.min(previous, report.pages.length))); requestAnimationFrame(() => { if (!request.signal.aborted) pageInput.current?.focus(); });
      } catch (cause) { if (!request.signal.aborted) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not inspect PDF links.' }); }
    })(); return () => request.abort();
  }, [readPDF, loadKey]);
  useEffect(() => {
    if (!current || dragging || dirtyNumbers.size) return;
    const request = new AbortController(); previewRequest.current = request;
    const timer = window.setTimeout(() => { void current.source.preview(operations, request.signal).then(data => { if (!request.signal.aborted) { setPreview({ key: requestKey, source: current, data }); setPreviewError(null); } }).catch(cause => { if (!request.signal.aborted) setPreviewError({ key: requestKey, message: cause instanceof Error ? cause.message : 'Could not preview these links.' }); }); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [current, operations, requestKey, dragging, dirtyNumbers.size]);
  const numberDraft = (label: string, dirty: boolean) => setDirtyNumbers(previous => { if (previous.has(label) === dirty) return previous; const next = new Set(previous); if (dirty) next.add(label); else next.delete(label); return next; });
  const select = (id: string | null) => {
    setSelectedId(id); setDirtyNumbers(new Set()); setPlacing(false);
    const link = links.find(item => item.id === id); if (link && current?.report.pages.some(page => page.pageNumber === link.pageNumber)) { setPageNumber(link.pageNumber); if (filter !== 'all' && filter !== String(link.pageNumber)) setFilter(String(link.pageNumber)); }
  };
  const change = (id: string, definition: PDFLinkDefinition) => {
    if (saving || !current?.report.canEdit) return;
    const original = links.find(item => item.id === id); if (!original?.editable) return;
    if (original.definition?.target.type !== definition.target.type || original.definition.pageNumber !== definition.pageNumber || (original.definition.target.type === 'page' && definition.target.type === 'page' && original.definition.target.view !== definition.target.view)) setDirtyNumbers(new Set());
    setLinks(previous => previous.map(item => item.id === id ? { ...item, definition, pageNumber: definition.pageNumber, rect: definition.rect, summary: linkSummary(definition) } : item)); setSaveError(null);
    if (original.pageNumber !== definition.pageNumber) setPageNumber(definition.pageNumber);
  };
  const create = (rect: PDFLinkRect) => {
    if (saving || !current?.report.canEdit || links.length >= PDF_LINK_LIMITS.links) return;
    const id = `draft-${crypto.randomUUID()}`, definition: PDFLinkDefinition = { pageNumber, rect, target: { type: 'url', url: 'https://' }, border: { width: 0, color: '#000000', style: 'solid' } };
    setLinks(previous => [...previous, { id, pageNumber, rect, definition, editable: true, removable: true, summary: 'New URL link' }]); setSelectedId(id); setPlacing(false); setShowAreas(true); setFilter('all'); setDirtyNumbers(new Set()); setSaveError(null);
  };
  const remove = (id: string) => {
    if (saving || !current?.report.canEdit || !links.find(item => item.id === id)?.removable) return;
    setLinks(previous => previous.filter(item => item.id !== id)); if (selectedId === id) { setSelectedId(null); setDirtyNumbers(new Set()); } setSaveError(null);
  };
  const close = () => { if (committing.current) return; reading.current?.abort(); previewRequest.current?.abort(); applying.current?.abort(); onClose(); };
  const apply = async () => {
    if (!canApply || applying.current || latestKey.current !== requestKey) return;
    const request = new AbortController(); applying.current = request; setSaving(true); setSaveError(null);
    try {
      await onApply(structuredClone(operations), request.signal, () => { request.signal.throwIfAborted(); if (!active.current || latestKey.current !== requestKey) throw new Error('The document changed. Reopen Links.'); committing.current = true; setCommitted(true); onCommitState(true); });
      if (active.current && !request.signal.aborted) onClose();
    } catch (cause) { if (active.current && !request.signal.aborted) setSaveError(cause instanceof Error ? cause.message : 'Could not apply PDF links.'); }
    finally { if (applying.current === request) applying.current = null; committing.current = false; if (active.current) { setSaving(false); setCommitted(false); onCommitState(false); } }
  };
  useLayoutEffect(() => { saveLatest.current = apply; });
  const failure = loadError?.key === loadKey ? loadError.message : null;
  return <dialog ref={dialog} className="pdf-links-dialog" aria-labelledby="pdf-links-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
    event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); const input = document.activeElement; if (input instanceof HTMLInputElement && input.type === 'number') flushSync(() => input.blur()); void saveLatest.current(); }
  }}>
    <header><div><h2 id="pdf-links-title">Links</h2><p>Create and edit native PDF links. Apply all changes together after reviewing the page.</p></div><button type="button" aria-label="Close links" disabled={committed} onClick={close}>×</button></header>
    {!current && !failure && <p className="pdf-links-loading" role="status">Inspecting PDF links…</p>}
    {failure && <div className="pdf-links-loading"><p className="pdf-links-error" role="alert">{failure}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
    {current && <div className="pdf-links-body"><section className="pdf-links-preview-column" aria-label="PDF link preview">
      <div className="pdf-links-preview-toolbar">
        <label>Preview page<select ref={pageInput} value={pageNumber} disabled={saving || dragging} onChange={event => { setPageNumber(Number(event.target.value)); setPlacing(false); }}>{current.report.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>Page {page.pageNumber}</option>)}</select></label>
        <label>Preview zoom<select value={zoom} disabled={saving || dragging} onChange={event => setZoom(event.target.value)}><option value="fit">Fit width</option><option value="1">100%</option><option value="2">200%</option></select></label>
        <button type="button" disabled={saving || !current.report.canEdit || !!dirtyNumbers.size || links.length >= PDF_LINK_LIMITS.links} aria-pressed={placing} onClick={() => { setPlacing(value => !value); setShowAreas(true); }}>Add link</button>
        {placing && <button type="button" disabled={saving} onClick={() => { const page = current.report.pages.find(item => item.pageNumber === pageNumber)!; create(fitLinkRect({ x: (page.width - 120) / 2, y: (page.height - 28) / 2, width: 120, height: 28 }, page.width, page.height)); }}>Place at page center</button>}
        <label className="pdf-links-check"><input type="checkbox" checked={showAreas} disabled={saving || placing || dragging} onChange={event => setShowAreas(event.target.checked)} />Show link areas</label>
        <p className="pdf-links-help">{placing ? 'Click or drag on the page to draw a new clickable area.' : 'Select an area to edit. Drag to move, use the corner to resize, or use arrow keys. Links are not opened here.'}</p>
      </div>
      {shownData && <PDFLinksPreview data={shownData} pageNumber={pageNumber} links={previewItems} selectedId={selectedId} placing={placing} showAreas={showAreas} scale={zoom === 'fit' ? undefined : Number(zoom)} disabled={saving || !!dirtyNumbers.size || !current.report.canEdit} onSelect={select} onCreate={create} onMove={(id, rect) => { const item = links.find(link => link.id === id); if (item?.definition) change(id, { ...item.definition, rect }); }} onDelete={remove} onInteractionChange={setDragging} onReady={() => setRenderedKey(displayKey)} onError={message => setRenderError({ key: displayKey, message })} />}
    </section><aside className="pdf-links-settings" aria-label="Link settings">
      {!current.report.canEdit && <p className="pdf-links-warning" role="status">{current.report.unsupportedReason || 'This document can be inspected but not modified.'}</p>}
      <label>Links on page<select value={filter} disabled={saving} onChange={event => { setFilter(event.target.value); select(null); }}><option value="all">All pages</option>{current.report.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>Page {page.pageNumber}</option>)}</select></label>
      <label>Links<select aria-label="Links" value={filtered.some(item => item.id === selectedId) ? selectedId! : ''} disabled={saving} onChange={event => select(event.target.value || null)}><option value="">Choose a link ({filtered.length})</option>{filtered.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. Page {item.pageNumber} · {item.summary}{!item.editable ? ' (read only)' : ''}</option>)}</select></label>
      {selected ? <>
        {!selected.editable && <p className="pdf-links-warning" role="status">{selected.unsupportedReason || 'This link uses a destination or appearance that cannot be edited safely.'}{selected.removable && ' You can explicitly delete this link.'}</p>}
        {selected.namedDestination && <p className="pdf-links-help">Named destination: {selected.namedDestination}. Editing this link keeps the original named destination available to other links.</p>}
        {selected.editable && selected.definition && <PDFLinksSettings key={`${selected.id}-${selected.definition.pageNumber}-${selected.definition.target.type}-${selected.definition.target.type === 'page' ? selected.definition.target.view : ''}`} definition={selected.definition} pages={current.report.pages} disabled={saving || !current.report.canEdit} onChange={definition => change(selected.id, definition)} onNumericDraft={numberDraft} />}
        <button type="button" className="pdf-links-delete" disabled={saving || !current.report.canEdit || !selected.removable} onClick={() => remove(selected.id)}>Delete link</button>
      </> : <p className="pdf-links-help">{links.length ? 'Choose a link from the list or select its area on the page.' : 'This PDF has no links. Use Add link to draw a clickable area.'}</p>}
    </aside></div>}
    <footer>
      {current && <p className="pdf-links-help" role="status">{saving ? committed ? 'Opening the updated PDF…' : 'Applying links…' : dirtyNumbers.size ? 'Finish numeric input to update the preview.' : dragging ? 'Release the area to update the PDF preview.' : ready ? `Preview ready${operations.length ? ` · ${operations.length} pending change${operations.length === 1 ? '' : 's'}` : ''}` : 'Updating PDF preview…'}</p>}
      {previewError?.key === requestKey && <p className="pdf-links-error" role="alert">{previewError.message}</p>}{renderError?.key === displayKey && <p className="pdf-links-error" role="alert">{renderError.message}</p>}{saveError && <p className="pdf-links-error" role="alert">{saveError}</p>}
      <div><button type="button" disabled={committed} onClick={close}>Cancel</button><button type="button" className="pdf-links-primary" disabled={!canApply} onClick={() => void apply()}>Apply links</button></div>
    </footer>
  </dialog>;
}
export default PDFLinksDialog;
