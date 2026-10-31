import { ErrorMessage } from '../Feedback/ErrorMessage';
import { translateMessage } from '../../i18n';
import { LanguageSwitcher } from "../Workspace/LanguageSwitcher";
import { useLocale, t, translateError } from "../../i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { inspectFormDesign } from '../../forms/FormDesigner';
import type { DesignableFieldType, FormDesignDocument, FormDesignField, FormDesignFieldPatch, FormDesignOperation, NewFormDesignWidget } from '../../forms/FormDesignerTypes';
import type { FormFieldRect } from '../../forms/types';
import { pdfDocumentOptions, pdfjsLib } from '../../utils/pdfConfig';
import { FormDesignerPreview, type FormDesignSelection } from './FormDesignerPreview';
import { FormDesignerProperties } from './FormDesignerProperties';
import { buildFormDesignOperations, defaultFieldSize, designFieldLabels, fitDesignRect, makeDesignField, newDesignId } from './formDesignDraft';
import './FormDesignerDialog.css';

export interface FormDesignerDialogProps {
  documentKey: unknown;
  revision: number;
  currentPage: number;
  readPDF: () => Promise<ArrayBuffer>;
  onSave: (operations: FormDesignOperation[], signal: AbortSignal, onCommit: () => void) => Promise<void>;
  onClose: () => void;
}
interface LoadedDesign { key: object; design: FormDesignDocument; document: PDFDocumentProxy }

export function FormDesignerDialog(props: FormDesignerDialogProps) {
  useLocale();
  const [session, setSession] = useState({ key: props.documentKey, sequence: 0 });
  if (!Object.is(session.key, props.documentKey)) { setSession({ key: props.documentKey, sequence: session.sequence + 1 }); return null; }
  return <FormDesignerSession key={session.sequence} {...props} />;
}

function FormDesignerSession({ revision, currentPage, readPDF, onSave, onClose }: FormDesignerDialogProps) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null), pageInput = useRef<HTMLSelectElement>(null);
  const active = useRef(false), committing = useRef(false), closeAfterCancel = useRef(false);
  const saveLatest = useRef<() => Promise<void>>(async () => {});
  const operation = useRef<AbortController | null>(null), currentRevision = useRef(revision);
  const [reload, setReload] = useState(0);
  const loadKey = useMemo(() => ({ revision, reload, readPDF }), [revision, reload, readPDF]);
  const [loaded, setLoaded] = useState<LoadedDesign | null>(null);
  const [loadError, setLoadError] = useState<{ key: object; message: string } | null>(null);
  const [fields, setFields] = useState<FormDesignField[]>([]);
  const [selection, setSelection] = useState<FormDesignSelection | null>(null);
  const [pageNumber, setPageNumber] = useState(currentPage);
  const [tool, setTool] = useState<DesignableFieldType | null>(null);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = loaded?.key === loadKey ? loaded : null;
  const failure = loadError?.key === loadKey ? loadError.message : null;
  const disabled = busy || !current?.design.canEdit;
  const selectedField = fields.find(field => field.id === selection?.fieldId);
  const selectedWidget = selectedField?.widgets.find(widget => widget.id === selection?.widgetId);
  const operations = useMemo(() => current ? buildFormDesignOperations(current.design.fields, fields) : [], [current, fields]);

  useLayoutEffect(() => { currentRevision.current = revision; }, [revision]);
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const previousFocus = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    element?.showModal();
    return () => { active.current = false; operation.current?.abort(); element?.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  useEffect(() => {
    let canceled = false;
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined;
    const load = async () => {
      try {
        const data = await readPDF();
        if (canceled) return;
        const design = await inspectFormDesign(data);
        if (canceled) return;
        task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: new Uint8Array(data).slice() });
        const pdf = await task.promise;
        if (canceled) return;
        setLoaded({ key: loadKey, design, document: pdf }); setLoadError(null); setFields(structuredClone(design.fields)); setSelection(null); setTool(null); setError(null);
        setPageNumber(previous => Math.max(1, Math.min(previous, design.pages.length)));
        requestAnimationFrame(() => { if (!canceled) pageInput.current?.focus(); });
      } catch (cause) { if (!canceled) setLoadError({ key: loadKey, message: cause instanceof Error ? cause.message : 'Could not load the form designer.' }); }
    };
    void load();
    return () => { canceled = true; if (task) void task.destroy().catch(() => {}); };
  }, [loadKey, readPDF]);

  const close = () => {
    if (committing.current) return;
    if (operation.current) { closeAfterCancel.current = true; operation.current.abort(); setCanceling(true); }
    else onClose();
  };
  const select = (next: FormDesignSelection | null) => {
    setSelection(next);
    if (next) { const widget = fields.find(field => field.id === next.fieldId)?.widgets.find(item => item.id === next.widgetId); if (widget && current?.design.pages.some(page => page.pageNumber === widget.pageNumber)) setPageNumber(widget.pageNumber); }
  };
  const create = (type: DesignableFieldType, page: number, rect: FormFieldRect) => {
    if (disabled) return;
    const field = makeDesignField(type, page, rect, fields);
    setFields(previous => [...previous, field]); setSelection({ fieldId: field.id, widgetId: field.widgets[0].id }); setTool(null); setError(null);
  };
  const changeField = (patch: FormDesignFieldPatch) => {
    if (disabled || !selectedField?.supported) return;
    setFields(previous => previous.map(field => field.id === selectedField.id ? { ...field, ...patch } : field)); setError(null);
  };
  const changeWidget = (target: FormDesignSelection, patch: Partial<NewFormDesignWidget>) => {
    if (disabled || !current) return;
    const field = fields.find(item => item.id === target.fieldId), widget = field?.widgets.find(item => item.id === target.widgetId);
    if (!field?.supported || !widget) return;
    const page = current.design.pages.find(item => item.pageNumber === (patch.pageNumber ?? widget.pageNumber)); if (!page) return;
    const updated = { ...widget, ...patch, rect: fitDesignRect(patch.rect ?? widget.rect, page.width, page.height) };
    setFields(previous => previous.map(item => item.id === target.fieldId ? {
      ...item,
      widgets: item.widgets.map(candidate => candidate.id === target.widgetId ? updated : candidate),
      ...(item.type === 'radio' && patch.optionValue !== undefined ? {
        value: item.value === widget.optionValue ? patch.optionValue : item.value,
        defaultValue: item.defaultValue === widget.optionValue ? patch.optionValue : item.defaultValue,
      } : {}),
    } : item));
    if (patch.pageNumber !== undefined) setPageNumber(patch.pageNumber);
    setError(null);
  };
  const deleteField = (id: string) => {
    if (disabled || !fields.find(field => field.id === id)?.supported) return;
    setFields(previous => previous.filter(field => field.id !== id)); setSelection(null); setError(null);
  };
  const deleteWidget = (target: FormDesignSelection) => {
    if (disabled) return;
    const field = fields.find(item => item.id === target.fieldId); if (!field?.supported) return;
    if (field.widgets.length === 1) { deleteField(field.id); return; }
    const removed = field.widgets.find(widget => widget.id === target.widgetId), remaining = field.widgets.filter(widget => widget.id !== target.widgetId);
    setFields(previous => previous.map(item => item.id === field.id ? { ...item, widgets: remaining, value: item.type === 'radio' && item.value === removed?.optionValue ? '' : item.value, defaultValue: item.type === 'radio' && item.defaultValue === removed?.optionValue ? '' : item.defaultValue } : item));
    setSelection({ fieldId: field.id, widgetId: remaining[0].id }); setPageNumber(remaining[0].pageNumber);
  };
  const addWidget = () => {
    if (disabled || !selectedField?.supported || !selectedWidget || !current) return;
    const page = current.design.pages.find(item => item.pageNumber === selectedWidget.pageNumber)!;
    let number = selectedField.widgets.length + 1; while (selectedField.widgets.some(widget => widget.optionValue === `Option${number}`)) number++;
    const widget = { ...selectedWidget, id: newDesignId(), rect: fitDesignRect({ ...selectedWidget.rect, y: selectedWidget.rect.y + selectedWidget.rect.height + 12 }, page.width, page.height), ...(selectedField.type === 'radio' ? { optionValue: `Option${number}` } : {}) };
    setFields(previous => previous.map(field => field.id === selectedField.id ? { ...field, widgets: [...field.widgets, widget] } : field));
    setSelection({ fieldId: selectedField.id, widgetId: widget.id }); setPageNumber(widget.pageNumber);
  };
  const save = async () => {
    if (disabled || !operations.length || operation.current) return;
    const names = fields.map(field => field.name.trim());
    if (names.some(name => !name) || new Set(names).size !== names.length) { setError('Give each field a unique, nonempty name.'); return; }
    const startingRevision = revision, request = new AbortController(); operation.current = request;
    closeAfterCancel.current = false; setBusy(true); setError(null);
    try {
      await onSave(operations, request.signal, () => {
        request.signal.throwIfAborted();
        if (!active.current || currentRevision.current !== startingRevision) throw new Error('The document changed. Reopen the form designer.');
        committing.current = true; setSaving(true);
      });
      if (active.current && !request.signal.aborted) onClose();
    } catch (cause) {
      if (active.current && !request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not save the form design.');
    } finally {
      if (operation.current === request) operation.current = null;
      committing.current = false;
      if (active.current) { setBusy(false); setSaving(false); setCanceling(false); if (closeAfterCancel.current) onClose(); }
    }
  };
  useLayoutEffect(() => { saveLatest.current = save; });

  return <dialog ref={dialog} className="form-designer-dialog" aria-labelledby="form-designer-title" onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const input = window.document.activeElement;
        // Numeric controls and multiline choices finish their draft on blur. Flush that discrete
        // update before reading the latest operation batch for keyboard save.
        if ((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && dialog.current?.contains(input)) flushSync(() => input.blur());
        void saveLatest.current();
      }
    }}>
    <header><div><h2 id="form-designer-title">{t("m.design.form.a66596")}</h2><p>{t("m.create.and.arrange.fillable.pdf.fields.changes.a.8bf2ac")}</p></div><div className="dialog-language"><LanguageSwitcher /></div><button type="button" aria-label={t("m.close.form.designer.4ff8fe")} disabled={saving || canceling} onClick={close}>×</button></header>
    {!current && !failure && <p role="status" className="form-designer-loading">{t("m.preparing.the.page.preview.and.form.fields.e4e417")}</p>}
    {failure && <div className="form-designer-loading"><p role="alert"><ErrorMessage error={failure} /></p><button type="button" onClick={() => setReload(value => value + 1)}>{t("m.retry.9f5cd8")}</button></div>}
    {current && <>
      {!current.design.canEdit && <p role="status" className="form-designer-warning">{translateError(current.design.unsupportedReason) || t("m.this.pdf.can.be.inspected.but.not.redesigned.30e366")}</p>}
      <div className="form-designer-tools" role="group" aria-label={t("m.field.tools.9d6b51")}>
        <button type="button" aria-pressed={!tool} disabled={busy} onClick={() => setTool(null)}>{t("m.select.859822")}</button>
        {(Object.keys(designFieldLabels) as DesignableFieldType[]).map(type => <button type="button" key={type} aria-pressed={tool === type} disabled={disabled} onClick={() => setTool(type)}>{translateMessage(designFieldLabels[type])}</button>)}
        {tool && <button type="button" disabled={disabled} onClick={() => { const page = current.design.pages.find(item => item.pageNumber === pageNumber)!; const [width, height] = defaultFieldSize[tool]; create(tool, pageNumber, fitDesignRect({ x: (page.width - width) / 2, y: (page.height - height) / 2, width, height }, page.width, page.height)); }}>{t("m.place.at.page.center.3208d3")}</button>}
      </div>
      <div className="form-designer-body">
        <section className="form-designer-canvas-column" aria-label={t("m.page.preview.775172")}>
          <div className="form-designer-page-toolbar"><label>{t("m.preview.page.d24958")}<select ref={pageInput} value={pageNumber} disabled={busy} onChange={event => setPageNumber(Number(event.target.value))}>{current.design.pages.map(page => <option key={page.pageNumber} value={page.pageNumber}>{t("m.page.fb0627")}{' '}{page.pageNumber}</option>)}</select></label><p>{tool ? t("m.click.or.drag.on.the.page.to.create.a.field.2d4b49") : t("m.drag.to.move.use.the.corner.to.resize.or.arrow.k.5463fa")}</p></div>
          <FormDesignerPreview document={current.document} pageNumber={pageNumber} fields={fields} selected={selection} tool={tool} disabled={disabled} onSelect={select} onCreate={create} onMove={(target, rect) => changeWidget(target, { rect })} onDeleteWidget={deleteWidget} />
        </section>
        <aside className="form-designer-panel" aria-label={t("m.form.field.properties.7e4a0a")}>
          <label>{t("m.fields.f2cc30")}{fields.length})<select aria-label={t("m.fields.e8b685")} value={selectedField?.id ?? ''} disabled={busy} onChange={event => { const field = fields.find(item => item.id === event.target.value); select(field ? { fieldId: field.id, widgetId: field.widgets[0]?.id ?? '' } : null); }}>
            <option value="">{t("m.choose.a.field.842ab6")}</option>{fields.map(field => <option key={field.id} value={field.id}>{field.name} · {translateMessage(designFieldLabels[field.type as DesignableFieldType] ?? field.type)}{!field.supported ? t("m.read.only.3ababd") : ''}</option>)}
          </select></label>
          {selectedField && selectedWidget && current.design.pages.some(page => page.pageNumber === selectedWidget.pageNumber) ? <FormDesignerProperties key={selectedField.id} field={selectedField} widget={selectedWidget} pages={current.design.pages} disabled={disabled} onFieldChange={changeField} onWidgetChange={patch => changeWidget(selection!, patch)}
            onSelectWidget={id => select({ fieldId: selectedField.id, widgetId: id })} onAddWidget={addWidget} onDeleteWidget={() => deleteWidget(selection!)} onDeleteField={() => deleteField(selectedField.id)} />
            : <p className="form-designer-hint">{translateMessage(selectedField?.unsupportedReason || (fields.length ? 'Choose a field on the page or from the list to edit its properties.' : 'This PDF has no form fields. Choose a field tool to add one.'))}</p>}
        </aside>
      </div>
    </>}
    <footer>{error && <p role="alert" className="form-designer-error"><ErrorMessage error={error} /></p>}{busy && <p role="status">{canceling ? t("m.canceling.9dd59f") : saving ? t("m.opening.the.updated.form.5373a8") : t("m.saving.form.design.63b104")}</p>}
      <div><button type="button" disabled={saving || canceling} onClick={close}>{operations.length ? t("m.discard.changes.fa8fc0") : t("m.close.bbfa77")}</button><button type="button" className="form-designer-primary" disabled={disabled || !operations.length} onClick={() => void save()}>{t("m.save.form.design.10acc1")}</button></div></footer>
  </dialog>;
}

export default FormDesignerDialog;
