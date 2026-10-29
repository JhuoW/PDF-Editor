import { describe, expect, it, vi } from 'vitest';
import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { detectTextBlocks, getTextEditingRestriction } from '../../src/editing/TextBlockDetector';
import { CLIPPING_TEXT_EDIT_REASON, INVISIBLE_TEXT_EDIT_REASON } from '../../src/editing/types';
import { createWorkspace, remapWorkspacePages } from '../../src/store/workspaceSnapshot';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

describe('text block coordinate detection', () => {
  it('does not merge managed page marks into original body text blocks', async () => {
    const content = vi.fn(async () => ({ items: [
      { type: 'beginMarkedContentProps', tag: 'Artifact' },
      { type: 'beginMarkedContent', tag: 'PDFEditorDecoration_12345678-1234-1234-1234-123456789abc' },
      { str: 'WATERMARK', transform: [12, 0, 0, 12, 30, 500], width: 80, height: 12, fontName: 'f1' },
      { type: 'beginMarkedContent', tag: 'Span' },
      { str: 'PAGE 1', transform: [12, 0, 0, 12, 110, 500], width: 40, height: 12, fontName: 'f1' },
      { type: 'endMarkedContent' }, { type: 'endMarkedContent' }, { type: 'endMarkedContent' },
      { str: 'BODY', transform: [12, 0, 0, 12, 30, 500], width: 30, height: 12, fontName: 'f1' },
    ], styles: { f1: { fontFamily: 'sans-serif' } } }));
    const page = { pageNumber: 1, userUnit: 1,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
      getTextContent: content,
    } as unknown as PDFPageProxy;
    const blocks = await detectTextBlocks(page);
    expect(blocks.map(block => block.text)).toEqual(['BODY']);
    expect(blocks[0].editable).toBe(true);
    expect(content).toHaveBeenCalledWith({ includeMarkedContent: true });
  });

  it('uses the unrotated viewport to include CropBox offsets and UserUnit', async () => {
    const page = {
      pageNumber: 1, userUnit: 2,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [(x - 50) * 2, (520 - y) * 2] }),
      getTextContent: async () => ({
        items: [{ str: 'Original text', transform: [12, 0, 0, 12, 80, 450], width: 70, height: 12, fontName: 'f1' }],
        styles: { f1: { fontFamily: 'serif' } },
      }),
    } as unknown as PDFPageProxy;
    const [block] = await detectTextBlocks(page);
    expect(block.rect).toEqual({ x: 60, y: 116, width: 140, height: 24 });
    expect(block.lines[0].baseline).toBe(140);
    expect(block.style.fontSize).toBe(24);
    expect(block.style.fontName).toBe('serif');
  });

  it('does not reuse a moved block ID when another page is detected at its previous page number', async () => {
    const page = {
      pageNumber: 1, userUnit: 1,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
      getTextContent: async () => ({
        items: [{ str: 'Original text', transform: [12, 0, 0, 12, 30, 500], width: 70, height: 12, fontName: 'f1' }],
        styles: { f1: { fontFamily: 'sans-serif' } },
      }),
    } as unknown as PDFPageProxy;
    const originalBlocks = await detectTextBlocks(page);
    const workspace = createWorkspace();
    workspace.editing.textBlocks.set(1, originalBlocks);
    workspace.editing.textEdits.push({ blockId: originalBlocks[0].id, originalText: 'Original text', newText: 'First edit', timestamp: 1 });
    const moved = remapWorkspacePages(workspace, new Map([[1, 2], [2, 1]]));
    const newlyDetected = await detectTextBlocks(page);
    expect(moved.editing.textBlocks.get(2)?.[0].id).toBe(originalBlocks[0].id);
    expect(moved.editing.textEdits[0].blockId).toBe(originalBlocks[0].id);
    expect(newlyDetected[0].id).not.toBe(originalBlocks[0].id);
  });
});

type Operation = [number, unknown[]];
function operatorPage(operations: Operation[]): PDFPageProxy {
  return {
    pageNumber: 1, userUnit: 1,
    getOperatorList: async () => ({ fnArray: operations.map(([operator]) => operator), argsArray: operations.map(([, args]) => args) }),
    getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
    getTextContent: async () => ({ items: [
      { str: 'OCR text', transform: [12, 0, 0, 12, 30, 500], width: 70, height: 12, fontName: 'f1' },
      { str: 'Visible content elsewhere', transform: [12, 0, 0, 12, 30, 100], width: 170, height: 12, fontName: 'f1' },
    ], styles: { f1: { fontFamily: 'sans-serif' } } }),
  } as unknown as PDFPageProxy;
}
const text: unknown[] = [[{ unicode: 'OCR' }]];

describe('hidden and clipping text safety', () => {
  it.each([3, 4, 5, 6, 7])('marks every block read-only when text is actually shown in render mode %i', async mode => {
    const blocks = await detectTextBlocks(operatorPage([[OPS.setTextRenderingMode, [mode]], [OPS.showText, text]]));
    expect(blocks).toHaveLength(2);
    expect(blocks.every(block => !block.editable)).toBe(true);
    expect(blocks.every(block => block.unsupportedReason === (mode === 3 ? INVISIBLE_TEXT_EDIT_REASON : CLIPPING_TEXT_EDIT_REASON))).toBe(true);
  });

  it.each([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText])('detects glyph drawing operator %i inside invisible mode', async operator => {
    expect(await getTextEditingRestriction(operatorPage([[OPS.setTextRenderingMode, [3]], [operator, operator === OPS.nextLineSetSpacingShowText ? [1, 2, ...text] : text]]))).toBe(INVISIBLE_TEXT_EDIT_REASON);
  });

  it('does not reject an unused Tr setting or spacing-only text operations', async () => {
    const page = operatorPage([[OPS.setTextRenderingMode, [3]], [OPS.showText, [[12, -5, { unicode: ' ' }]]], [OPS.setTextRenderingMode, [0]], [OPS.showText, text]]);
    expect(await getTextEditingRestriction(page)).toBeNull();
    expect((await detectTextBlocks(page)).every(block => block.editable)).toBe(true);
  });

  it.each([[OPS.save, OPS.restore], [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd], [OPS.beginGroup, OPS.endGroup]])('restores rendering state for operator pair %j', async (begin, end) => {
    expect(await getTextEditingRestriction(operatorPage([[begin, []], [OPS.setTextRenderingMode, [3]], [end, []], [OPS.showText, text]]))).toBeNull();
    expect(await getTextEditingRestriction(operatorPage([[OPS.setTextRenderingMode, [3]], [begin, []], [OPS.setTextRenderingMode, [0]], [OPS.showText, text], [end, []], [OPS.showText, text]]))).toBe(INVISIBLE_TEXT_EDIT_REASON);
  });

  it('retains text rendering mode across separate text objects', async () => {
    expect(await getTextEditingRestriction(operatorPage([[OPS.beginText, []], [OPS.setTextRenderingMode, [3]], [OPS.endText, []], [OPS.beginText, []], [OPS.showText, text]]))).toBe(INVISIBLE_TEXT_EDIT_REASON);
  });
});
