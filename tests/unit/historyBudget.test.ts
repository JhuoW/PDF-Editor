import { afterEach, beforeEach, expect, it } from 'vitest';
import { boundHistory, historyEntryBytes } from '../../src/store/historyBudget';
import { useHistoryStore, type DocumentSnapshot } from '../../src/store/historyStore';
import { createWorkspace } from '../../src/store/workspaceSnapshot';

const snapshot = (id: number, bytes = 1024): DocumentSnapshot => ({ data: new ArrayBuffer(bytes), fileName: 'test.pdf', timestamp: id, actionName: `Step ${id}` });
beforeEach(() => useHistoryStore.setState(useHistoryStore.getInitialState(), true));
afterEach(() => useHistoryStore.setState(useHistoryStore.getInitialState(), true));

it('bounds complete revisions by bytes while retaining a contiguous undo suffix', () => {
  const entries = [1, 2, 3, 4].map(id => snapshot(id));
  const budget = historyEntryBytes(entries[0]) * 2;
  const result = boundHistory({ undoStack: entries, redoStack: [] }, 20, budget);
  expect(result.state.undoStack).toEqual(entries.slice(-2)); expect(result.trimmed).toBe(true);
  expect(result.bytes).toBeLessThanOrEqual(budget);
});

it('retains the nearest redo when undoing a large revision and releases group references', () => {
  const entries = [1, 2, 3].map(id => snapshot(id)), inverse = snapshot(4);
  const result = boundHistory({ undoStack: entries, redoStack: [inverse], groupUndo: entries, groupRedo: [] }, 20, historyEntryBytes(inverse), 'redo');
  expect(result.state.redoStack).toEqual([inverse]); expect(result.state.undoStack).toEqual([]); expect(result.state.groupUndo).toEqual([]);
});

it('keeps one oversized inverse action so a large edit remains undoable', () => {
  const entries = [snapshot(1), snapshot(2, 8000)];
  expect(boundHistory({ undoStack: entries, redoStack: [] }, 20, 1000).state.undoStack).toEqual([entries[1]]);
});

it('charges image and text data inside workspace history, including typed-array backing buffers', () => {
  const item = { kind: 'workspace' as const, actionName: 'Text', timestamp: 1, patch: { editing: createWorkspace().editing } };
  const small = historyEntryBytes(item);
  const large = { ...item, patch: { ...item.patch, payload: new Uint8Array(9000), text: '中'.repeat(1000) } };
  expect(historyEntryBytes(large)).toBeGreaterThan(small + 11000);
});

it('applies the budget during edits, restore and undo/redo without changing the original', () => {
  const store = () => useHistoryStore.getState();
  useHistoryStore.setState({ maxHistoryBytes: 2800 });
  store().setOriginalDocument(new Uint8Array([42]).buffer, 'test.pdf');
  for (let i = 1; i <= 5; i++) store().pushState(snapshot(i).data, 'test.pdf', `Step ${i}`);
  expect(store().undoStack.length).toBeLessThan(5); expect(store().historyLimited).toBe(true);
  const undone = store().undo(snapshot(6).data, 'test.pdf'); expect(undone?.actionName).toBe('Step 5');
  expect(store().canRedo()).toBe(true); expect(store().redo(snapshot(5).data, 'test.pdf')).not.toBeNull();
  expect(new Uint8Array(store().originalDocument!.data)).toEqual(new Uint8Array([42]));
  store().restoreTimeline({ undoStack: [1, 2, 3, 4, 5].map(id => snapshot(id)), redoStack: [] });
  expect(store().undoStack.length).toBeLessThan(5);
});
