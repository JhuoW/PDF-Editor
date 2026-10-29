// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StickyNoteEditor } from '../../src/components/Annotations/StickyNoteEditor';
import { useAnnotationStore, createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { isWorkspaceEntry, useHistoryStore } from '../../src/store/historyStore';
import type { StickyNoteAnnotation } from '../../src/annotations/types';

let host: HTMLDivElement, root: Root, note: StickyNoteAnnotation;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useHistoryStore.getState().clearHistory();
  useAnnotationStore.setState(useAnnotationStore.getInitialState());
  useAnnotationHistoryStore.setState(useAnnotationHistoryStore.getInitialState());
  note = createStickyNoteAnnotation(1, { x: 100, y: 200 }, 'Original note');
  note.sourceNM = 'existing-native-name';
  note.nativeText = { rectangle: [100, 180, 120, 200], flags: 4, hasCreationDate: false, hasModifiedDate: false };
  useAnnotationStore.getState().addAnnotation(note);
  useAnnotationStore.getState().selectAnnotation(note.id);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<StickyNoteEditor />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
function current() { return useAnnotationStore.getState().getAllAnnotations()[0] as StickyNoteAnnotation; }

describe('StickyNoteEditor', () => {
  it('updates the workspace immediately and records one undo entry for a typing session', async () => {
    await fill('Note content', 'First draft');
    const input = await fill('Note content', '最终便签');
    expect(current().content).toBe('最终便签');
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    const entry = useHistoryStore.getState().undoStack[0];
    expect(isWorkspaceEntry(entry)).toBe(true);
    if (!isWorkspaceEntry(entry)) throw new Error('Expected a workspace entry');
    expect((entry.patch.annotations?.get(1)?.[0] as StickyNoteAnnotation).content).toBe('Original note');
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(current().sourceNM).toBe('existing-native-name');
    expect(current().nativeText).toEqual(note.nativeText);
  });
  it('commits the focused edit and closes on Escape without deleting the note', async () => {
    const input = await fill('Note content', 'Saved before closing');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(current().content).toBe('Saved before closing');
    expect(useAnnotationStore.getState().selectedAnnotationId).toBeNull();
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });
  it('does not add an old typing batch to history after another document replaces the workspace', async () => {
    await fill('Note content', 'Old unsaved history batch');
    await act(async () => {
      useAnnotationStore.setState({ annotations: new Map(), selectedAnnotationId: null });
      useAnnotationHistoryStore.getState().clear();
      useHistoryStore.getState().clearHistory();
    });
    expect(useAnnotationHistoryStore.getState().past).toHaveLength(0);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
