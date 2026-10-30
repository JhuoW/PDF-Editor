import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from '../forms/WorkspaceFormValues';
import { serializeAnnotationsToPDF } from '../annotations/AnnotationSerializer';
import { applyWorkspaceContent } from './PDFExport';
import { applyPDFBookmarks, inspectPDFBookmarks } from './PDFBookmarks';
import type { PDFBookmarkControl, PDFBookmarkDraft } from './PDFBookmarksTypes';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;

/** Freeze one native basis so inspected bookmark IDs also identify the committed bookmarks. */
export async function preparePDFBookmarksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFBookmarkControl = {}) {
  control.signal?.throwIfAborted();
  const report = await inspectPDFBookmarks(data, control);
  control.signal?.throwIfAborted();
  if (!report.canEdit) return { data: data.slice(0), report };
  if (workspace.editing.redactions.some(area => !area.applied)) {
    throw new Error('Apply or discard the pending content-removal areas before managing bookmarks.');
  }
  let prepared = await applyWorkspaceContent(data.slice(0), workspace);
  control.signal?.throwIfAborted();
  prepared = await applyCurrentWorkspaceFormValues(buffer(prepared), workspace, control.signal);
  control.signal?.throwIfAborted();
  const result = buffer(prepared);
  return { data: result, report: await inspectPDFBookmarks(result, { signal: control.signal }) };
}

/** Native bookmarks plus all visible annotations; the original workspace remains editable. */
export async function previewPDFBookmarksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, tree: PDFBookmarkDraft[], control: PDFBookmarkControl = {}) {
  control.signal?.throwIfAborted();
  let result = await applyPDFBookmarks(data, tree, control);
  control.signal?.throwIfAborted();
  if (workspace.annotations.size) result = await serializeAnnotationsToPDF(buffer(result), workspace.annotations);
  control.signal?.throwIfAborted();
  return result;
}

/** Commit prepared content and bookmarks together, retaining editable working annotations. */
export async function applyPDFBookmarksWorkspace(data: ArrayBuffer, workspace: WorkspaceSnapshot, tree: PDFBookmarkDraft[], control: PDFBookmarkControl = {}) {
  control.signal?.throwIfAborted();
  const result = await applyPDFBookmarks(data, tree, control);
  control.signal?.throwIfAborted();
  const fields = await extractFormFields(buffer(result));
  control.signal?.throwIfAborted();
  const next = structuredClone(workspace);
  next.form = { fields, originalValues: new Map(fields.map(field => [field.id, structuredClone(field.value)])), isDirty: false };
  next.editing.textBlocks.clear(); next.editing.images.clear();
  next.editing.textEdits = []; next.editing.imageEdits = [];
  next.editing.isDirty = next.editing.redactions.some(area => !area.applied);
  return { data: result, workspace: next };
}
