import { beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { captureWorkspace, createWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';
import { applyWorkspacePatch } from '../../src/store/workspaceHistory';
import { alignObjectRects, snapObjectRect } from '../../src/editing/objectGeometry';
import { transformObjectEdits } from '../../src/editing/objectOperations';
import { prepareTextEditLayout, applyTextEdits } from '../../src/editing/TextEditApplier';
import type { PDFImage, TextBlock } from '../../src/editing/types';

const block: TextBlock = { id: 'text', pageNumber: 1, text: 'Original', editable: true, rect: { x: 10, y: 50, width: 100, height: 20 }, lines: [], style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
const image: PDFImage = { id: 'image', pageNumber: 1, objectName: 'image', rect: { x: 100, y: 100, width: 40, height: 40 }, originalRect: { x: 100, y: 100, width: 40, height: 40 }, source: { occurrence: 0, occurrenceCount: 1, transform: [40, 0, 0, 40, 100, 100], insideForm: false } };
beforeEach(() => { restoreWorkspace(createWorkspace()); useHistoryStore.getState().clearHistory(); useEditingStore.getState().setTextBlocks(1, [structuredClone(block)]); useEditingStore.getState().setImages(1, [structuredClone(image)]); });
describe('batch editing and layout', () => {
  it('moves mixed original objects atomically and restores the entire change in one history step', () => {
    const state = useEditingStore.getState(); state.selectObjects(['text', 'image']);
    const edits = transformObjectEdits([{ kind: 'text', item: block }, { kind: 'image', item: image }], [{ ...block.rect, x: 30 }, { ...image.rect, x: 120 }]);
    state.applyObjectEdits(edits, 'Move objects'); expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(useEditingStore.getState().getBlock('text')?.rect).toEqual(block.rect);
    expect(useEditingStore.getState().textEdits[0].layout?.targetRect?.x).toBe(30); expect(useEditingStore.getState().imageEdits[0].newRect?.x).toBe(120);
    applyWorkspacePatch(useHistoryStore.getState().restoreWorkspaceStep('undo', captureWorkspace())!);
    expect(useEditingStore.getState().textEdits).toEqual([]); expect(useEditingStore.getState().imageEdits).toEqual([]); expect(useEditingStore.getState().selectedObjectIds).toEqual([]);
    applyWorkspacePatch(useHistoryStore.getState().restoreWorkspaceStep('redo', captureWorkspace())!);
    expect(useEditingStore.getState().textEdits).toHaveLength(1); expect(useEditingStore.getState().imageEdits).toHaveLength(1);
  });
  it('keeps a multi-selection on one page and discards stale IDs', () => {
    useEditingStore.getState().setImages(2, [{ ...image, id: 'second', pageNumber: 2 }]);
    useEditingStore.getState().selectObjects(['text', 'missing', 'second'], 'second');
    expect(useEditingStore.getState().selectedObjectIds).toEqual(['second']);
  });
  it('distributes unequal object widths with equal gaps while preserving their order and sizes', () => {
    const rectangles = [{ x: 0, y: 20, width: 20, height: 10 }, { x: 150, y: 30, width: 40, height: 12 }, { x: 250, y: 10, width: 50, height: 14 }];
    const result = alignObjectRects(rectangles, 'horizontal');
    expect(result[0]).toEqual(rectangles[0]); expect(result[2]).toEqual(rectangles[2]);
    expect(result[1].x - result[0].x - result[0].width).toBe(result[2].x - result[1].x - result[1].width);
    expect(result.map(rect => rect.width)).toEqual([20, 40, 50]); expect(alignObjectRects(rectangles, 'bottom').map(rect => rect.y + rect.height)).toEqual([42, 42, 42]);
  });
  it('snaps to page centers and other object edges without crossing page boundaries', () => {
    const result = snapObjectRect({ x: 95, y: 52, width: 10, height: 20 }, [{ x: 150, y: 50, width: 20, height: 20 }], { width: 200, height: 200 });
    expect(result.rect).toEqual({ x: 95, y: 50, width: 10, height: 20 }); expect(result.guides).toContainEqual({ axis: 'x', position: 100 });
  });
  it('fits larger formatting on a multi-line original block before preview is ready', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([600, 760]); page.drawText('Format this text\nSecond line', { x: 80, y: 650, size: 16, lineHeight: 22 });
    const data = new Uint8Array(await pdf.save()).buffer;
    const source: TextBlock = { ...block, text: 'Format this text\nSecond line', rect: { x: 80, y: 94, width: 116, height: 38 }, style: { ...block.style, fontSize: 16, lineHeight: 1.375 }, lines: [
      { text: 'Format this text', items: [], x: 80, y: 94, width: 116, height: 16, baseline: 110 }, { text: 'Second line', items: [], x: 80, y: 116, width: 90, height: 16, baseline: 132 },
    ] };
    const edit = { blockId: source.id, originalText: source.text, newText: source.text, timestamp: 1, layout: { targetRect: source.rect, keepBaseline: true, fitToContent: true, fontName: 'Courier-Bold', fontSize: 24, lineHeight: 2 } };
    const prepared = await prepareTextEditLayout(data, source, edit); expect(prepared.layout.fits).toBe(true); expect(prepared.input.legacyBaseline).toBe(110);
    expect(prepared.input.rect.width).toBeGreaterThan(source.rect.width); expect(prepared.input.rect.height).toBe(72);
    await expect(applyTextEdits(data, new Map([[1, [source]]]), [edit])).resolves.toBeInstanceOf(Uint8Array);
  });
});
