import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { createWorkspace } from '../store/workspaceSnapshot';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from '../forms/WorkspaceFormValues';
import { serializeAnnotationsToPDF } from '../annotations/AnnotationSerializer';
import { applyWorkspaceContent, retainCommittedTextFonts } from './PDFExport';
import { cleanPDF, inspectPDFCleanup } from './DocumentCleanup';
import type { CleanupControl, CleanupOptions } from './DocumentCleanupTypes';

const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const check = (signal?: AbortSignal) => signal?.throwIfAborted();

async function pendingContent(data: ArrayBuffer, workspace: WorkspaceSnapshot, signal?: AbortSignal) {
  let prepared = await applyWorkspaceContent(data, workspace);
  check(signal);
  prepared = await applyCurrentWorkspaceFormValues(buffer(prepared), workspace, signal);
  check(signal);
  return buffer(prepared);
}

/** Keep working annotations separate so cleanup can remove them without baking them. */
export async function prepareCleanupPDF(data: ArrayBuffer, workspace: WorkspaceSnapshot, signal?: AbortSignal) {
  check(signal);
  // Check the untouched file before a form library can normalize unsupported XFA.
  const report = await inspectPDFCleanup(data, { signal });
  check(signal);
  if (!report.canClean) return { data, report };
  const mayHaveEdits = workspace.editing.textEdits.length > 0 || workspace.editing.imageEdits.length > 0
    || workspace.form.fields.some(field => !field.readOnly && field.type !== 'button' && field.type !== 'signature');
  if (!mayHaveEdits) return { data, report };
  const preparedData = await pendingContent(data, workspace, signal);
  return { data: preparedData, report: await inspectPDFCleanup(preparedData, { signal }) };
}

export async function previewCleanupWorkspace(data: Uint8Array, workspace: WorkspaceSnapshot, options: CleanupOptions, signal?: AbortSignal) {
  check(signal);
  const result = !options.comments && workspace.annotations.size
    ? await serializeAnnotationsToPDF(buffer(data), workspace.annotations) : new Uint8Array(data);
  check(signal);
  return result;
}

/** Prepare the current appearance; a redaction selection is not removed content. */
export async function prepareVisibleWorkspacePDF(data: ArrayBuffer, workspace: WorkspaceSnapshot, signal?: AbortSignal) {
  check(signal);
  if (workspace.editing.redactions.some(area => !area.applied)) {
    throw new Error('Apply or discard the pending content-removal areas before downloading an image-only PDF.');
  }
  // A fresh image copy can include a signed source, without copying its signature.
  // Validate the raw source before pending form edits can normalize XFA or damage.
  const { inspectVisibleCopy } = await import('./VisibleCopy');
  await inspectVisibleCopy(data, undefined, { signal });
  check(signal);
  const prepared = await pendingContent(data, workspace, signal);
  const result = workspace.annotations.size ? await serializeAnnotationsToPDF(prepared, workspace.annotations) : new Uint8Array(prepared);
  check(signal);
  return buffer(result);
}

/** Native cleanup and editor state are returned together for one atomic history step. */
export async function cleanWorkspacePDF(data: ArrayBuffer, workspace: WorkspaceSnapshot, options: CleanupOptions, control: CleanupControl = {}) {
  const prepared = await prepareCleanupPDF(data, workspace, control.signal);
  check(control.signal);
  if (!prepared.report.canClean) throw new Error(prepared.report.unsupportedReason || 'This PDF cannot be cleaned safely.');
  const result = await cleanPDF(prepared.data, options, control);
  check(control.signal);
  const next = structuredClone(workspace);
  if (options.comments) next.annotations.clear();
  next.annotationHistory = { past: [], future: [] };
  const fields = await extractFormFields(buffer(result.data));
  check(control.signal);
  next.form = createWorkspace(fields).form;
  retainCommittedTextFonts(next);
  next.editing.textBlocks.clear(); next.editing.images.clear();
  next.editing.textEdits = []; next.editing.imageEdits = [];
  next.editing.isDirty = next.editing.redactions.some(area => !area.applied);
  return { data: result.data, workspace: next, report: result.report, removed: result.removed };
}
