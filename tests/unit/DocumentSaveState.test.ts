import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import { useAnnotationStore, createRectangleAnnotation } from '../../src/store/annotationStore';
import { useFormStore } from '../../src/store/formStore';
import { useEditingStore } from '../../src/store/editingStore';
import { captureDocumentFileSaveState, captureDocumentSavePoint, clearDocumentSaveState, initializeDocumentSaveState, markDocumentSaved, markDocumentUnsaved, refreshDocumentSaveState, useDocumentSaveStore, workspaceSaveHash } from '../../src/store/documentSaveStore';

const data = new Uint8Array([1, 2, 3]).buffer;
beforeEach(() => { clearDocumentSaveState(); restoreWorkspace(createWorkspace()); });
async function open() {
  const workspace = createWorkspace(); restoreWorkspace(workspace); initializeDocumentSaveState(data, workspace);
  const point = await captureDocumentSavePoint(); return { workspace, point: point! };
}
describe('saved document state', () => {
  it('starts clean, detects edits, and becomes clean again when annotation undo returns to the saved content', async () => {
    const { workspace } = await open(); expect(useDocumentSaveStore.getState().isDirty).toBe(false);
    useAnnotationStore.getState().addAnnotation(createRectangleAnnotation(1, [10, 20, 30, 40])); refreshDocumentSaveState();
    expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    restoreWorkspace(workspace); refreshDocumentSaveState(); expect(useDocumentSaveStore.getState().isDirty).toBe(false);
  });

  it('ignores detection caches, selection flags, dirty booleans, form baselines and edit timestamps', async () => {
    const { workspace } = await open(), original = workspaceSaveHash(workspace);
    const cached = structuredClone(workspace); cached.editing.textBlocks.set(1, []); cached.editing.images.set(1, []);
    cached.annotations.set(1, []);
    cached.editing.isDirty = true; cached.form.isDirty = true; cached.form.originalValues.set('unused', 'old');
    expect(workspaceSaveHash(cached)).toBe(original);
    useEditingStore.getState().setMode('object'); refreshDocumentSaveState();
    expect(useDocumentSaveStore.getState().isDirty).toBe(false);
  });

  it('captures the workspace before awaiting native bytes, so typing during a save remains dirty', async () => {
    await open(); const captured = captureDocumentSavePoint();
    useAnnotationStore.getState().addAnnotation(createRectangleAnnotation(1, [10, 20, 30, 40]));
    markDocumentSaved((await captured)!);
    expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    const current = (await captureDocumentSavePoint())!; markDocumentSaved(current);
    expect(useDocumentSaveStore.getState().isDirty).toBe(false);
  });

  it('tracks native page bytes through edits and undo while keeping the saved baseline', async () => {
    const { workspace } = await open();
    initializeDocumentSaveState(new Uint8Array([9]).buffer, workspace, { preserve: true }); await captureDocumentSavePoint();
    expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    initializeDocumentSaveState(data, workspace, { preserve: true }); await captureDocumentSavePoint();
    expect(useDocumentSaveStore.getState().isDirty).toBe(false);
  });

  it('tracks forms and replacement image bytes, but ignores timestamps and unreferenced image caches', async () => {
    await open(); useFormStore.getState().setFields([{ id: 'name', name: 'Contact', type: 'text', value: 'changed', pageNumber: 1, rect: { x: 1, y: 2, width: 3, height: 4 }, required: false, readOnly: false, hidden: false }]);
    refreshDocumentSaveState(); expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    const original = createWorkspace(); original.editing.imageEdits.push({ type: 'replace', imageId: 'image', newImageData: new Uint8Array([1]).buffer, timestamp: 1 });
    const changed = structuredClone(original); changed.editing.imageEdits[0].timestamp = 2;
    expect(workspaceSaveHash(changed)).toBe(workspaceSaveHash(original));
    changed.editing.imageEdits[0].newImageData = new Uint8Array([2]).buffer;
    expect(workspaceSaveHash(changed)).not.toBe(workspaceSaveHash(original));
  });

  it('keeps generated PDFs unsaved until saved, persists only hashes, and rejects a stale point from another document', async () => {
    const first = await open(); markDocumentUnsaved(); expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    const state = captureDocumentFileSaveState(); expect(state?.unsaved).toBe(true);
    expect(Object.keys(state!).every(key => ['nativeHash', 'workspaceHash', 'unsaved'].includes(key))).toBe(true);
    markDocumentSaved((await captureDocumentSavePoint())!); expect(useDocumentSaveStore.getState().isDirty).toBe(false);
    initializeDocumentSaveState(new Uint8Array([8]).buffer, first.workspace); await captureDocumentSavePoint();
    markDocumentUnsaved(); markDocumentSaved(first.point); expect(useDocumentSaveStore.getState().isDirty).toBe(true);
  });

  it('retains saved and unsaved distinctions when restoring a same-tab reload baseline', async () => {
    const { workspace } = await open(), baseline = captureDocumentFileSaveState();
    const changed = structuredClone(workspace); changed.annotations.set(1, [createRectangleAnnotation(1, [10, 20, 30, 40])]);
    restoreWorkspace(changed); initializeDocumentSaveState(data, changed, { restored: baseline }); await captureDocumentSavePoint();
    expect(useDocumentSaveStore.getState().isDirty).toBe(true);
    markDocumentSaved((await captureDocumentSavePoint())!);
    const savedBaseline = captureDocumentFileSaveState();
    initializeDocumentSaveState(data, changed, { restored: savedBaseline }); await captureDocumentSavePoint();
    expect(useDocumentSaveStore.getState().isDirty).toBe(false);
    markDocumentUnsaved(); const generatedBaseline = captureDocumentFileSaveState();
    initializeDocumentSaveState(data, changed, { restored: generatedBaseline }); await captureDocumentSavePoint();
    expect(useDocumentSaveStore.getState().isDirty).toBe(true);
  });
});
