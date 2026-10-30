import { useLocaleStore } from '../../i18n';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateMessage, translateError } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { PDF_BOOKMARK_LIMITS, type PDFBookmarkDefinition, type PDFBookmarkInfo } from '../../core/PDFBookmarksTypes';
import { PDFLinksPreview } from './PDFLinksPreview';
import { PDFBookmarksSettings } from './PDFBookmarksSettings';
import { bookmarkDraft, findBookmark, flattenBookmarks, movableBookmark, moveBookmark } from './pdfBookmarksDraft';
import type { PDFBookmarksDialogProps, PDFBookmarksSource } from './PDFBookmarksDialogTypes';
import './PDFLinksDialog.css';
import './PDFBookmarksDialog.css';
export type { PDFBookmarksDialogProps, PDFBookmarksSource } from './PDFBookmarksDialogTypes';
interface Loaded { key: object; source: PDFBookmarksSource }
const noop = () => {};
export function PDFBookmarksDialog(props: PDFBookmarksDialogProps) {
  useLocale();
  const [committingSequence, setCommittingSequence] = useState<number | null>(null);
  const [session, setSession] = useState({ key: props.documentKey, revision: props.revision, sequence: 0 });
  if (!Object.is(session.key, props.documentKey) || session.revision !== props.revision) {
    const ownCommit = Object.is(session.key, props.documentKey) && committingSequence === session.sequence;
    setSession({ key: props.documentKey, revision: props.revision, sequence: session.sequence + (ownCommit ? 0 : 1) }); return null;
  }
  return <BookmarksSession key={session.sequence} {...props} onCommitState={value => setCommittingSequence(previous => value ? session.sequence : previous === session.sequence ? null : previous)} />;
}
function BookmarksSession({ currentPage, readPDF, onApply, onClose, onCommitState }: PDFBookmarksDialogProps & { onCommitState: (value: boolean) => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), list = useRef<HTMLSelectElement>(null), active = useRef(false), committing = useRef(false), saveLatest = useRef<() => Promise<void>>(async () => {});
  const reading = useRef<AbortController | null>(null), previewRequest = useRef<AbortController | null>(null), applying = useRef<AbortController | null>(null);
  const [retry, setRetry] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null), [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const loadKey = useMemo(() => ({ readPDF, retry }), [readPDF, retry]), current = loaded?.key === loadKey ? loaded : null;
  const [bookmarks, setBookmarks] = useState<PDFBookmarkInfo[]>([]), [selectedId, setSelectedId] = useState<string | null>(null), [pageNumber, setPageNumber] = useState(currentPage), [zoom, setZoom] = useState('fit');
  const [dirtyNumbers, setDirtyNumbers] = useState<Set<string>>(() => new Set()), [saving, setSaving] = useState(false), [committed, setCommitted] = useState(false), [saveError, setSaveError] = useState<string | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const flattened = useMemo(() => flattenBookmarks(bookmarks), [bookmarks]);
  const selected = selectedId ? findBookmark(bookmarks, selectedId)?.item : undefined;
  const tree = useMemo(() => bookmarkDraft(bookmarks), [bookmarks]);
  const originalTree = useMemo(() => current ? bookmarkDraft(current.source.report.bookmarks) : [], [current]);
  const changed = JSON.stringify(tree) !== JSON.stringify(originalTree), requestKey = useMemo(() => ({ current, tree }), [current, tree]), latestKey = useRef(requestKey);
  const [preview, setPreview] = useState<{ key: object; source: Loaded; data: Uint8Array } | null>(null), [previewError, setPreviewError] = useState<{ key: object; message: string } | null>(null);
  const sourceBytes = useMemo(() => current ? new Uint8Array(current.source.data) : null, [current]), shownData = preview?.source === current ? preview.data : sourceBytes;
  const displayKey = useMemo(() => ({ data: shownData, pageNumber, zoom }), [shownData, pageNumber, zoom]);
  const [renderedKey, setRenderedKey] = useState<object | null>(null), [renderError, setRenderError] = useState<{ key: object; message: string } | null>(null);
  const ready = preview?.key === requestKey && renderedKey === displayKey && renderError?.key !== displayKey;
  const editable = !!current?.source.report.canEdit, canApply = editable && changed && ready && !saving && !dirtyNumbers.size;
  const deletionItems = selected ? flattenBookmarks([selected]) : [], canDelete = deletionItems.length > 0 && deletionItems.every(row => row.item.removable);
  useLayoutEffect(() => { latestKey.current = requestKey; });
  useEffect(() => {
    active.current = true; const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; element?.showModal();
    return () => { active.current = false; reading.current?.abort(); previewRequest.current?.abort(); applying.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const request = new AbortController(); reading.current = request;
    void readPDF(request.signal).then(source => {
      if (request.signal.aborted) return;
      setLoaded({ key: loadKey, source }); setBookmarks(structuredClone(source.report.bookmarks)); setSelectedId(null); setDirtyNumbers(new Set()); setSaveError(null); setLoadError(null); setDeleting(null);
      setPageNumber(previous => Math.max(1, Math.min(previous, source.report.pages.length))); requestAnimationFrame(() => { if (!request.signal.aborted) list.current?.focus(); });
    }).catch(cause => { if (!request.signal.aborted) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not inspect PDF bookmarks.' }); });
    return () => request.abort();
  }, [readPDF, loadKey]);
  useEffect(() => {
    if (!current || dirtyNumbers.size) return;
    const request = new AbortController(); previewRequest.current = request;
    const timer = window.setTimeout(() => { void current.source.preview(tree, request.signal).then(data => { if (!request.signal.aborted) { setPreview({ key: requestKey, source: current, data }); setPreviewError(null); } }).catch(cause => { if (!request.signal.aborted) setPreviewError({ key: requestKey, message: cause instanceof Error ? cause.message : 'Could not preview these bookmarks.' }); }); }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [current, tree, requestKey, dirtyNumbers.size]);
  const numberDraft = (label: string, dirty: boolean) => setDirtyNumbers(previous => { if (previous.has(label) === dirty) return previous; const next = new Set(previous); if (dirty) next.add(label); else next.delete(label); return next; });
  const select = (id: string | null) => { setSelectedId(id); setDirtyNumbers(new Set()); setDeleting(null); const target = id ? findBookmark(bookmarks, id)?.item.definition.target : null; if (target?.type === 'page') setPageNumber(target.pageNumber); };
  const change = (definition: PDFBookmarkDefinition) => {
    if (!selected?.editable || !editable || saving) return;
    if (selected.definition.target?.type !== definition.target?.type || (selected.definition.target?.type === 'page' && definition.target?.type === 'page' && selected.definition.target.view !== definition.target.view)) setDirtyNumbers(new Set());
    const next = structuredClone(bookmarks); findBookmark(next, selected.id)!.item.definition = definition; setBookmarks(next); setSaveError(null);
    if (definition.target?.type === 'page') setPageNumber(definition.target.pageNumber);
  };
  const add = () => {
    if (!editable || saving || flattened.length >= PDF_BOOKMARK_LIMITS.bookmarks) return;
    const id = `draft-${crypto.randomUUID()}`, item: PDFBookmarkInfo = { id, definition: { title: 'New bookmark', target: { type: 'page', pageNumber, view: 'Fit' }, bold: false, italic: false, color: '#000000', expanded: true }, children: [], editable: true, removable: true, movable: true };
    setBookmarks(previous => [...previous, item]); setSelectedId(id); setDirtyNumbers(new Set()); setDeleting(null); setSaveError(null);
  };
  const move = (direction: 'up' | 'down' | 'indent' | 'outdent') => { if (!selected || !editable || saving) return; setBookmarks(previous => moveBookmark(previous, selected.id, direction)); setDeleting(null); setSaveError(null); };
  const remove = () => {
    if (!selected || !editable || saving || !canDelete) return;
    const next = structuredClone(bookmarks), found = findBookmark(next, selected.id)!; found.siblings.splice(found.index, 1); setBookmarks(next); setSelectedId(null); setDeleting(null); setDirtyNumbers(new Set()); setSaveError(null);
  };
  const close = () => { if (committing.current) return; reading.current?.abort(); previewRequest.current?.abort(); applying.current?.abort(); onClose(); };
  const apply = async () => {
    if (!canApply || applying.current || latestKey.current !== requestKey) return;
    const request = new AbortController(); applying.current = request; setSaving(true); setSaveError(null);
    try {
      await onApply(structuredClone(tree), request.signal, () => { request.signal.throwIfAborted(); if (!active.current || latestKey.current !== requestKey) throw new Error('The document changed. Reopen Bookmarks.'); committing.current = true; setCommitted(true); onCommitState(true); });
      if (active.current && !request.signal.aborted) onClose();
    } catch (cause) { if (active.current && !request.signal.aborted) setSaveError(cause instanceof Error ? cause.message : 'Could not apply PDF bookmarks.'); }
    finally { if (applying.current === request) applying.current = null; committing.current = false; if (active.current) { setSaving(false); setCommitted(false); onCommitState(false); } }
  };
  useLayoutEffect(() => { saveLatest.current = apply; });
  const failure = loadError?.key === loadKey ? loadError.message : null;
  return <dialog ref={dialog} className="pdf-bookmarks-dialog" aria-labelledby="pdf-bookmarks-title" onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); const input = document.activeElement; if (input instanceof HTMLInputElement && input.type === 'number') flushSync(() => input.blur()); void saveLatest.current(); } }}>
    <header><div><h2 id="pdf-bookmarks-title">{t("m.bookmarks.ca3cdd")}</h2><p>{t("m.organize.document.navigation.and.apply.the.compl.ee667d")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.bookmarks.51f2a0")} disabled={committed} onClick={close}>×</button></header>
    {!current && !failure && <p className="bookmark-loading" role="status">{t("m.inspecting.pdf.bookmarks.1c725b")}</p>}
    {failure && <div className="bookmark-loading"><p className="bookmark-error" role="alert">{translateError(failure)}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("m.retry.9f5cd8")}</button></div>}
    {current && <div className="bookmark-body"><section className="bookmark-preview-column" aria-label={t("m.bookmark.page.preview.9a23ba")}>
      <div className="bookmark-preview-toolbar"><label>{t("m.preview.page.d24958")}<select value={pageNumber} disabled={saving} onChange={event => setPageNumber(Number(event.target.value))}>{current.source.report.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>{t("m.page.fb0627")}{' '}{page.pageNumber}</option>)}</select></label><label>{t("m.preview.zoom.e32787")}<select value={zoom} disabled={saving} onChange={event => setZoom(event.target.value)}><option value="fit">{t("m.fit.width.0071b9")}</option><option value="1">100%</option><option value="2">200%</option></select></label><p className="bookmark-help">{t("m.select.a.bookmark.to.preview.its.destination.pag.f8f200")}</p></div>
      {shownData && <PDFLinksPreview data={shownData} pageNumber={pageNumber} links={[]} selectedId={null} placing={false} disabled showAreas={false} scale={zoom === 'fit' ? undefined : Number(zoom)} onSelect={noop} onCreate={noop} onMove={noop} onDelete={noop} onInteractionChange={noop} onReady={() => setRenderedKey(displayKey)} onError={message => setRenderError({ key: displayKey, message })} />}
    </section><aside className="bookmark-settings" aria-label={t("m.bookmark.settings.b1536a")}>
      {!editable && <p className="bookmark-warning" role="status">{translateError(current.source.report.unsupportedReason) || t("m.this.document.can.be.inspected.but.not.modified.ef237e")}</p>}
      <label>{t("m.bookmarks.ca3cdd")}<select ref={list} size={6} value={selectedId ?? ''} disabled={saving || !!dirtyNumbers.size} onChange={event => select(event.target.value || null)}><option value="">{flattened.length ? t("m.choose.a.bookmark.6a63d2", { v0: flattened.length }) : t("m.no.bookmarks.yet.aaf8c3")}</option>{flattened.map(({ item, level }) => <option key={item.id} value={item.id}>{`${'　'.repeat(level)}${item.children.length ? '▸ ' : ''}${item.definition.title || t("m.untitled.65dcfc")}${!item.editable ? t("m.read.only.3ababd") : ''}`}</option>)}</select></label>
      <div className="bookmark-actions"><button type="button" disabled={!editable || saving || !!dirtyNumbers.size || flattened.length >= PDF_BOOKMARK_LIMITS.bookmarks} onClick={add}>{t("m.add.bookmark.5e57a7")}</button>{(['up', 'down', 'indent', 'outdent'] as const).map(direction => <button type="button" key={direction} disabled={!selected || !editable || saving || !!dirtyNumbers.size || !movableBookmark(bookmarks, selected.id, direction)} onClick={() => move(direction)}>{translateMessage(({ up: 'Move up', down: 'Move down', indent: 'Indent', outdent: 'Outdent' })[direction])}</button>)}</div>
      {selected ? <>
        {!selected.editable && <p className="bookmark-warning" role="status">{translateError(selected.unsupportedReason) || t("m.this.bookmark.cannot.be.edited.safely.16a802")}</p>}
        {selected.namedDestination && <p className="bookmark-help">{t("m.named.destination.aecf8b")}{' '}{selected.namedDestination}{t("m.other.bookmarks.using.this.name.remain.unchanged.cc1106")}</p>}
        {selected.editable && <PDFBookmarksSettings key={`${selected.id}-${selected.definition.target?.type ?? 'group'}-${selected.definition.target?.type === 'page' ? selected.definition.target.view : ''}`} definition={selected.definition} pages={current.source.report.pages} currentPage={pageNumber} disabled={!editable || saving} onChange={change} onNumericDraft={numberDraft} />}
        {deleting === selected.id ? <div className="bookmark-delete-confirm" role="group" aria-label={t("m.confirm.bookmark.deletion.8e0216")}><p>{t("m.delete.4b2675")}{selected.definition.title}”{deletionItems.length > 1 ? t("m.and.its.child.bookmark.e4a990", { v0: deletionItems.length - 1, v1: deletionItems.length > 2 ? 's' : '' }) : ''}{t("m.this.removes.ece6c1")}{' '}{deletionItems.length}{' '}{t("m.bookmark.200320")}{useLocaleStore.getState().locale === 'en' && deletionItems.length > 1 ? 's' : ''}.</p><button type="button" disabled={saving} onClick={remove}>{t("m.confirm.delete.c9f282")}</button><button type="button" disabled={saving} onClick={() => setDeleting(null)}>{t("m.keep.bookmarks.3c0a98")}</button></div> : <button type="button" className="bookmark-delete" disabled={!editable || saving || !canDelete || !!dirtyNumbers.size} onClick={() => setDeleting(selected.id)}>{t("m.delete.bookmark.608b7d")}</button>}
        {!canDelete && <p className="bookmark-help">{t("m.this.bookmark.or.a.descendant.is.protected.and.c.fceb8d")}</p>}
      </> : <p className="bookmark-help">{t("m.select.a.bookmark.to.edit.its.title.and.destinat.f73bf7")}</p>}
    </aside></div>}
    <footer>{current && <p className="bookmark-help" role="status">{saving ? committed ? t("m.opening.the.updated.pdf.31b55e") : t("m.applying.bookmarks.08e69f") : dirtyNumbers.size ? t("m.finish.numeric.input.to.update.the.preview.4415fd") : ready ? t("m.preview.ready.fa3fd8", { v0: changed ? ' · Unsaved changes' : '' }) : t("m.updating.pdf.preview.262ba0")}</p>}
      {previewError?.key === requestKey && <p className="bookmark-error" role="alert">{translateError(previewError.message)}</p>}{renderError?.key === displayKey && <p className="bookmark-error" role="alert">{translateError(renderError.message)}</p>}{saveError && <p className="bookmark-error" role="alert">{translateError(saveError)}</p>}
      <div><button type="button" disabled={committed} onClick={close}>{t("m.cancel.77dfd2")}</button><button type="button" className="bookmark-primary" disabled={!canApply} onClick={() => void apply()}>{t("m.apply.bookmarks.fe464b")}</button></div>
    </footer>
  </dialog>;
}
export default PDFBookmarksDialog;
