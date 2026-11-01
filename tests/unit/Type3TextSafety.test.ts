import { describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import type { PDFPageProxy } from 'pdfjs-dist';
import { detectTextBlocks } from '../../src/editing/TextBlockDetector';
import { readTextSourceMetrics } from '../../src/editing/TextSourceMetrics';
import { TextLayoutSession } from '../../src/editing/TextLayout';
import { TYPE3_TEXT_EDIT_REASON, type TextBlock } from '../../src/editing/types';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, setCharWidth: 48, setCharWidthAndBounds: 49, fill: 22,
} }));

function proxy(programs?: Record<string, { fnArray: number[] }>) {
  return {
    pageNumber: 1, userUnit: 1,
    getViewport: () => ({ width: 400, height: 400, convertToViewportPoint: (x: number, y: number) => [x, 400 - y] }),
    commonObjs: { has: () => true, get: (name: string) => name === 't3'
      ? { name: 'Drawing', isType3Font: true, charProcOperatorList: programs } : { name: 'Times' } },
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getTextContent: async () => ({ items: [
      { str: 'a', fontName: 't3', transform: [12, 0, 0, 12, 40, 300], width: 6, height: 12 },
      { str: 'Normal', fontName: 'times', transform: [12, 0, 0, 12, 40, 200], width: 40, height: 12 },
    ], styles: { t3: { fontFamily: 'serif' }, times: { fontFamily: 'serif' } } }),
  } as unknown as PDFPageProxy;
}

function block(text: string, baseline: number): TextBlock {
  return { id: `row-${baseline}`, pageNumber: 1, kind: 'line', editable: true, text,
    rect: { x: 40, y: baseline - 10, width: 80, height: 12 },
    lines: [{ items: [], text, x: 40, y: baseline - 10, width: 80, height: 12, baseline }],
    style: { fontName: 'Times', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
}

describe('non-cacheable Type 3 safety', () => {
  it('shows drawing glyphs as read-only without blocking ordinary text', async () => {
    const rows = await detectTextBlocks(proxy({ a: { fnArray: [48, 22] } }), 'line');
    expect(rows[0]).toMatchObject({ editable: false, unsupportedReason: TYPE3_TEXT_EDIT_REASON });
    expect(rows[1].editable).toBe(true);
  });

  it('keeps monochrome d1 glyphs and empty d0 spaces editable', async () => {
    const rows = await detectTextBlocks(proxy({ a: { fnArray: [49, 22] }, space: { fnArray: [48] } }), 'line');
    expect(rows.every(row => row.editable)).toBe(true);
  });

  it('does not assume an uninspected Type 3 program is a monochrome mask', async () => {
    expect((await detectTextBlocks(proxy(), 'line'))[0].editable).toBe(false);
  });

  it('rejects a drawing glyph before laying out an edit, even when the caller marks it editable', () => {
    const document = new mupdf.PDFDocument();
    const drawing = document.addStream('500 0 d0 1 0 0 rg 0 0 400 800 re f', {});
    const type3 = document.addObject({ Type: 'Font', Subtype: 'Type3', Name: 'Drawing',
      FontBBox: [0, 0, 500, 800], FontMatrix: [.001, 0, 0, .001, 0, 0], FirstChar: 97, LastChar: 97,
      Widths: [500], Encoding: { Type: 'Encoding', Differences: [97, 'a'] }, CharProcs: { a: drawing } });
    const normal = document.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' });
    const resources = document.newDictionary();
    resources.put('Font', { T3: type3, F1: normal });
    const pageObject = document.addPage([0, 0, 400, 400], 0, resources,
      'BT /T3 12 Tf 40 300 Td (a) Tj ET BT /F1 12 Tf 40 200 Td (Normal) Tj ET');
    document.insertPage(0, pageObject);
    const page = document.loadPage(0), session = new TextLayoutSession(mupdf);
    try {
      expect(() => readTextSourceMetrics(mupdf, page, block('a', 100), session)).toThrow(TYPE3_TEXT_EDIT_REASON);
      expect(readTextSourceMetrics(mupdf, page, block('Normal', 200), session)?.source.map(item => item.character).join('')).toBe('Normal');
    } finally {
      session.destroy(); page.destroy(); pageObject.destroy(); resources.destroy(); normal.destroy(); type3.destroy(); drawing.destroy(); document.destroy();
    }
  });
});
