import { ErrorMessage } from '../Feedback/ErrorMessage';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateMessage, translateError } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { applyPageDecorations, inspectPageDecorations } from '../../core/PageDecorations';
import type { PageDecorationDefinition, PageDecorationInspection, PageDecorationOperation } from '../../core/PageDecorationTypes';
import type { PDFImageInput } from '../../core/ImagePDF';
import { DecorationPDFPreview } from './DecorationPDFPreview';
import { PageDecorationSettings } from './PageDecorationSettings';
import { buildDecorationOperations, createDecorationDraft, decorationKindLabels, type DecorationDraft } from './decorationDraft';
import './PageDecorationsDialog.css';

export interface PageDecorationsDialogProps {
  documentKey: unknown; revision: number; currentPage: number;
  readPDF: () => Promise<ArrayBuffer | { data: ArrayBuffer; preparePreview?: (data: Uint8Array) => Promise<Uint8Array> }>;
  onApply: (operations: PageDecorationOperation[], signal: AbortSignal, onCommit: () => void) => Promise<void>;
  onClose: () => void;
}
interface Loaded { key: object; data: ArrayBuffer; inspection: PageDecorationInspection; preparePreview?: (data: Uint8Array) => Promise<Uint8Array> }
function imageOf(definition: PageDecorationDefinition): PDFImageInput | null {
  const image = definition.kind === 'watermark' && definition.content.type === 'image' ? definition.content
    : definition.kind === 'background' && definition.fill.type === 'image' ? definition.fill : null;
  return image && image.data.length ? image : null;
}
export function PageDecorationsDialog(props: PageDecorationsDialogProps) {
  useLocale();
  const [session, setSession] = useState({ key: props.documentKey, sequence: 0 });
  if (!Object.is(session.key, props.documentKey)) { setSession({ key: props.documentKey, sequence: session.sequence + 1 }); return null; }
  return <PageDecorationsSession key={session.sequence} {...props} />;
}
function PageDecorationsSession({ revision, currentPage, readPDF, onApply, onClose }: PageDecorationsDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), initialFocus = useRef<HTMLSelectElement>(null);
  const active = useRef(false), committing = useRef(false), closeAfterCancel = useRef(false), currentRevision = useRef(revision);
  const saveLatest = useRef<() => Promise<void>>(async () => {}), operation = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0), [loaded, setLoaded] = useState<Loaded | null>(null);
  const loadKey = useMemo(() => ({ revision, readPDF, reload }), [revision, readPDF, reload]);
  const [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const [drafts, setDrafts] = useState<DecorationDraft[]>([]), [selectedId, setSelectedId] = useState('');
  const [pageNumber, setPageNumber] = useState(currentPage);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [canceling, setCanceling] = useState(false), [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [validation, setValidation] = useState<string | null>(null);
  const current = loaded?.key === loadKey ? loaded : null;
  const operations = useMemo(() => current ? buildDecorationOperations(current.inspection.decorations, drafts) : [], [current, drafts]);
  const previewKey = useMemo(() => ({ current, operations, pageNumber, validation }), [current, operations, pageNumber, validation]);
  const [preview, setPreview] = useState<{ key: object; data?: Uint8Array; error?: string } | null>(null);
  const currentPreview = preview?.key === previewKey ? preview : null;
  const selected = drafts.find(item => item.id === selectedId);
  const disabled = busy || imageBusy || !current?.inspection.canEdit;
  const otherImages = drafts.flatMap(item => { const image = item.id !== selectedId ? imageOf(item.definition) : null; return image ? [image] : []; });

  useLayoutEffect(() => { currentRevision.current = revision; });
  useEffect(() => {
    active.current = true;
    const element = dialog.current, previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { active.current = false; operation.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const source = await readPDF(); if (canceled) return;
        const data = source instanceof ArrayBuffer ? source : source.data;
        const inspection: PageDecorationInspection = await inspectPageDecorations(data); if (canceled) return;
        setLoaded({ key: loadKey, data, inspection, preparePreview: source instanceof ArrayBuffer ? undefined : source.preparePreview }); setLoadError(null); setError(null); setValidation(null);
        setDrafts(inspection.decorations.map(item => ({ id: item.id, definition: item.definition, managed: item.managed, reason: item.reason, needsRefresh: item.needsRefresh, changed: false })));
        setSelectedId(inspection.decorations[0]?.id ?? ''); setPageNumber(previous => Math.max(1, Math.min(previous, inspection.pages.length)));
        requestAnimationFrame(() => { if (!canceled) initialFocus.current?.focus(); });
      } catch (cause) { if (!canceled) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not load page decorations.' }); }
    })();
    return () => { canceled = true; };
  }, [loadKey, readPDF]);
  useEffect(() => {
    if (!current || validation) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        let data = operations.length ? await applyPageDecorations(current.data, operations, { previewPage: pageNumber, signal: controller.signal }) : new Uint8Array(current.data);
        if (controller.signal.aborted) return;
        if (current.preparePreview) data = await current.preparePreview(data);
        if (!controller.signal.aborted) setPreview({ key: previewKey, data });
      } catch (cause) { if (!controller.signal.aborted) setPreview({ key: previewKey, error: cause instanceof Error ? cause.message : 'Could not generate the PDF preview.' }); }
    })(); }, operations.length ? 300 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [current, operations, pageNumber, previewKey, validation]);

  const close = () => {
    if (committing.current) return;
    if (operation.current) { closeAfterCancel.current = true; operation.current.abort(); setCanceling(true); }
    else onClose();
  };
  const select = (id: string) => { setSelectedId(id); setValidation(null); setError(null); };
  const add = (kind: PageDecorationDefinition['kind']) => {
    if (disabled || !current) return;
    const draft = createDecorationDraft(kind, current.inspection.pages.map(page => page.pageNumber));
    setDrafts(previous => [...previous, draft]); select(draft.id);
  };
  const change = (definition: PageDecorationDefinition) => {
    if (disabled || !selected?.managed) return;
    setDrafts(previous => previous.map(item => item.id === selectedId ? { ...item, definition, changed: true, needsRefresh: false } : item)); setError(null);
  };
  const save = async () => {
    if (operation.current || disabled || !current || !operations.length || validation || currentPreview?.error) return;
    const controller = new AbortController(), startedRevision = revision;
    operation.current = controller; closeAfterCancel.current = false; setBusy(true); setError(null);
    try {
      await onApply(operations, controller.signal, () => {
        if (!active.current || controller.signal.aborted || currentRevision.current !== startedRevision) throw new DOMException('The decoration operation was canceled.', 'AbortError');
        committing.current = true; setSaving(true);
      });
      if (active.current && !controller.signal.aborted) onClose();
    } catch (cause) { if (active.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not apply page decorations.'); }
    finally {
      if (operation.current === controller) operation.current = null;
      committing.current = false;
      if (active.current) { setBusy(false); setSaving(false); setCanceling(false); if (closeAfterCancel.current) onClose(); }
    }
  };
  useLayoutEffect(() => { saveLatest.current = save; });
  return <dialog ref={dialog} className="page-decorations-dialog" aria-labelledby="page-decorations-title" onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); const input = document.activeElement;
        if ((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && dialog.current?.contains(input)) flushSync(() => input.blur());
        void saveLatest.current();
      }
    }}>
    <header><div><h2 id="page-decorations-title">{t("m.watermarks.headers.backgrounds.3697c3")}</h2><p>{t("m.preview.the.pdf.before.applying.all.changes.toge.e054f6")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.page.decorations.21b509")} disabled={saving || canceling} onClick={close}>×</button></header>
    {!current && loadError?.key !== loadKey && <p role="status" className="decoration-loading">{t("m.loading.page.decorations.53b350")}</p>}
    {loadError?.key === loadKey && <div className="decoration-loading"><p role="alert" className="decoration-error"><ErrorMessage error={loadError.message} /></p><button type="button" onClick={() => setReload(value => value + 1)}>{t("m.retry.9f5cd8")}</button></div>}
    {current && <div className="decoration-body">
      <section className="decoration-settings" aria-label={t("m.page.decoration.settings.c64eaf")}>
        {!current.inspection.canEdit && <p role="status" className="decoration-error">{translateError(current.inspection.unsupportedReason) || t("m.this.pdf.cannot.be.modified.safely.82cd9f")}</p>}
        <label>{t("m.decorations.899db7")}<select ref={initialFocus} value={selectedId} disabled={busy || imageBusy} onChange={event => select(event.target.value)}>
          <option value="">{t("m.choose.a.decoration.9c889e")}</option>{drafts.map(item => <option key={item.id} value={item.id}>{item.definition.name || translateMessage(decorationKindLabels[item.definition.kind])}{!item.managed ? t("m.read.only.3ababd") : ''}</option>)}
        </select></label>
        <div className="decoration-add-actions"><button type="button" disabled={disabled} onClick={() => add('watermark')}>{t("m.add.watermark.2042dc")}</button><button type="button" disabled={disabled} onClick={() => add('header-footer')}>{t("m.add.headers.footers.1a0be4")}</button><button type="button" disabled={disabled} onClick={() => add('background')}>{t("m.add.background.7644fe")}</button></div>
        <p className="decoration-help">{t("m.only.decorations.created.by.this.editor.can.be.c.01f5c6")}</p>
        {selected && <>
          {!selected.managed && <p role="status" className="decoration-error">{translateError(selected.reason) || t("m.this.decoration.cannot.be.changed.safely.c85316")}</p>}
          {selected.needsRefresh && <><p role="status" className="decoration-help">{t("m.page.order.or.geometry.changed.refresh.to.update.56138f")}</p><button type="button" disabled={disabled || !selected.managed} onClick={() => change(selected.definition)}>{t("m.refresh.page.numbering.6a9fcd")}</button></>}
          <PageDecorationSettings key={selected.id} value={selected.definition} totalPages={current.inspection.pages.length} disabled={disabled || !selected.managed} otherImages={otherImages}
            onChange={change} onValidity={setValidation} onError={setError} onImageBusy={setImageBusy} />
          <button type="button" className="decoration-danger" disabled={disabled || !selected.managed} onClick={() => { setDrafts(previous => previous.filter(item => item.id !== selectedId)); select(''); }}>{t("m.remove.decoration.65fc7f")}</button>
        </>}
      </section>
      <section className="decoration-preview-column" aria-label={t("m.generated.pdf.preview.a0e2c8")}>
        <div className="decoration-preview-toolbar"><label>{t("m.preview.page.d24958")}<select value={pageNumber} disabled={busy} onChange={event => setPageNumber(Number(event.target.value))}>{current.inspection.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>{t("m.page.fb0627")}{' '}{page.pageNumber}</option>)}</select></label>
          <p role="status">{validation ? t("m.check.the.page.range.69221f") : currentPreview?.error ? t("m.preview.unavailable.36d31d") : currentPreview?.data ? t("m.preview.ready.8a0295") : t("m.updating.preview.3b1b2b")}</p></div>
        {currentPreview?.data && !validation && <DecorationPDFPreview data={currentPreview.data} pageNumber={pageNumber} onError={message => setPreview({ key: previewKey, error: message })} />}
        {currentPreview?.error && <p role="alert" className="decoration-error"><ErrorMessage error={currentPreview.error} /></p>}
      </section>
    </div>}
    <footer>{(validation || error) && <p role="alert" className="decoration-error"><ErrorMessage error={validation || error} /></p>}{busy && <p role="status">{canceling ? t("m.canceling.9dd59f") : saving ? t("m.opening.the.updated.pdf.31b55e") : t("m.applying.page.decorations.10bc34")}</p>}{imageBusy && <p role="status">{t("m.reading.image.8ae8b8")}</p>}
      <div><button type="button" disabled={saving || canceling} onClick={close}>{operations.length ? t("m.discard.changes.fa8fc0") : t("m.close.bbfa77")}</button><button type="button" className="decoration-primary" disabled={disabled || !operations.length || !!validation || !!currentPreview?.error} onClick={() => void save()}>{t("m.apply.decorations.7a178f")}</button></div>
    </footer>
  </dialog>;
}
export default PageDecorationsDialog;
