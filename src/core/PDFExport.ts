import { serializeAnnotationsToPDF } from '../annotations/AnnotationSerializer';
import { updateFormFieldValues } from '../forms/FormFieldExtractor';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { applyTextEdits } from '../editing/TextEditApplier';
import { assertTextEditSource } from '../editing/TextEditSource';
import { applyImageEdits } from '../editing/ImageEditApplier';
import { flattenForm } from '../forms/FormFlattener';

/** Commit original content edits without flattening editable overlays. */
export async function applyWorkspaceContent(data: ArrayBuffer, workspace: WorkspaceSnapshot): Promise<Uint8Array> {
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
      result = new Uint8Array(await applyImageEdits(result.buffer, imagesWithoutDetachedDecorations(workspace.editing.images, detached), workspace.editing.imageEdits));
    }
    if (workspace.editing.textEdits.length) {
      result = new Uint8Array(await applyTextEdits(result.buffer, workspace.editing.textBlocks, workspace.editing.textEdits));
    }
    return result;
  });
}

/** One export path for downloads and page extraction, including unsaved edits. */
export async function exportWorkspacePDF(data: ArrayBuffer, workspace: WorkspaceSnapshot): Promise<Uint8Array> {
  if (workspace.editing.textEdits.length) {
    await assertTextEditSource(data);
  }
  const fields = workspace.form.fields.filter(field => !field.readOnly && field.type !== 'button' && field.type !== 'signature');
  let result = new Uint8Array(data);
  if (fields.length) {
    result = new Uint8Array(await updateFormFieldValues(data, new Map(fields.map(field => [field.name, field.value]))));
  }
  result = new Uint8Array(await applyWorkspaceContent(result.buffer, workspace));
  if (workspace.annotations.size) {
    result = new Uint8Array(await serializeAnnotationsToPDF(result.buffer, workspace.annotations));
  }
  return result;
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
