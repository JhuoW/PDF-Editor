import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore, isWorkspaceEntry } from '../../src/store/historyStore';
import { useAnnotationStore, createRectangleAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useFormStore } from '../../src/store/formStore';
import { useEditingStore } from '../../src/store/editingStore';
import { captureWorkspace, createWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import { applyWorkspacePatch, cancelWorkspaceGroup, commitPendingEditors, registerPendingEditor } from '../../src/store/workspaceHistory';
import { migrateLegacyHistory } from '../../src/store/migrateHistory';
import type { FormField } from '../../src/forms/types';
import type { TextBlock } from '../../src/editing/types';

const field = (id: string, name = id): FormField => ({ id, name, type: 'text', pageNumber: 1, value: 'Original',
  rect: { x: 10, y: 10, width: 100, height: 20 }, required: false, readOnly: false, hidden: false });
const block: TextBlock = { id: 'text', pageNumber: 1, text: 'OLD', editable: true, rect: { x: 10, y: 50, width: 150, height: 20 },
  lines: [], style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
const history = () => useHistoryStore.getState();
function step(direction: 'undo' | 'redo') {
  const patch = history().restoreWorkspaceStep(direction, captureWorkspace());
  expect(patch).not.toBeNull();
  applyWorkspacePatch(patch!);
}
beforeEach(() => {
  history().clearHistory();
  useHistoryStore.setState({ maxHistory: 20 });
  restoreWorkspace(createWorkspace([field('Name'), field('shared', 'Name'), field('Second')]));
  useEditingStore.getState().setTextBlocks(1, [structuredClone(block)]);
});

describe('one workspace editing timeline', () => {
  it('stores a layout-only change as one undo step without moving the source removal area', () => {
    const store = useEditingStore.getState();
    const layout = { targetRect: { x: 80, y: 120, width: 200, height: 80 }, fontSize: 18, fontColor: '#123456' };
    store.updateBlockLayout({ blockId: 'text', originalText: 'untrusted baseline', newText: 'OLD', timestamp: 1, layout });
    expect(history().undoStack).toHaveLength(1);
    expect(store.getBlock('text')).toEqual(block);
    expect(useEditingStore.getState().textEdits[0]).toMatchObject({ originalText: 'OLD', layout });
    layout.targetRect.x = 999;
    expect(useEditingStore.getState().textEdits[0].layout?.targetRect?.x).toBe(80);
    step('undo'); expect(useEditingStore.getState().textEdits).toEqual([]);
    step('redo'); expect(useEditingStore.getState().textEdits[0].layout?.fontSize).toBe(18);
    const snapshot = captureWorkspace(); restoreWorkspace(snapshot);
    expect(useEditingStore.getState().textEdits[0].layout?.targetRect?.x).toBe(80);
  });

  it('retains a chosen layout through subsequent inline edits and can reset it to the source', () => {
    const store = useEditingStore.getState(), layout = { fontSize: 9 };
    store.updateBlockLayout({ blockId: 'text', originalText: 'OLD', newText: 'New paragraph', timestamp: 1, layout });
    store.updateBlockText('text', 'OLD');
    expect(useEditingStore.getState().textEdits[0]).toMatchObject({ newText: 'OLD', layout });
    store.updateBlockLayout({ blockId: 'text', originalText: 'OLD', newText: 'OLD', timestamp: 2 });
    expect(useEditingStore.getState().textEdits).toEqual([]);
    expect(useEditingStore.getState().isDirty).toBe(false);
    step('undo'); expect(useEditingStore.getState().textEdits[0].layout).toEqual(layout);
    const steps = history().undoStack.length;
    store.updateBlockLayout({ blockId: 'text', originalText: 'OLD', newText: 'OLD', timestamp: 3, layout });
    expect(history().undoStack).toHaveLength(steps);
    expect(history().canRedo()).toBe(true);
  });

  it('undoes forms, annotations, original text, images, and removal areas in exact reverse order', () => {
    useFormStore.getState().setFieldValueByName('Name', 'Filled');
    const rectangle = createRectangleAnnotation(1, [10, 20, 50, 60]);
    useAnnotationStore.getState().addAnnotation(rectangle);
    useAnnotationHistoryStore.getState().recordAdd(rectangle);
    useEditingStore.getState().updateBlockText('text', 'NEW');
    useEditingStore.getState().addImageEdit({ type: 'delete', imageId: 'image', timestamp: 1 });
    useEditingStore.getState().addRedaction({ pageNumber: 1, rect: { x: 100, y: 100, width: 20, height: 20 }, overlayColor: '#000000' });
    const after = captureWorkspace();
    expect(history().undoStack.map(entry => entry.actionName)).toEqual([
      'Fill Name', 'Add annotation', 'Edit original text', 'Edit original image', 'Add removal area',
    ]);
    step('undo'); expect(useEditingStore.getState().redactions).toEqual([]);
    step('undo'); expect(useEditingStore.getState().imageEdits).toEqual([]);
    step('undo'); expect(useEditingStore.getState().getBlock('text')?.text).toBe('OLD');
    expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Filled');
    step('undo'); expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([]);
    step('undo'); expect(useFormStore.getState().fields.map(item => item.value)).toEqual(['Original', 'Original', 'Original']);
    expect(history().canUndo()).toBe(false);
    for (let index = 0; index < 5; index++) step('redo');
    expect(captureWorkspace()).toEqual(after);
  });

  it('groups a field focus session, separates later visits, and allocates no PDF snapshots while typing', () => {
    history().setOriginalDocument(new ArrayBuffer(1024 * 1024), 'large.pdf');
    const original = history().originalDocument;
    useFormStore.getState().setActiveField('Name');
    for (const value of ['A', 'AB', 'ABC']) useFormStore.getState().setFieldValueByName('Name', value);
    expect(history().undoStack).toHaveLength(1);
    expect(history().undoStack.every(entry => isWorkspaceEntry(entry) && !('data' in entry))).toBe(true);
    expect(history().originalDocument).toBe(original);
    useFormStore.getState().setActiveField(null);
    useFormStore.getState().setActiveField('Name');
    useFormStore.getState().setFieldValueByName('Name', 'Next visit');
    expect(history().undoStack).toHaveLength(2);
    step('undo'); expect(useFormStore.getState().getFieldValueByName('Name')).toBe('ABC');
    step('undo'); expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Original');
  });

  it('imports all logical field values as one step and resets them as another', () => {
    useFormStore.getState().setFieldValues(new Map([['Name', '客户'], ['Second', 'Another']]), 'Import form data');
    expect(history().undoStack).toHaveLength(1);
    useFormStore.getState().resetToOriginal();
    expect(history().undoStack).toHaveLength(2);
    step('undo'); expect(useFormStore.getState().fields.map(item => item.value)).toEqual(['客户', '客户', 'Another']);
    step('undo'); expect(useFormStore.getState().isDirty).toBe(false);
    step('redo'); expect(useFormStore.getState().getFieldValueByName('Name')).toBe('客户');
  });

  it('retains redo for no-ops, but a real edit in a different domain discards the branch', () => {
    useFormStore.getState().setFieldValueByName('Name', 'Changed');
    step('undo');
    useFormStore.getState().setFieldValueByName('Name', 'Original');
    useFormStore.getState().setFieldValueByName('Missing', 'Ignored');
    useEditingStore.getState().updateBlockText('missing', 'Ignored');
    useEditingStore.getState().resetImageEdits('missing');
    expect(history().canRedo()).toBe(true);
    useEditingStore.getState().updateBlockText('text', 'Branch');
    expect(history().canRedo()).toBe(false);
    step('undo'); expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Original');
  });

  it('cancels a live original-text session, restoring the prior redo branch and original text', () => {
    useFormStore.getState().setFieldValueByName('Name', 'Future'); step('undo');
    useEditingStore.getState().updateBlockText('text', 'N', 'text-session');
    useEditingStore.getState().updateBlockText('text', 'NEW', 'text-session');
    expect(useEditingStore.getState().textEdits).toHaveLength(1);
    expect(history().canRedo()).toBe(false);
    cancelWorkspaceGroup('text-session');
    expect(useEditingStore.getState().getBlock('text')?.text).toBe('OLD');
    expect(useEditingStore.getState().textEdits).toEqual([]);
    expect(history().canRedo()).toBe(true);
    step('redo'); expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Future');
  });

  it('cancelling a draft also preserves the oldest entry when history is full', () => {
    useHistoryStore.setState({ maxHistory: 2 });
    useFormStore.getState().setFieldValueByName('Name', 'A');
    useFormStore.getState().setFieldValueByName('Second', 'B');
    const before = history().undoStack;
    useEditingStore.getState().updateBlockText('text', 'Draft', 'cancellable');
    cancelWorkspaceGroup('cancellable');
    expect(history().undoStack).toEqual(before);
    step('undo'); step('undo');
    expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Original');
  });

  it('records annotation updates/deletions without replaying unrelated form changes', () => {
    const rectangle = createRectangleAnnotation(1, [10, 20, 50, 60]);
    useAnnotationStore.getState().addAnnotation(rectangle);
    const updated = { ...rectangle, strokeWidth: 8 };
    useAnnotationStore.getState().updateAnnotation(rectangle.id, updated);
    useAnnotationHistoryStore.getState().recordUpdate(updated, rectangle);
    useFormStore.getState().setFieldValueByName('Name', 'Keep until its own undo');
    useAnnotationHistoryStore.getState().recordDelete(updated);
    useAnnotationStore.getState().deleteAnnotation(rectangle.id);
    step('undo'); expect(useAnnotationStore.getState().getAllAnnotations()[0]).toMatchObject({ strokeWidth: 8 });
    expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Keep until its own undo');
    step('undo'); step('undo'); expect(useAnnotationStore.getState().getAllAnnotations()[0]).toMatchObject({ strokeWidth: 2 });
  });

  it('does not record detection caches and retains newly detected pages during an edit undo', () => {
    useEditingStore.getState().setImages(1, []);
    expect(history().canUndo()).toBe(false);
    useEditingStore.getState().updateBlockText('text', 'NEW');
    useEditingStore.getState().setTextBlocks(2, [{ ...block, id: 'page-two', pageNumber: 2 }]);
    step('undo');
    expect(useEditingStore.getState().getBlock('page-two')).not.toBeNull();
    expect(useEditingStore.getState().getBlock('text')?.text).toBe('OLD');
  });

  it('commits pending editors before a global operation and releases registrations on unmount', () => {
    let called = 0;
    const dispose = registerPendingEditor(() => { called++; useFormStore.getState().setFieldValueByName('Name', 'Committed'); });
    commitPendingEditors(); dispose(); commitPendingEditors();
    expect(called).toBe(1);
    expect(history().undoStack).toHaveLength(1);
    expect(useFormStore.getState().getFieldValueByName('Name')).toBe('Committed');
  });
});

it('migrates legacy annotation undo and redo ahead of the appropriate document checkpoints', () => {
  const annotation = createRectangleAnnotation(1, [1, 2, 30, 40]);
  const workspace = createWorkspace();
  workspace.annotations.set(1, [annotation]);
  workspace.annotationHistory = { past: [{ type: 'add', annotation }], future: [{ type: 'delete', annotation }] };
  const documentEntry = { data: new ArrayBuffer(1), fileName: 'old.pdf', actionName: 'Rotate', timestamp: 1 };
  const migrated = migrateLegacyHistory(workspace, { undoStack: [documentEntry], redoStack: [documentEntry] });
  expect(migrated.workspace.annotationHistory).toEqual({ past: [], future: [] });
  expect(migrated.history.undoStack[0]).toBe(documentEntry);
  expect(migrated.history.redoStack[0]).toBe(documentEntry);
  restoreWorkspace(migrated.workspace); useHistoryStore.setState(migrated.history);
  step('undo'); expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([]);
  step('redo'); expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([annotation]);
  step('redo'); expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([]);
  expect(workspace.annotationHistory.past).toHaveLength(1);
});
