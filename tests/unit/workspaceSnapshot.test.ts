import { beforeEach, describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/react';
import type { FormField } from '../../src/forms/types';
import type { TextBlock, PDFImage } from '../../src/editing/types';
import { createRectangleAnnotation, useAnnotationStore } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useEditingStore } from '../../src/store/editingStore';
import { useFormStore } from '../../src/store/formStore';
import { useTextBoxStore } from '../../src/store/textBoxStore';
import {
  captureWorkspace, createWorkspace, remapWorkspacePages, restoreWorkspace,
  type WorkspaceSnapshot,
} from '../../src/store/workspaceSnapshot';

function formField(pageNumber: number): FormField {
  return {
    id: `field-${pageNumber}`, name: `field-${pageNumber}`, type: 'listbox',
    value: ['original'], pageNumber,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    required: false, readOnly: false, hidden: false,
  };
}

function textBlock(pageNumber: number): TextBlock {
  return {
    id: `block-${pageNumber}`, pageNumber, lines: [], text: 'changed',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1 },
    editable: true,
  };
}

function pdfImage(pageNumber: number): PDFImage {
  return {
    id: `image-${pageNumber}`, pageNumber, objectName: `image-object-${pageNumber}`,
    rect: { x: 10, y: 20, width: 30, height: 40 },
    originalRect: { x: 10, y: 20, width: 30, height: 40 },
  };
}

function populatedWorkspace(): WorkspaceSnapshot {
  const snapshot = createWorkspace([1, 2, 3].map(formField));
  for (const pageNumber of [1, 2, 3]) {
    const annotation = createRectangleAnnotation(pageNumber, [10, 20, 30, 40]);
    annotation.id = `annotation-${pageNumber}`;
    snapshot.annotations.set(pageNumber, [annotation]);
    snapshot.annotationHistory.past.push({ type: 'add', annotation });
    snapshot.editing.textBlocks.set(pageNumber, [textBlock(pageNumber)]);
    snapshot.editing.images.set(pageNumber, [pdfImage(pageNumber)]);
    snapshot.editing.redactions.push({
      id: `redaction-${pageNumber}`, pageNumber,
      rect: { x: 10, y: 20, width: 30, height: 40 }, overlayColor: '#000000', applied: false,
    });
    snapshot.editing.textEdits.push({
      blockId: `block-${pageNumber}`, originalText: 'original', newText: 'changed', timestamp: 1,
    });
    snapshot.editing.imageEdits.push({
      imageId: `image-${pageNumber}`, type: 'replace',
      newImageData: new Uint8Array([pageNumber, 42]).buffer, timestamp: 1,
    });
  }
  const annotation = snapshot.annotations.get(2)![0];
  snapshot.annotationHistory.past.push({
    type: 'update', annotation: { ...annotation, color: '#FF0000' }, previousState: annotation,
  });
  snapshot.annotationHistory.future.push({ type: 'delete', annotation });
  snapshot.form.fields[0].value = ['changed'];
  snapshot.form.isDirty = true;
  snapshot.editing.isDirty = true;
  return snapshot;
}

beforeEach(() => {
  useAnnotationStore.setState(useAnnotationStore.getInitialState(), true);
  useAnnotationHistoryStore.setState(useAnnotationHistoryStore.getInitialState(), true);
  useEditingStore.setState(useEditingStore.getInitialState(), true);
  useFormStore.setState(useFormStore.getInitialState(), true);
  useTextBoxStore.setState(useTextBoxStore.getInitialState(), true);
});

describe('workspace snapshots', () => {
  it('creates an independent empty workspace with the provided form baseline', () => {
    const field = formField(1);
    const snapshot = createWorkspace([field]);
    field.value = ['modified outside'];

    expect(snapshot.annotations.size).toBe(0);
    expect(snapshot.annotationHistory).toEqual({ past: [], future: [] });
    expect(snapshot.form.fields[0].value).toEqual(['original']);
    expect(snapshot.form.originalValues.get(field.id)).toEqual(['original']);
    expect(snapshot.form.isDirty).toBe(false);
    expect(snapshot.editing.isDirty).toBe(false);
    expect(createWorkspace()).toEqual(createWorkspace());
  });

  it('captures all edits in a structured-cloneable snapshot without active editors or functions', () => {
    const snapshot = populatedWorkspace();
    restoreWorkspace(snapshot);
    useTextBoxStore.setState({ tiptapEditor: { destroy() {} } as unknown as Editor });
    useFormStore.getState().setActiveField('field-1');
    useEditingStore.getState().selectBlock('block-1');
    useAnnotationStore.getState().selectAnnotation('annotation-1');

    const captured = captureWorkspace();
    expect(captured).toEqual(snapshot);
    expect(structuredClone(captured)).toEqual(snapshot);
    expect(captured.annotations.get(1)![0].createdAt).toBeInstanceOf(Date);
    expect(captured.editing.imageEdits[0].newImageData).toBeInstanceOf(ArrayBuffer);
    expect(captured).not.toHaveProperty('tiptapEditor');
    expect(captured.form).not.toHaveProperty('activeFieldId');
    expect(captured.editing).not.toHaveProperty('selectedBlockId');
  });

  it('isolates captured edits from future store mutations and snapshot mutations', () => {
    restoreWorkspace(populatedWorkspace());
    const captured = captureWorkspace();
    useFormStore.getState().fields[0].rect.x = 999;
    useEditingStore.getState().textBlocks.get(1)![0].style.fontSize = 999;
    captured.editing.images.get(1)![0].rect.x = 888;
    new Uint8Array(captured.editing.imageEdits[0].newImageData!)[0] = 99;

    expect(captured.form.fields[0].rect.x).toBe(10);
    expect(captured.editing.textBlocks.get(1)![0].style.fontSize).toBe(12);
    expect(useEditingStore.getState().images.get(1)![0].rect.x).toBe(10);
    expect(new Uint8Array(useEditingStore.getState().imageEdits[0].newImageData!)[0]).toBe(1);
  });

  it('restores edits and their baseline while clearing stale selections and editor references', () => {
    const snapshot = populatedWorkspace();
    useAnnotationStore.getState().selectAnnotation('stale-annotation');
    useAnnotationStore.getState().enterCropMode('stale-annotation');
    useFormStore.getState().setActiveField('stale-field');
    useEditingStore.getState().setMode('text');
    useEditingStore.getState().selectBlock('stale-block');
    useTextBoxStore.getState().startEditing('stale-textbox');
    useTextBoxStore.setState({ tiptapEditor: { destroy() {} } as unknown as Editor });
    restoreWorkspace(snapshot);

    expect(captureWorkspace()).toEqual(snapshot);
    expect(useAnnotationStore.getState().selectedAnnotationId).toBeNull();
    expect(useAnnotationStore.getState().cropModeAnnotationId).toBeNull();
    expect(useFormStore.getState().activeFieldId).toBeNull();
    expect(useFormStore.getState().isFormPDF).toBe(true);
    expect(useEditingStore.getState().mode).toBe('none');
    expect(useEditingStore.getState().selectedBlockId).toBeNull();
    expect(useTextBoxStore.getState().editingTextBoxId).toBeNull();
    expect(useTextBoxStore.getState().tiptapEditor).toBeNull();
    expect(useAnnotationStore.getState().addAnnotation).toBeTypeOf('function');

    useFormStore.getState().resetToOriginal();
    expect(useFormStore.getState().fields[0].value).toEqual(['original']);
    expect(snapshot.form.fields[0].value).toEqual(['changed']);
    useEditingStore.getState().images.get(1)![0].rect.x = 999;
    expect(snapshot.editing.images.get(1)![0].rect.x).toBe(10);
  });

  it('deletes removed pages and remaps annotations, form widgets, histories, and edits', () => {
    const snapshot = populatedWorkspace();
    snapshot.editing.textEdits.push({ blockId: 'missing', originalText: '', newText: '', timestamp: 1 });
    snapshot.editing.imageEdits.push({ imageId: 'missing', type: 'delete', timestamp: 1 });
    const remapped = remapWorkspacePages(snapshot, new Map([[2, 1], [3, 2]]));

    expect([...remapped.annotations.keys()]).toEqual([1, 2]);
    expect(remapped.annotations.get(1)![0]).toMatchObject({ id: 'annotation-2', pageNumber: 1 });
    expect(remapped.annotations.get(2)![0]).toMatchObject({ id: 'annotation-3', pageNumber: 2 });
    expect(remapped.annotationHistory.past).toHaveLength(3);
    expect(remapped.annotationHistory.past[2]).toMatchObject({
      type: 'update', annotation: { pageNumber: 1 }, previousState: { pageNumber: 1 },
    });
    expect(remapped.annotationHistory.future[0].annotation.pageNumber).toBe(1);
    expect(remapped.form.fields.map(field => [field.id, field.pageNumber])).toEqual([
      ['field-2', 1], ['field-3', 2],
    ]);
    expect([...remapped.form.originalValues.keys()]).toEqual(['field-2', 'field-3']);
    expect(remapped.form.isDirty).toBe(false);
    expect(remapped.editing.textBlocks.get(1)![0]).toMatchObject({ id: 'block-2', pageNumber: 1 });
    expect(remapped.editing.images.get(2)![0]).toMatchObject({ id: 'image-3', pageNumber: 2 });
    expect(remapped.editing.redactions.map(redaction => [redaction.id, redaction.pageNumber])).toEqual([
      ['redaction-2', 1], ['redaction-3', 2],
    ]);
    expect(remapped.editing.textEdits.map(edit => edit.blockId)).toEqual(['block-2', 'block-3']);
    expect(remapped.editing.imageEdits.map(edit => edit.imageId)).toEqual(['image-2', 'image-3']);
    expect(remapped.editing.isDirty).toBe(true);
    expect(snapshot.annotations.get(2)![0].pageNumber).toBe(2);
    expect(snapshot.form.fields).toHaveLength(3);
  });

  it('keeps IDs and independent nested data when inserting or reordering pages', () => {
    const snapshot = populatedWorkspace();
    const remapped = remapWorkspacePages(snapshot, new Map([[1, 3], [2, 1], [3, 4]]));

    expect(remapped.annotations.get(3)![0].id).toBe('annotation-1');
    expect(remapped.form.fields.map(field => field.pageNumber)).toEqual([3, 1, 4]);
    expect(remapped.editing.textEdits).toEqual(snapshot.editing.textEdits);
    expect(remapped.editing.imageEdits).toEqual(snapshot.editing.imageEdits);
    remapped.editing.textBlocks.get(3)![0].rect.x = 999;
    remapped.form.fields[0].value = ['later change'];
    new Uint8Array(remapped.editing.imageEdits[0].newImageData!)[0] = 99;
    expect(snapshot.editing.textBlocks.get(1)![0].rect.x).toBe(10);
    expect(snapshot.form.fields[0].value).toEqual(['changed']);
    expect(new Uint8Array(snapshot.editing.imageEdits[0].newImageData!)[0]).toBe(1);
  });

  it('drops edits and resets dirty flags when none of their pages survive', () => {
    const remapped = remapWorkspacePages(populatedWorkspace(), new Map());
    expect(remapped).toEqual(createWorkspace());
    restoreWorkspace(remapped);
    expect(useFormStore.getState().isFormPDF).toBe(false);
  });
});
