import { serializeAnnotationsToPDF } from '../annotations/AnnotationSerializer';
import { updateFormFieldValues } from '../forms/FormFieldExtractor';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { applyTextEdits, inspectTextBlocks } from '../editing/TextEditApplier';
import { assertTextEditSource } from '../editing/TextEditSource';
import { applyImageEdits } from '../editing/ImageEditApplier';
import { flattenForm } from '../forms/FormFlattener';
import { exportProgress, type PDFExportControl } from './PDFExportTypes';
import type { TextCheckReport } from '../editing/TextCheckTypes';

/** Commit original content edits without flattening editable overlays. */
export async function applyWorkspaceContent(data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFExportControl = {}): Promise<Uint8Array> {
  control.signal?.throwIfAborted();
  if (!workspace.editing.imageEdits.length && !workspace.editing.textEdits.length) return new Uint8Array(data);
  const { preservePageDecorations, imagesWithoutDetachedDecorations } = await import('./PreservePageDecorations');
  const blocks = new Map([...workspace.editing.textBlocks.values()].flat().map(block => [block.id, block]));
  const images = new Map([...workspace.editing.images.values()].flat().map(image => [image.id, image]));
  const pages = new Set<number>();
  for (const edit of workspace.editing.textEdits) { const block = blocks.get(edit.blockId); if (block) pages.add(block.pageNumber); }
  for (const edit of workspace.editing.imageEdits) { const image = images.get(edit.imageId); if (image) pages.add(image.pageNumber); }
  return preservePageDecorations(data, pages, async (body, detached) => {
    let result = new Uint8Array(body);
    if (workspace.editing.imageEdits.length) {
      exportProgress(control, 'images', .35);
      result = new Uint8Array(await applyImageEdits(result.buffer, imagesWithoutDetachedDecorations(workspace.editing.images, detached), workspace.editing.imageEdits));
    }
    if (workspace.editing.textEdits.length) {
      exportProgress(control, 'text', .55);
      result = new Uint8Array(await applyTextEdits(result.buffer, workspace.editing.textBlocks, workspace.editing.textEdits, control));
    }
    return result;
  });
}

/** One export path for downloads and page extraction, including unsaved edits. */
export async function exportWorkspacePDF(data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFExportControl = {}): Promise<Uint8Array> {
  exportProgress(control, 'validate', .05);
  if (workspace.editing.textEdits.length) {
    await assertTextEditSource(data, control.signal);
  }
  const fields = workspace.form.fields.filter(field => !field.readOnly && field.type !== 'button' && field.type !== 'signature');
  let result = new Uint8Array(data);
  if (fields.length) {
    exportProgress(control, 'forms', .15);
    result = new Uint8Array(await updateFormFieldValues(data, new Map(fields.map(field => [field.name, field.value]))));
  }
  result = new Uint8Array(await applyWorkspaceContent(result.buffer, workspace, control));
  if (workspace.annotations.size) {
    exportProgress(control, 'annotations', .85);
    result = new Uint8Array(await serializeAnnotationsToPDF(result.buffer, workspace.annotations));
  }
  exportProgress(control, 'complete', 1);
  return result;
}

/** Check against the same image edits and detached page decorations as export. */
export async function inspectWorkspaceText(data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFExportControl = {}): Promise<TextCheckReport> {
  exportProgress(control, 'validate', .05);
  const { preservePageDecorations, imagesWithoutDetachedDecorations } = await import('./PreservePageDecorations');
  let report: TextCheckReport = { checked: 0, issues: [] }, pages = 0;
  await preservePageDecorations(data, new Set(workspace.editing.textBlocks.keys()), async (body, detached) => {
    const source = workspace.editing.imageEdits.length
      ? new Uint8Array(await applyImageEdits(body, imagesWithoutDetachedDecorations(workspace.editing.images, detached), workspace.editing.imageEdits)).buffer : body;
    report = await inspectTextBlocks(source, workspace.editing.textBlocks, workspace.editing.textEdits, { signal: control.signal,
      onPage: () => exportProgress(control, 'text', .15 + .8 * ++pages / Math.max(1, workspace.editing.textBlocks.size)) });
    return new Uint8Array(body);
  });
  exportProgress(control, 'complete', 1);
  return report;
}

/** Apply pending original-content edits before widget appearances become page content. */
export async function flattenWorkspaceForm(data: ArrayBuffer, workspace: WorkspaceSnapshot) {
  const content = await applyWorkspaceContent(data, workspace);
  const fields = workspace.form.fields.filter(field => !field.readOnly && field.type !== 'button' && field.type !== 'signature');
  const filled = await updateFormFieldValues(new Uint8Array(content).buffer, new Map(fields.map(field => [field.name, field.value])));
  const flattened = await flattenForm(new Uint8Array(filled).buffer);
  return {
    data: flattened,
    workspace: {
      ...workspace,
      form: { fields: [], originalValues: new Map(), isDirty: false },
      editing: {
        ...workspace.editing,
        textBlocks: new Map(), images: new Map(), textEdits: [], imageEdits: [],
        isDirty: workspace.editing.redactions.some(area => !area.applied),
      },
    } satisfies WorkspaceSnapshot,
  };
}
