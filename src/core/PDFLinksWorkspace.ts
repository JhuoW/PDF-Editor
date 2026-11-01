import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from '../forms/WorkspaceFormValues';
import { serializeAnnotationsToPDF } from '../annotations/AnnotationSerializer';
import { applyWorkspaceContent, retainCommittedTextFonts } from './PDFExport';
import { applyPDFLinks, inspectPDFLinks } from './PDFLinks';
import type { PDFLinkControl, PDFLinkOperation } from './PDFLinkTypes';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;

/** Freeze one native basis so inspected link IDs also identify the committed links. */
export async function preparePDFLinksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFLinkControl = {}) {
  control.signal?.throwIfAborted();
  const report = await inspectPDFLinks(data, control);
  control.signal?.throwIfAborted();
  if (!report.canEdit) return { data: data.slice(0), report };
  if (workspace.editing.redactions.some(area => !area.applied)) {
    throw new Error('Apply or discard the pending content-removal areas before managing links.');
  }
  let prepared = await applyWorkspaceContent(data.slice(0), workspace);
  control.signal?.throwIfAborted();
  prepared = await applyCurrentWorkspaceFormValues(buffer(prepared), workspace, control.signal);
  control.signal?.throwIfAborted();
  const result = buffer(prepared);
  return { data: result, report: await inspectPDFLinks(result, { signal: control.signal }) };
}

/** Native links plus all visible annotations; the original workspace remains editable. */
export async function previewPDFLinksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, operations: PDFLinkOperation[], control: PDFLinkControl = {}) {
  control.signal?.throwIfAborted();
  let result = await applyPDFLinks(data, operations, control);
  control.signal?.throwIfAborted();
  if (workspace.annotations.size) result = await serializeAnnotationsToPDF(buffer(result), workspace.annotations);
  control.signal?.throwIfAborted();
  return result;
}

/** Commit prepared content and links together, retaining editable working annotations. */
export async function applyPDFLinksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, operations: PDFLinkOperation[], control: PDFLinkControl = {}) {
  control.signal?.throwIfAborted();
  const result = await applyPDFLinks(data, operations, control);
  control.signal?.throwIfAborted();
  const fields = await extractFormFields(buffer(result));
  control.signal?.throwIfAborted();
  const next = structuredClone(workspace);
  next.form = { fields, originalValues: new Map(fields.map(field => [field.id, structuredClone(field.value)])), isDirty: false };
  retainCommittedTextFonts(next);
  next.editing.textBlocks.clear(); next.editing.images.clear();
  next.editing.textEdits = []; next.editing.imageEdits = [];
  next.editing.isDirty = next.editing.redactions.some(area => !area.applied);
  return { data: result, workspace: next };
}
