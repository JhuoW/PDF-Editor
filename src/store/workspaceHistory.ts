import { useHistoryStore, type WorkspacePatch } from './historyStore';
import { useAnnotationStore } from './annotationStore';
import { useEditingStore } from './editingStore';
import { useFormStore } from './formStore';

/** Restore only the edited domain; navigation and unrelated detection caches stay put. */
export function applyWorkspacePatch(patch: WorkspacePatch) {
  const copy = structuredClone(patch);
  if (copy.annotations) {
    const selected = useAnnotationStore.getState().selectedAnnotationId;
    const exists = [...copy.annotations.values()].some(items => items.some(item => item.id === selected));
    useAnnotationStore.setState({ annotations: copy.annotations, ...(exists ? {} : { selectedAnnotationId: null, cropModeAnnotationId: null }) });
  }
  if (copy.form) useFormStore.setState({ ...copy.form, isFormPDF: copy.form.fields.length > 0 });
  if (copy.editing) {
    const current = useEditingStore.getState();
    const textBlocks = new Map([...current.textBlocks, ...copy.editing.textBlocks]);
    const drafts = new Set(copy.editing.textEdits.map(edit => edit.blockId));
    let mode = current.mode;
    if (mode === 'text' || mode === 'object') {
      // Undo/redo can restore an edit made before the user changed tools. Its
      // paragraph/row source boundaries still belong to that earlier tool.
      // Showing them in the current tool would turn paragraphs into objects,
      // or turn single objects into independently reflowing paragraphs.
      const kinds = new Set([...textBlocks.values()].flat().filter(block => drafts.has(block.id)).map(block => block.kind ?? 'paragraph'));
      if (kinds.size === 1) mode = kinds.has('line') ? 'object' : 'text';
      else if (kinds.size > 1) mode = 'none';
      if (mode === 'text' || mode === 'object') {
        const kind = mode === 'text' ? 'paragraph' : 'line';
        for (const [pageNumber, blocks] of textBlocks) {
          if (blocks.every(block => (block.kind ?? 'paragraph') === kind)) continue;
          // Never discard source data for a restored edit. Ambiguous legacy
          // caches can be baked and redetected on the next explicit tool choice.
          if (blocks.some(block => drafts.has(block.id))) mode = 'none';
          else textBlocks.delete(pageNumber);
        }
      }
    }
    useEditingStore.setState({
      ...copy.editing,
      textFontPreferences: copy.editing.textFontPreferences ?? new Map(),
      textBlocks,
      mode,
      images: new Map([...current.images, ...copy.editing.images]),
      selectedBlockId: null, selectedImageId: null, selectedRedactionId: null, pendingTextEditId: null, selectedObjectIds: [],
    });
  }
}

export function cancelWorkspaceGroup(key: string) {
  const patch = useHistoryStore.getState().cancelWorkspaceGroup(key);
  if (patch) applyWorkspacePatch(patch);
}

const pendingEditors = new Set<() => void>();
export function registerPendingEditor(commit: () => void) {
  pendingEditors.add(commit);
  return () => { pendingEditors.delete(commit); };
}
/** Commit editor drafts synchronously before export, document changes, or history. */
export function commitPendingEditors() {
  for (const commit of [...pendingEditors]) commit();
  useHistoryStore.getState().endGroup();
}
