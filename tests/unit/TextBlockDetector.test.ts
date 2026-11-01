import { describe, expect, it, vi } from 'vitest';
import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { detectTextBlocks, getTextEditingRestriction } from '../../src/editing/TextBlockDetector';
import { CLIPPING_TEXT_EDIT_REASON, INVISIBLE_TEXT_EDIT_REASON, TYPE3_TEXT_EDIT_REASON } from '../../src/editing/types';
import { createWorkspace, remapWorkspacePages } from '../../src/store/workspaceSnapshot';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

describe('text block coordinate detection', () => {
  it('separates the font size from horizontal character scaling', async () => {
    const page = { pageNumber: 1, userUnit: 1,
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
      getTextContent: async () => ({ items: ['alpha beta', 'gamma delta', 'third line'].map((str, i) => ({ str,
        transform: [21, 0, 0, 12, 40, 500 - i * 16], width: str.length * 12.6, height: 12, fontName: 'f1' })), styles: { f1: { fontFamily: 'monospace' } } }),
    } as unknown as PDFPageProxy;
    const [block] = await detectTextBlocks(page);
    expect(block.style.fontSize).toBe(12);
    expect(block.style.lineHeight * block.style.fontSize).toBeCloseTo(16);
    expect(block.rect.height).toBe(44);
    expect(block.lines).toHaveLength(3);
  });
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

function textItem(str: string, x: number, baseline: number, width: number, size = 10, fontName = 'body') {
  return { str, transform: [size, 0, 0, size, x, baseline], width, height: size, fontName };
}
function paperPage(items: ReturnType<typeof textItem>[]): PDFPageProxy {
  return {
    pageNumber: 1, userUnit: 1,
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
    getTextContent: async () => ({ items, styles: Object.fromEntries(items.map(item => [item.fontName, { fontFamily: 'sans-serif' }])) }),
  } as unknown as PDFPageProxy;
}

describe('paper text reading order and paragraph boundaries', () => {
  it('keeps small graph tick labels out of an adjacent body paragraph and protects Type 3 fonts before typing', async () => {
    const page = paperPage([
      textItem('Body paragraph first row', 30, 500, 200, 12),
      textItem('2.0', 240, 499, 10, 5, 'chart'),
      textItem('Body paragraph second row', 30, 485, 200, 12),
      textItem('1.5', 240, 484, 10, 5, 'chart'),
    ]);
    Object.assign(page, { commonObjs: { has: () => true, get: (name: string) => ({ name, isType3Font: name === 'chart' }) } });
    const blocks = await detectTextBlocks(page);
    const body = blocks.find(block => block.text.startsWith('Body'))!;
    expect(body.text).toBe('Body paragraph first row\nBody paragraph second row');
    expect(body.rect.width).toBe(200); expect(body.editable).toBe(true);
    expect(blocks.filter(block => block !== body).every(block => !block.editable && block.unsupportedReason === TYPE3_TEXT_EDIT_REASON)).toBe(true);
  });
  it('keeps a narrow wrap column and the full-width text below a figure in separate flow areas', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('Narrow column first row', 30, 500, 200),
      textItem('Narrow column second row', 30, 488, 200),
      textItem('Full-width continuation below the figure', 30, 476, 430),
      textItem('Full-width second row', 30, 464, 430),
    ]));
    expect(blocks.map(block => block.lines.length)).toEqual([2, 2]);
    expect(blocks.map(block => block.rect.width)).toEqual([200, 430]);
  });
  it('does not reflow a short fragment after an equation across the equation on its left', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('is independent', 340, 500, 90),
      textItem('The full-width following row', 30, 488, 400),
    ]));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].rect.x).toBe(340);
  });
  it('keeps tightly spaced body baselines distinct and derives their real leading', async () => {
    // Like the JMLR sample: one line is only 1.2 font sizes below the previous.
    // Items deliberately arrive out of order and the second row has a smaller x.
    const blocks = await detectTextBlocks(paperPage([
      textItem('Second row stays second', 30, 488, 200),
      textItem('First row', 40, 500, 50),
      textItem('continues', 94, 500, 80),
      textItem('Third row stays third', 30, 476, 200),
    ]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('First row continues\nSecond row stays second\nThird row stays third');
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[0].lines.map(line => line.baseline)).toEqual([100, 112, 124]);
    expect(blocks[0].style.lineHeight).toBeCloseTo(1.2);
    expect(blocks[0].editable).toBe(true);
  });

  it('separates title, authors and body even when every embedded font has the same CSS family', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('Paper title', 100, 540, 240, 14, 'title'),
      textItem('Second title line', 160, 522.5, 120, 14, 'title'),
      textItem('Author Name', 30, 500, 90, 10, 'author-bold'),
      textItem('Abstract', 200, 480, 50, 10, 'heading-bold'),
      textItem('First body line', 30, 468, 300, 10, 'body-regular'),
      textItem('Second body line', 30, 456, 300, 10, 'body-regular'),
    ]));
    expect(blocks.map(block => block.text)).toEqual([
      'Paper title\nSecond title line', 'Author Name', 'Abstract', 'First body line\nSecond body line',
    ]);
    expect(blocks[0].style.alignment).toBe('center');
    expect(blocks[0].style.lineHeight).toBeCloseTo(1.25);
    expect(blocks[3].style.fontSize).toBe(10);
  });

  it('keeps separate columns apart even when their baselines and font identities match', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('Left first', 30, 500, 110), textItem('Right first', 300, 500, 110),
      textItem('Left second', 30, 488, 110), textItem('Right second', 300, 488, 110),
    ]));
    expect(blocks.map(block => block.text)).toEqual(['Left first\nLeft second', 'Right first\nRight second']);
    expect(blocks.every(block => block.rect.width === 110)).toBe(true);
  });

  it('starts a new paragraph at an indented line instead of moving it before the preceding line', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('First paragraph line one', 30, 500, 300),
      textItem('First paragraph line two', 30, 488, 260),
      textItem('Indented second paragraph', 47, 476, 283),
      textItem('Second paragraph continues', 30, 464, 300),
    ]));
    expect(blocks.map(block => block.text)).toEqual([
      'First paragraph line one\nFirst paragraph line two',
      'Indented second paragraph\nSecond paragraph continues',
    ]);
  });

  it('separates blank paragraphs and page numbers from body content', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('First paragraph', 30, 500, 300),
      textItem('Continued', 30, 488, 300),
      textItem('Second paragraph', 30, 468, 300),
      textItem('Continued again', 30, 456, 300),
      textItem('1933', 170, 426, 20, 9),
    ]));
    expect(blocks.map(block => block.text)).toEqual(['First paragraph\nContinued', 'Second paragraph\nContinued again', '1933']);
  });

  it('includes inline emphasis in its complete paragraph instead of making each surrounding row an independent area', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('Before', 30, 500, 200),
      textItem('Mixed ', 30, 488, 40), textItem('emphasis', 70, 488, 60, 10, 'italic'),
      textItem('After', 30, 476, 200),
    ]));
    expect(blocks.map(block => block.text)).toEqual(['Before\nMixed emphasis\nAfter']);
    expect(blocks[0].lines[1].items.map(item => item.fontName)).toEqual(['sans-serif', 'sans-serif']);
    expect(blocks[0].kind).toBe('paragraph');
  });

  it('detects each physical row as a separate object when object editing is requested', async () => {
    const page = paperPage([textItem('First row', 30, 500, 200), textItem('Second row', 30, 485, 200)]);
    expect((await detectTextBlocks(page)).map(block => block.text)).toEqual(['First row\nSecond row']);
    const objects = await detectTextBlocks(page, 'line');
    expect(objects.map(block => block.text)).toEqual(['First row', 'Second row']);
    expect(objects.every(block => block.kind === 'line' && block.lines.length === 1)).toBe(true);
    expect(objects.every(block => block.style.lineHeight === 1.5)).toBe(true);
  });

  it('joins rows using different subset resources of the same real face, while keeping bold headings separate', async () => {
    const page = paperPage([textItem('Heading', 30, 524, 200, 10, 'heading'),
      textItem('First body row', 30, 500, 200, 10, 'subset-a'), textItem('Second body row', 30, 488, 200, 10, 'subset-b')]);
    Object.assign(page, { commonObjs: new Map([['heading', { name: 'ABCDEF+Body-Bold' }], ['subset-a', { name: 'ABCDEF+Body-Regular' }], ['subset-b', { name: 'UVWXYZ+Body-Regular' }]]) });
    expect((await detectTextBlocks(page)).map(block => block.text)).toEqual(['Heading', 'First body row\nSecond body row']);
  });

  it('retains saved paragraph boundaries even when adjacent paragraphs use the same font and leading', async () => {
    const page = paperPage([]);
    page.getTextContent = async () => ({ items: [
      { type: 'beginMarkedContent', tag: 'PDFEditorParagraph_first' }, textItem('Short paragraph', 30, 500, 100), { type: 'endMarkedContent' },
      { type: 'beginMarkedContent', tag: 'PDFEditorParagraph_next' }, textItem('Next paragraph first row', 30, 488, 200), textItem('Next paragraph second row', 30, 476, 200), { type: 'endMarkedContent' },
    ], styles: { body: { fontFamily: 'sans-serif', ascent: .8, descent: -.2, vertical: false } }, lang: null });
    expect((await detectTextBlocks(page)).map(block => block.text)).toEqual(['Short paragraph', 'Next paragraph first row\nNext paragraph second row']);
  });

  it('protects a superscript region without making the neighboring ordinary text read-only', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('Plain text before', 30, 530, 200),
      textItem('x', 30, 500, 6), textItem('2', 36, 504, 4, 7, 'superscript'),
      textItem('Plain text after', 30, 470, 200),
    ]));
    expect(blocks).toHaveLength(3);
    expect(blocks.map(block => block.editable)).toEqual([true, false, true]);
    expect(blocks[1].unsupportedReason).toContain('Ordinary text blocks can still be edited');
    expect(blocks[1].rect.height).toBeGreaterThan(10);
  });
  it('keeps a small, spaced superscript with its source line rather than treating it as a chart tick', async () => {
    const blocks = await detectTextBlocks(paperPage([
      textItem('A cited statement', 30, 500, 100, 12),
      textItem('1', 134, 505, 3, 5, 'footnote'),
      textItem('Ordinary body text', 30, 470, 200, 12),
    ]));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('1'); expect(blocks[0].editable).toBe(false);
    expect(blocks[1].editable).toBe(true);
  });

  it('protects overlapping and rotated glyphs rather than interpreting them as horizontal prose', async () => {
    const rotated = textItem('Rotated', 300, 400, 50);
    rotated.transform = [0, 10, -10, 0, 300, 400];
    const blocks = await detectTextBlocks(paperPage([
      textItem('Overlaid', 30, 500, 50), textItem('copy', 30, 500, 30), rotated,
    ]));
    expect(blocks).toHaveLength(2);
    expect(blocks.every(block => !block.editable)).toBe(true);
  });
});
