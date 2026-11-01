import { beforeEach, describe, expect, it } from 'vitest';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { applyWorkspacePatch } from '../../src/store/workspaceHistory';
import { captureWorkspace, createWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import type { TextBlock } from '../../src/editing/types';

const paragraph: TextBlock = {
  id: 'paragraph', kind: 'paragraph', pageNumber: 1, text: 'First source row\nSecond source row', editable: true,
  rect: { x: 40, y: 60, width: 160, height: 32 },
  lines: [
    { items: [], text: 'First source row', x: 40, y: 60, width: 160, height: 14, baseline: 74 },
    { items: [], text: 'Second source row', x: 40, y: 78, width: 160, height: 14, baseline: 92 },
  ],
  style: { fontName: 'Courier', fontSize: 14, alignment: 'left', lineHeight: 18 / 14 },
};
const rows = () => paragraph.lines.map((line, index): TextBlock => ({ ...structuredClone(paragraph),
  id: `row-${index}`, kind: 'line', text: line.text, lines: [line],
  rect: { x: line.x, y: line.y, width: line.width, height: line.height },
}));
const store = () => useEditingStore.getState();
function step(direction: 'undo' | 'redo') {
  const patch = useHistoryStore.getState().restoreWorkspaceStep(direction, captureWorkspace());
  expect(patch).not.toBeNull(); applyWorkspacePatch(patch!);
}
function consistentMode() {
  const { mode, textBlocks } = store();
  if (mode !== 'text' && mode !== 'object') return;
  const expected = mode === 'object' ? 'line' : 'paragraph';
  expect([...textBlocks.values()].flat().map(block => block.kind ?? 'paragraph')).toEqual(expect.arrayContaining([expected]));
  expect([...textBlocks.values()].flat().every(block => (block.kind ?? 'paragraph') === expected)).toBe(true);
}
beforeEach(() => { restoreWorkspace(createWorkspace()); useHistoryStore.getState().clearHistory(); });

describe('history across paragraph and object tools', () => {
  it('does not restore a paragraph draft as a single object after changing tools', () => {
    store().setTextBlocks(1, [structuredClone(paragraph)]); store().setMode('text');
    store().updateBlockText(paragraph.id, 'Changed paragraph with another line', undefined,
      { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' });
    step('undo');
    store().setMode('object'); store().setTextBlocks(1, rows());
    step('redo');
    expect(store().textEdits[0].newText).toBe('Changed paragraph with another line');
    expect(store().mode).toBe('text');
    consistentMode();
  });

  it('does not restore a single-row draft as a paragraph after changing tools', () => {
    store().setTextBlocks(1, rows()); store().setMode('object');
    store().updateBlockText('row-0', 'Changed independent object', undefined,
      { keepBaseline: true, reflow: true, autoGrow: true, flow: 'object' });
    step('undo');
    store().setMode('text'); store().setTextBlocks(1, [structuredClone(paragraph)]);
    step('redo');
    expect(store().textEdits[0].newText).toBe('Changed independent object');
    expect(store().mode).toBe('object');
    consistentMode();
  });

  it('does not restore stale paragraph detection while undoing a non-text edit in object mode', () => {
    store().setTextBlocks(1, [structuredClone(paragraph)]); store().setMode('text');
    store().addRedaction({ pageNumber: 1, rect: { x: 20, y: 20, width: 10, height: 10 } });
    store().setMode('object'); store().setTextBlocks(1, rows());
    step('undo');
    expect(store().redactions).toHaveLength(0);
    // No text draft needs historical paragraph boundaries. Keep the current
    // row cache or discard it for redetection, rather than showing paragraphs.
    expect(store().mode).toBe('object');
    expect([...store().textBlocks.values()].flat().every(block => block.kind === 'line')).toBe(true);
  });

  it.each(['none', 'image', 'redact'] as const)('keeps %s active when a paragraph draft is restored', mode => {
    store().setTextBlocks(1, [structuredClone(paragraph)]); store().setMode('text');
    store().updateBlockText(paragraph.id, 'Changed paragraph', undefined,
      { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' });
    step('undo'); store().setMode(mode); step('redo');
    expect(store().mode).toBe(mode);
    expect(store().textEdits[0].newText).toBe('Changed paragraph');
  });

  it('keeps every source block in an ambiguous legacy draft without presenting the wrong tool', () => {
    store().setMode('object');
    const copy = createWorkspace().editing;
    copy.textBlocks = new Map([[1, [structuredClone(paragraph)]], [2, rows().map(block => ({ ...block, pageNumber: 2 }))]]);
    copy.textEdits = [{ blockId: paragraph.id, originalText: paragraph.text, newText: 'Paragraph draft', timestamp: 1 },
      { blockId: 'row-0', originalText: rows()[0].text, newText: 'Object draft', timestamp: 1 }];
    copy.isDirty = true;
    applyWorkspacePatch({ editing: copy });
    expect(store().mode).toBe('none');
    expect(store().textEdits).toHaveLength(2);
    expect(store().textBlocks.get(1)?.[0].id).toBe(paragraph.id);
    expect(store().textBlocks.get(2)?.[0].id).toBe('row-0');
  });
});
