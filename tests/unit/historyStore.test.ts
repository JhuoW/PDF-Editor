import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { useHistoryStore } from '../../src/store/historyStore';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { createRectangleAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useFormStore } from '../../src/store/formStore';
import { useEditingStore } from '../../src/store/editingStore';

const buffer = (value: number): ArrayBuffer => new Uint8Array([value]).buffer;
const history = () => useHistoryStore.getState();

beforeEach(() => {
  history().clearHistory();
  useAnnotationHistoryStore.getState().clear();
  useFormStore.getState().clearForm();
  useEditingStore.getState().clearAll();
  useHistoryStore.setState({ maxHistory: 20 });
});

describe('document history', () => {
  it('restores the matching workspace in both directions without sharing historical objects', () => {
    const before = createWorkspace();
    const annotation = createRectangleAnnotation(1, [10, 20, 30, 40]);
    before.annotations.set(1, [annotation]);
    before.annotationHistory.past.push({ type: 'add', annotation });
    history().pushState(buffer(0), 'document.pdf', 'Delete page', before);
    const storedBefore = history().undoStack[0].workspace!;
    before.annotations.clear();

    const after = createWorkspace();
    const undone = history().undo(buffer(1), 'document.pdf', after)!;
    expect(undone.workspace?.annotations.get(1)![0]).toEqual(annotation);
    expect(undone.workspace?.annotationHistory.past).toHaveLength(1);
    after.annotations.set(1, [annotation]);
    undone.workspace!.annotationHistory.past.length = 0;
    expect(storedBefore.annotationHistory.past).toHaveLength(1);

    const redone = history().redo(buffer(0), 'document.pdf', storedBefore)!;
    expect(redone.workspace).toEqual(createWorkspace());
    storedBefore.annotations.clear();
    expect(history().undo(buffer(1), 'document.pdf', redone.workspace)?.workspace?.annotations.get(1))
      .toEqual([annotation]);
  });

  it('undoes each page rotation and redoes the latest PDF state', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const original = new Uint8Array(await pdf.save()).buffer;
    history().setOriginalDocument(original, 'document.pdf');

    history().pushState(original, 'document.pdf', 'Rotate 90°');
    page.setRotation(degrees(90));
    const firstRotation = new Uint8Array(await pdf.save()).buffer;

    history().pushState(firstRotation, 'document.pdf', 'Rotate another 90°');
    page.setRotation(degrees(180));
    const secondRotation = new Uint8Array(await pdf.save()).buffer;

    let current = secondRotation;
    for (const expectedRotation of [90, 0]) {
      const restored = history().undo(current, 'document.pdf');
      expect(restored).not.toBeNull();
      current = restored!.data;
      expect((await PDFDocument.load(current)).getPage(0).getRotation().angle)
        .toBe(expectedRotation);
    }
    expect(history().canUndo()).toBe(false);

    for (const expectedRotation of [90, 180]) {
      const restored = history().redo(current, 'document.pdf');
      expect(restored).not.toBeNull();
      current = restored!.data;
      expect((await PDFDocument.load(current)).getPage(0).getRotation().angle)
        .toBe(expectedRotation);
    }
    expect(history().canRedo()).toBe(false);
  });

  it('preserves action names and file names in both directions', () => {
    history().pushState(buffer(0), 'original.pdf', 'Merge documents');
    expect(history().getUndoActionName()).toBe('Merge documents');

    expect(history().undo(buffer(1), 'merged.pdf')).toMatchObject({
      data: buffer(0), fileName: 'original.pdf', actionName: 'Merge documents',
    });
    expect(history().getRedoActionName()).toBe('Merge documents');

    expect(history().redo(buffer(0), 'original.pdf')).toMatchObject({
      data: buffer(1), fileName: 'merged.pdf', actionName: 'Merge documents',
    });
    expect(history().getUndoActionName()).toBe('Merge documents');
    expect(history().getRedoActionName()).toBeNull();
  });

  it('discards the redo branch when a new edit follows undo', () => {
    history().pushState(buffer(0), 'document.pdf', 'First edit');
    history().undo(buffer(1), 'document.pdf');
    history().pushState(buffer(0), 'document.pdf', 'Alternative edit');

    expect(history().canRedo()).toBe(false);
    expect(history().redo(buffer(2), 'document.pdf')).toBeNull();
    expect(history().undo(buffer(2), 'document.pdf')?.data).toEqual(buffer(0));
  });

  it.each(['annotation', 'form', 'redaction', 'reset form'])('discards a document redo after a new %s edit', (kind) => {
    useFormStore.getState().setFields([{
      id: 'field', name: 'Name', type: 'text', pageNumber: 1, value: 'Before',
      rect: { x: 10, y: 20, width: 100, height: 20 }, required: false, readOnly: false, hidden: false,
    }]);
    useFormStore.getState().setFieldValue('field', 'Current');
    history().pushState(buffer(0), 'document.pdf', 'Rotate');
    history().undo(buffer(1), 'document.pdf');
    expect(history().canRedo()).toBe(true);
    if (kind === 'annotation') useAnnotationHistoryStore.getState().recordAdd(createRectangleAnnotation(1, [1, 1, 20, 20]));
    if (kind === 'form') useFormStore.getState().setFieldValueByName('Name', 'Another');
    if (kind === 'redaction') useEditingStore.getState().addRedaction({ pageNumber: 1, rect: { x: 1, y: 1, width: 20, height: 20 }, overlayColor: '#000000' });
    if (kind === 'reset form') useFormStore.getState().resetToOriginal();
    expect(history().canRedo()).toBe(false);
    expect(history().redo(buffer(0), 'document.pdf')).toBeNull();
  });

  it('stops at the oldest retained state when the history limit is reached', () => {
    useHistoryStore.setState({ maxHistory: 2 });
    history().setOriginalDocument(buffer(0), 'document.pdf');
    for (let value = 0; value < 3; value++) {
      history().pushState(buffer(value), 'document.pdf', `Edit ${value + 1}`);
    }

    expect(history().undo(buffer(3), 'document.pdf')?.data).toEqual(buffer(2));
    expect(history().undo(buffer(2), 'document.pdf')?.data).toEqual(buffer(1));
    expect(history().undo(buffer(1), 'document.pdf')).toBeNull();
    expect(history().getOriginalDocument()?.data).toEqual(buffer(0));

    expect(history().redo(buffer(1), 'document.pdf')?.data).toEqual(buffer(2));
    expect(history().redo(buffer(2), 'document.pdf')?.data).toEqual(buffer(3));
    expect(history().undoStack).toHaveLength(2);
  });

  it('isolates snapshots from mutation and transferred PDF buffers', () => {
    const original = buffer(0);
    history().setOriginalDocument(original, 'document.pdf');
    history().pushState(original, 'document.pdf', 'Edit');
    new Uint8Array(original)[0] = 99;
    expect(history().getOriginalDocument()?.data).toEqual(buffer(0));

    const storedUndoBuffer = history().undoStack[0].data;
    const current = buffer(1);
    const restored = history().undo(current, 'document.pdf')!;
    expect(restored.data).toEqual(buffer(0));
    expect(restored.data).not.toBe(storedUndoBuffer);
    structuredClone(current, { transfer: [current] });
    structuredClone(restored.data, { transfer: [restored.data] });

    const restoredRedo = history().redo(buffer(0), 'document.pdf')!;
    expect(restoredRedo.data).toEqual(buffer(1));
    structuredClone(restoredRedo.data, { transfer: [restoredRedo.data] });
    expect(history().undo(buffer(1), 'document.pdf')?.data).toEqual(buffer(0));
  });

  it('ignores reentrant history operations while a restore is in progress', () => {
    history().pushState(buffer(0), 'document.pdf', 'Edit');
    history().undo(buffer(1), 'document.pdf');
    history().setUndoRedoInProgress(true);
    history().pushState(buffer(2), 'document.pdf', 'Unexpected edit');
    expect(history().undo(buffer(2), 'document.pdf')).toBeNull();
    expect(history().redo(buffer(2), 'document.pdf')).toBeNull();
    expect(history().undoStack).toHaveLength(0);
    expect(history().redoStack).toHaveLength(1);

    history().setUndoRedoInProgress(false);
    expect(history().redo(buffer(0), 'document.pdf')?.data).toEqual(buffer(1));
  });

  it('clears the original, both stacks, and any restore lock', () => {
    history().setOriginalDocument(buffer(0), 'document.pdf');
    history().pushState(buffer(0), 'document.pdf', 'Edit');
    history().undo(buffer(1), 'document.pdf');
    history().setUndoRedoInProgress(true);
    history().clearHistory();

    expect(history().getOriginalDocument()).toBeNull();
    expect(history().canUndo()).toBe(false);
    expect(history().canRedo()).toBe(false);
    expect(history().isUndoRedoInProgress).toBe(false);
    expect(history().undo(buffer(0), 'document.pdf')).toBeNull();
    expect(history().redo(buffer(0), 'document.pdf')).toBeNull();
  });
});
