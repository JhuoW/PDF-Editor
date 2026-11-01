import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import type { PDFPageProxy } from 'pdfjs-dist';
import { detectTextBlocks } from '../../src/editing/TextBlockDetector';
import { applyTextEdits, previewInlineTextEdits, type PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import { textRegionFromTag, textRegionLeading, textRegionSource, textRegionTag } from '../../src/editing/TextRegionMarkers';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

function block(id: string, text: string, top: number, x = 40, width = 180): TextBlock {
  const rows = text.split('\n');
  return { id, kind: 'paragraph', pageNumber: 1, text, editable: true,
    rect: { x, y: top, width, height: 12 + (rows.length - 1) * 16 },
    lines: rows.map((text, index) => ({ text, x, y: top + index * 16, width, height: 12, baseline: top + 12 + index * 16, items: [] })),
    style: { fontName: 'Times-Roman', fontSize: 12, alignment: 'left', lineHeight: 16 / 12 } };
}
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([500, 500]), font = await pdf.embedFont(StandardFonts.TimesRoman);
  const first = block('first', 'First row\nSecond row', 50), following = block('following', 'Following paragraph', 84);
  const right = block('right', 'Other column', 84, 300, 150);
  for (const item of [first, following, right]) for (const row of item.lines) {
    row.width = font.widthOfTextAtSize(row.text, 12);
    page.drawText(row.text, { x: row.x, y: 500 - row.baseline, font, size: 12 });
  }
  return { data: new Uint8Array(await pdf.save()).buffer, first, following, right, source: new Map([[1, [first, following, right]]]) };
}
function rows(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  const result: { text: string; x: number; y: number }[] = [];
  let row = { text: '', x: 0, y: 0 };
  try {
    text.walk({ beginLine() { row = { text: '', x: 0, y: 0 }; }, onChar(character, origin, font) {
      if (!row.text) { row.x = origin[0]; row.y = origin[1]; }
      row.text += character; font.destroy();
    }, endLine() { result.push(row); } });
    return result;
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}

describe('paragraph footprint changes', () => {
  it.each([{ fontSize: 24 }, { lineHeight: 3 }])('moves following paragraphs when row count stays fixed but formatting changes: %j', async formatting => {
    const { data, first, following, right, source } = await fixture();
    const edit: TextEditOperation = { blockId: first.id, originalText: first.text, newText: first.text, timestamp: 1,
      layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true, ...formatting } };
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, [edit], undefined, layouts);
    const own = layouts.get(first.id)!;
    expect(own.layout.lines).toHaveLength(first.lines.length);
    const growth = own.layout.requiredHeight - first.rect.height;
    expect(growth).toBeGreaterThan(10);
    const written = rows(await applyTextEdits(data, source, [edit]));
    expect(written).toEqual(rows(preview));
    expect(written.find(row => row.text === following.text)?.y).toBeCloseTo(following.lines[0].baseline + growth, 2);
    expect(written.find(row => row.text === right.text)?.y).toBeCloseTo(right.lines[0].baseline, 2);
  });

  it('does not shift following text for unchanged later emphasis with a smaller first row', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 500]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = block('mixed-last', 'First row\nSecond row\nLast emphasized row', 50);
    first.lines[2].height = 14; first.lines[2].y -= 2;
    const following = block('following', 'Following paragraph', 100);
    for (const item of [first, following]) for (const [index, row] of item.lines.entries()) {
      const size = item === first && index === 2 ? 14 : 12;
      row.width = font.widthOfTextAtSize(row.text, size);
      page.drawText(row.text, { x: row.x, y: 500 - row.baseline, font, size });
    }
    const data = new Uint8Array(await pdf.save()).buffer;
    const edit: TextEditOperation = { blockId: first.id, originalText: first.text, newText: first.text.replace('First', 'Other'), timestamp: 1,
      layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true } };
    const layouts = new Map<string, PreparedTextEditLayout>(), source = new Map([[1, [first, following]]]);
    await previewInlineTextEdits(data, source, [edit], undefined, layouts);
    expect(layouts.get(first.id)!.layout.requiredHeight).toBe(first.rect.height);
    expect(rows(await applyTextEdits(data, source, [edit])).find(row => row.text === following.text)?.y).toBe(following.lines[0].baseline);
  });

  it('does not release the fixed first-baseline space when reducing font size', async () => {
    const { data, first, following, source } = await fixture();
    const edit: TextEditOperation = { blockId: first.id, originalText: first.text, newText: first.text, timestamp: 1,
      layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true, fontSize: 6 } };
    const layouts = new Map<string, PreparedTextEditLayout>();
    await previewInlineTextEdits(data, source, [edit], undefined, layouts);
    const prepared = layouts.get(first.id)!;
    expect(prepared.layout.lines[0].baseline).toBe(first.lines[0].baseline);
    expect(prepared.layout.requiredHeight).toBe(20); // old first baseline offset 12 plus new leading 8
    const result = rows(await applyTextEdits(data, source, [edit]));
    expect(result.find(row => row.text === following.text)?.y).toBe(following.lines[0].baseline - 8);
  });

  it('gives newly wrapped larger inline text enough leading for its actual glyph ink', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 500]);
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const texts = ['Alpha BIG tail words', 'Next body row', 'Last body row'];
    const first: TextBlock = { id: 'mixed-size', kind: 'paragraph', pageNumber: 1, editable: true, text: texts.join('\n'),
      rect: { x: 40, y: 42, width: 150, height: 52 },
      lines: texts.map((text, index) => ({ text, x: 40, y: 62 + index * 16 - (index ? 12 : 20), width: 150, height: index ? 12 : 20,
        baseline: 62 + index * 16, items: [] })),
      style: { fontName: 'Times-Roman', fontSize: 20, alignment: 'left', lineHeight: .8 } };
    const bigX = 40 + font.widthOfTextAtSize('Alpha ', 12);
    page.drawText('Alpha ', { x: 40, y: 438, font, size: 12 });
    page.drawText('BIG', { x: bigX, y: 438, font, size: 20 });
    page.drawText(' tail words', { x: bigX + font.widthOfTextAtSize('BIG', 20), y: 438, font, size: 12 });
    first.lines.slice(1).forEach(row => page.drawText(row.text, { x: 40, y: 500 - row.baseline, font, size: 12 }));
    const data = new Uint8Array(await pdf.save()).buffer;
    const edit: TextEditOperation = { blockId: first.id, originalText: first.text,
      newText: `Alpha BI${'gypqBig '.repeat(12)}G tail words Next body row Last body row`, timestamp: 1,
      layout: { flow: 'paragraph', reflow: true, autoGrow: true, keepBaseline: true } };
    const layouts = new Map<string, PreparedTextEditLayout>();
    const source = new Map([[1, [first]]]);
    const preview = await previewInlineTextEdits(data, source, [edit], undefined, layouts);
    const lines = layouts.get(first.id)!.layout.lines;
    expect(lines.filter(line => line.glyphs.some(glyph => glyph.fontSize === 20)).length).toBeGreaterThan(2);
    for (let index = 1; index < lines.length; index++) {
      const previous = lines[index - 1].glyphs.flatMap(glyph => glyph.inkBounds ? [glyph.inkBounds] : []);
      const current = lines[index].glyphs.flatMap(glyph => glyph.inkBounds ? [glyph.inkBounds] : []);
      expect(Math.min(...current.map(ink => ink.y))).toBeGreaterThanOrEqual(Math.max(...previous.map(ink => ink.y + ink.height)) - .01);
    }
    const saved = rows(await applyTextEdits(data, source, [edit]));
    expect(saved).toEqual(rows(preview));
    expect(saved.map(row => row.text).join('').replace(/\s/gu, '')).toBe(edit.newText.replace(/\s/gu, ''));
  });
});

const item = (str: string, x: number, baseline: number, width: number, size = 12, fontName = 'f1') =>
  ({ str, transform: [size, 0, 0, size, x, 500 - baseline], width, height: size, fontName });
const page = (items: ReturnType<typeof item>[]) => ({ pageNumber: 1, userUnit: 1,
  getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 500 - y] }),
  getTextContent: async () => ({ items, styles: { f1: { fontFamily: 'Times' }, f2: { fontFamily: 'Times-Bold' } } }),
} as unknown as PDFPageProxy);

describe('complete paragraph recognition', () => {
  it('keeps a paragraph together when one row contains slightly larger inline emphasis', async () => {
    const source = page([item('First row has ', 40, 62, 80), item('emphasis', 120, 62, 60, 14, 'f2'), item(' and continues.', 180, 62, 80),
      item('The next row continues the same paragraph.', 40, 78, 260),
      item('The last row ends here.', 40, 94, 130)]);
    const blocks = await detectTextBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[0].editable).toBe(true);
  });
  it('keeps a larger heading separate from body prose at ordinary line spacing', async () => {
    const source = page([item('A distinct heading', 40, 62, 180, 16),
      item('First body row', 40, 80, 260), item('Second body row', 40, 96, 260)]);
    const blocks = await detectTextBlocks(source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lines).toHaveLength(1);
    expect(blocks[1].lines).toHaveLength(2);
  });
});

describe('nominal paragraph leading survives PDF round trips', () => {
  it('keeps legacy region identity and round-trips precise leading', () => {
    expect(textRegionSource('PDFEditorParagraph_original_2')).toBe('original');
    expect(textRegionLeading('PDFEditorParagraph_original_2')).toBeUndefined();
    const tag = textRegionTag('paragraph', 'source_with_underscores', 2, 10.909391);
    expect(textRegionFromTag(tag)).toBe(tag);
    expect(textRegionSource(tag)).toBe('source_with_underscores');
    expect(textRegionLeading(tag)).toBe(10.909391);
    const longest = textRegionTag('line', 'a'.repeat(80), 20000, 14400);
    expect(textRegionFromTag(longest)).toBe(longest);
    expect(textRegionSource(longest)).toBe('a'.repeat(80));
    expect(textRegionLeading(longest)).toBe(14400);
    for (const value of [0, -1, Infinity, NaN, 14401]) expect(textRegionLeading(textRegionTag('paragraph', 'original', 2, value))).toBeUndefined();
    for (const suffix of ['0', '14400000001', '999999999999']) expect(textRegionLeading(`PDFEditorParagraph_original_2_L${suffix}`)).toBeUndefined();
  });

  it('restores normal paragraph spacing after saving expanded Chinese rows and deleting them', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await PDFDocument.create(), sheet = pdf.addPage([550, 650]);
    const font = await pdf.embedFont(StandardFonts.Courier), other = await pdf.embedFont(StandardFonts.TimesRoman);
    const original = ['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda'].join(' ');
    ['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda'].forEach((text, index) => sheet.drawText(text, { x: 40, y: 580 - index * 16, font, size: 14 }));
    sheet.drawText('Following paragraph', { x: 40, y: 520, font: other, size: 12 });
    sheet.drawText('with a second row', { x: 40, y: 504, font: other, size: 12 });
    let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await pdf.save());
    for (const replacement of [`${original} 中文新增文字用于检查自动换行与段落联动 ABC 123`, original]) {
      const document = await pdfjs.getDocument({ data: data.slice(), disableFontFace: true }).promise;
      try {
        const detected = await detectTextBlocks(await document.getPage(1));
        const target = detected.find(block => block.text.startsWith('alpha'))!;
        const edit: TextEditOperation = { blockId: target.id, originalText: target.text, newText: replacement, timestamp: 1,
          layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true } };
        data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, detected]]), [edit]);
        if (replacement !== original) expect(rows(data).find(row => row.text === 'Following paragraph')?.y).toBeGreaterThan(130);
      } finally { await document.destroy(); }
    }
    const restored = rows(data);
    expect(restored.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(130, 2);
    expect(restored.filter(row => /alpha|epsilon|iota/.test(row.text)).map(row => row.y)).toEqual([70, 86, 102]);
  });
});
