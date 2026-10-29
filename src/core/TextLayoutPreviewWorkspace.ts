import type { TextEditOperation } from '../editing/types';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { exportWorkspacePDF } from './PDFExport';
import { assertTextEditSource } from '../editing/TextEditSource';

/** Render a proposed layout with all other current drafts, without consuming them. */
export async function previewWorkspaceTextEdit(
  data: ArrayBuffer, workspace: WorkspaceSnapshot, edit: TextEditOperation, signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const block = [...workspace.editing.textBlocks.values()].flat().find(item => item.id === edit.blockId);
  if (!block?.editable) throw new Error('The selected text block is unavailable or cannot be edited.');
  if (workspace.editing.redactions.some(area => !area.applied)) {
    throw new Error('Apply or discard the pending content-removal areas before changing text layout.');
  }
  // Inspect the source before a form writer can normalize signatures or XFA.
  await assertTextEditSource(data, signal);
  signal?.throwIfAborted();
  const copy = structuredClone(workspace);
  const previous = copy.editing.textEdits.find(item => item.blockId === edit.blockId);
  const replacement = { ...structuredClone(edit), originalText: previous?.originalText ?? block.text };
  copy.editing.textEdits = copy.editing.textEdits.filter(item => item.blockId !== edit.blockId);
  if (replacement.newText !== replacement.originalText || replacement.layout) copy.editing.textEdits.push(replacement);
  signal?.throwIfAborted();
  const result = await exportWorkspacePDF(data.slice(0), copy);
  signal?.throwIfAborted();
  return result;
}
