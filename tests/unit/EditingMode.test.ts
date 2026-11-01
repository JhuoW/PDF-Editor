import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTextModePreparation, useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import type { TextBlock } from '../../src/editing/types';

const block: TextBlock = { id: 'paragraph', kind: 'paragraph', pageNumber: 1, text: 'Original', editable: true, lines: [],
  rect: { x: 40, y: 60, width: 120, height: 14 }, style: { fontName: 'Helvetica', fontSize: 14, alignment: 'left', lineHeight: 1.2 } };
let unregister: (() => void) | undefined;
beforeEach(() => {
  useEditingStore.getState().clearAll(); useHistoryStore.getState().clearHistory();
  useEditingStore.getState().setTextBlocks(1, [block]); useEditingStore.getState().setMode('text');
});
afterEach(() => { unregister?.(); unregister = undefined; });

describe('paragraph and single-row object mode boundaries', () => {
  it('shares an in-flight conversion when the same mode is requested twice', async () => {
    useEditingStore.getState().updateBlockText(block.id, 'Changed');
    let finish!: () => void;
    const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    unregister = registerTextModePreparation(prepare);
    useEditingStore.getState().setMode('object');
    useEditingStore.getState().setMode('object');
    expect(prepare).toHaveBeenCalledTimes(1);
    useEditingStore.setState({ textBlocks: new Map(), textEdits: [], mode: 'none' });
    finish(); await Promise.resolve();
    expect(useEditingStore.getState().mode).toBe('object');
  });
  it('invalidates unedited paragraph detection when entering object mode', () => {
    useEditingStore.getState().setMode('object');
    expect(useEditingStore.getState().mode).toBe('object');
    expect(useEditingStore.getState().textBlocks.has(1)).toBe(false);
  });
  it('preserves pending text until its undoable PDF operation finishes, then redetects rows', async () => {
    useEditingStore.getState().updateBlockText(block.id, 'Changed');
    let finish!: () => void;
    unregister = registerTextModePreparation(() => new Promise<void>(resolve => { finish = resolve; }));
    useEditingStore.getState().setMode('object');
    expect(useEditingStore.getState().mode).toBe('text');
    expect(useEditingStore.getState().textEdits[0].newText).toBe('Changed');
    // The document operation restores an empty detection cache with fresh bytes.
    useEditingStore.setState({ textBlocks: new Map(), textEdits: [], mode: 'none' });
    finish(); await Promise.resolve();
    expect(useEditingStore.getState().mode).toBe('object');
  });
  it('keeps drafts and the original mode when preparing the PDF fails', async () => {
    useEditingStore.getState().updateBlockText(block.id, 'Retained draft');
    unregister = registerTextModePreparation(async () => { throw new Error('The document operation already reported its failure'); });
    useEditingStore.getState().setMode('object');
    await Promise.resolve(); await Promise.resolve();
    expect(useEditingStore.getState().mode).toBe('text');
    expect(useEditingStore.getState().textEdits[0].newText).toBe('Retained draft');
  });
  it('does not reactivate a requested mode after a later user action', async () => {
    useEditingStore.getState().updateBlockText(block.id, 'Changed');
    let finish!: () => void;
    unregister = registerTextModePreparation(() => new Promise<void>(resolve => { finish = resolve; }));
    useEditingStore.getState().setMode('object'); useEditingStore.getState().setMode('none');
    finish(); await Promise.resolve();
    expect(useEditingStore.getState().mode).toBe('none');
    expect(useEditingStore.getState().textEdits[0].newText).toBe('Changed');
  });
  it('opens a line for typing inside object mode and redetects whole paragraphs when returning to text mode', () => {
    useEditingStore.getState().setTextBlocks(1, [{ ...block, kind: 'line' }]);
    useEditingStore.getState().requestTextEdit(block.id);
    expect(useEditingStore.getState().mode).toBe('object');
    expect(useEditingStore.getState().pendingTextEditId).toBe(block.id);
    useEditingStore.getState().setMode('text');
    expect(useEditingStore.getState().textBlocks.has(1)).toBe(false);
    expect(useEditingStore.getState().pendingTextEditId).toBeNull();
  });
});
