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
    useEditingStore.setState({
      ...copy.editing,
      textBlocks: new Map([...current.textBlocks, ...copy.editing.textBlocks]),
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
