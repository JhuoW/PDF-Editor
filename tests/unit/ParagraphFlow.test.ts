import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyTextEdits, inspectTextBlocks, prepareTextEditLayout, previewInlineTextEdits, type PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

async function fixture(firstRows: readonly string[] = ['alpha beta gamma', 'delta epsilon']) {
  const document = await PDFDocument.create(), page = document.addPage([500, 600]);
  const font = await document.embedFont(StandardFonts.Courier);
  const blocks: TextBlock[] = [];
  for (const [id, rows, x, top, color] of [
    ['first', firstRows, 40, 60, rgb(.2, .1, .6)],
    ['next', ['Following paragraph', 'keeps its own style'], 40, 100, rgb(.1, .5, .2)],
    ['last', ['Final paragraph'], 40, 150, rgb(.1, .2, .7)],
    ['column', ['Right column stays', 'exactly where it was'], 290, 100, rgb(.3, .2, .1)],
  ] as const) {
    const lines = rows.map((text, index) => {
      const baseline = top + 14 + index * 18, width = font.widthOfTextAtSize(text, 14);
      page.drawText(text, { x, y: 600 - baseline, size: 14, font, color });
      return { text, x, y: baseline - 14, width, height: 14, baseline, items: [] };
    });
    blocks.push({ id, kind: 'paragraph', pageNumber: 1, text: rows.join('\n'), lines, editable: true,
      rect: { x, y: top, width: Math.max(...lines.map(line => line.width)), height: 14 + (rows.length - 1) * 18 },
      style: { fontName: 'Courier', fontSize: 14, alignment: 'left', lineHeight: 18 / 14 } });
  }
  return { data: new Uint8Array(await document.save()).buffer, blocks };
}
function inspect(bytes: Uint8Array | ArrayBuffer) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), structured = page.toStructuredText('');
  const rows: { text: string; y: number; font: string; size: number; color: number[] }[] = [];
  let row = { text: '', y: 0, font: '', size: 0, color: [] as number[] };
  try {
    structured.walk({ beginLine() { row = { text: '', y: 0, font: '', size: 0, color: [] }; },
      onChar(character, origin, font, size, _quad, color) { try { row.text += character; row.y = origin[1]; row.font = font.getName(); row.size = size; row.color = color; } finally { font.destroy(); } },
      endLine() { rows.push(row); } });
    return rows;
  } finally { structured.destroy(); page.destroy(); document.destroy(); }
}
const operation = (block: TextBlock, text: string, flow: 'paragraph' | 'object' = 'paragraph'): TextEditOperation => ({
  blockId: block.id, originalText: block.text, newText: text, timestamp: 1,
  layout: { keepBaseline: true, reflow: true, autoGrow: true, flow },
});

describe('paragraph reflow shared by live preview, checks and save', () => {
  it('keeps a growing single-line paragraph out of an adjacent column that begins farther down', async () => {
    const { data, blocks } = await fixture(['alpha beta gamma']), source = new Map([[1, blocks]]);
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda '.repeat(3).trim();
    const edits = [operation(blocks[0], text)], layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    const prepared = layouts.get('first')!;
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.input.rect.x + prepared.input.rect.width).toBeLessThan(blocks[3].rect.x);
    const saved = await applyTextEdits(data, source, edits);
    expect(inspect(saved)).toEqual(inspect(preview));
    expect(inspect(saved).filter(row => /Right|exactly/.test(row.text))).toEqual(inspect(data).filter(row => /Right|exactly/.test(row.text)));
    expect(inspect(saved).map(row => row.text).join('').replace(/\s/g, '')).toContain(text.replace(/\s/g, ''));
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
  });
  it('allows a lower paragraph to grow into space released by deleting an earlier paragraph', async () => {
    const document = await PDFDocument.create(), page = document.addPage([400, 200]);
    const font = await document.embedFont(StandardFonts.Courier);
    const blocks: TextBlock[] = [
      { id: 'before', rows: ['Earlier paragraph', 'has two lines'], top: 110 },
      { id: 'after', rows: ['Lower paragraph'], top: 170 },
    ].map(({ id, rows, top }) => {
      const lines = rows.map((text, index) => {
        const baseline = top + 14 + index * 18, width = font.widthOfTextAtSize(text, 14);
        page.drawText(text, { x: 40, y: 200 - baseline, font, size: 14 });
        return { text, x: 40, y: baseline - 14, width, height: 14, baseline, items: [] };
      });
      return { id, kind: 'paragraph', pageNumber: 1, text: rows.join('\n'), editable: true, lines,
        rect: { x: 40, y: top, width: Math.max(...lines.map(line => line.width)), height: 14 + (lines.length - 1) * 18 },
        style: { fontName: 'Courier', fontSize: 14, alignment: 'left', lineHeight: 18 / 14 } };
    });
    const data = new Uint8Array(await document.save()).buffer, source = new Map([[1, blocks]]);
    const edits = [operation(blocks[0], ''), operation(blocks[1], 'Lower paragraph\nSecond row')];
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    expect(layouts.get('after')!.layout.fits).toBe(true);
    expect(layouts.get('after')!.input.rect.y).toBe(138);
    const measured = await prepareTextEditLayout(data, blocks[1], edits[1], {}, { blocks, edits });
    expect(measured.layout.fits).toBe(true);
    expect(measured.input.rect).toEqual(layouts.get('after')!.input.rect);
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
    const saved = await applyTextEdits(data, source, edits);
    expect(inspect(saved)).toEqual(inspect(preview));
    expect(inspect(saved).map(row => row.text)).toEqual(['Lower paragraph', 'Second row']);
  });
  it('uses an explicitly positioned object target as an absolute position during paragraph reflow', async () => {
    const { data, blocks } = await fixture(), source = new Map([[1, blocks]]);
    const fixed: TextEditOperation = { ...operation(blocks[1], 'Fixed position', 'object'),
      layout: { flow: 'object', targetRect: { x: 40, y: 68, width: 200, height: 32 }, fontSize: 14, reflow: true } };
    const edits = [operation(blocks[0], ''), fixed];
    const prepared = await prepareTextEditLayout(data, blocks[1], fixed, {}, { blocks, edits });
    expect(prepared.input.rect.y).toBe(68);
    expect(prepared.layout.fits).toBe(true);
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    expect(layouts.get('next')!.input.rect).toEqual(prepared.input.rect);
    const saved = await applyTextEdits(data, source, edits);
    expect(inspect(saved)).toEqual(inspect(preview));
    expect(inspect(saved).find(row => row.text === 'Fixed position')!.y).toBeCloseTo(prepared.layout.lines[0].baseline, 2);
  });
  it('resets the current paragraph draft while retaining other paragraphs in the measured page plan', async () => {
    const { data, blocks } = await fixture();
    const edits = [operation(blocks[0], ''), operation(blocks[1], 'A much longer changed second paragraph with more rows')];
    const changed = { ...blocks[1], text: edits[1].newText };
    const reset: TextEditOperation = { blockId: changed.id, originalText: blocks[1].text, newText: blocks[1].text, timestamp: 2 };
    const prepared = await prepareTextEditLayout(data, changed, reset, {}, { blocks: [blocks[0], changed, ...blocks.slice(2)], edits });
    expect(prepared.input.text).toBe(blocks[1].text);
    expect(prepared.input.rect.y).toBe(blocks[1].rect.y - blocks[0].rect.height);
    expect(prepared.layout.lines.map(line => line.text)).toEqual(blocks[1].lines.map(line => line.text));
  });
  it('uses the destination of a legacy translated row object as its fixed anchor, not the vacated source', async () => {
    const { data, blocks } = await fixture();
    const object = { ...blocks[1], kind: 'line' as const };
    const source = new Map([[1, [blocks[0], object, ...blocks.slice(2)]]]);
    const move: TextEditOperation = { blockId: object.id, originalText: object.text, newText: object.text, timestamp: 1,
      layout: { keepBaseline: true, translate: true, autoGrow: false, targetRect: { ...object.rect, y: 68 } } };
    const edits = [operation(blocks[0], ''), move], layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    expect(layouts.get(object.id)!.input.rect.y).toBe(68);
    expect(layouts.get('last')!.input.rect.y).toBe(118);
    const saved = await applyTextEdits(data, source, edits);
    expect(inspect(saved)).toEqual(inspect(preview));
    expect(inspect(saved).find(row => row.text === 'Following paragraph')?.y).toBe(82);
  });
  it('grows at the same font size, moves subsequent paragraphs and leaves the other column unchanged', async () => {
    const { data, blocks } = await fixture(), source = new Map([[1, blocks]]);
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const edits = [operation(blocks[0], text)], layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    const saved = await applyTextEdits(data, source, edits);
    expect(inspect(saved)).toEqual(inspect(preview));
    const prepared = layouts.get('first')!;
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.input.fontSize).toBe(14);
    expect(prepared.layout.lines.length).toBeGreaterThan(2);
    const delta = prepared.input.rect.height - blocks[0].rect.height;
    const after = inspect(saved), before = inspect(data);
    expect(after.filter(row => /Following|keeps|Final/.test(row.text))).toEqual(before.filter(row => /Following|keeps|Final/.test(row.text)).map(row => ({ ...row, font: expect.stringMatching(/Courier|NimbusMono/), y: expect.closeTo(row.y + delta, 2) })));
    expect(after.filter(row => /Right|exactly/.test(row.text))).toEqual(before.filter(row => /Right|exactly/.test(row.text)));
    expect(after.map(row => row.text).join('').replace(/\s/g, '')).toContain(text.replace(/\s/g, ''));
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
  });
  it('pulls following paragraphs up when rows are deleted and removes a completely empty paragraph gap', async () => {
    const { data, blocks } = await fixture(), source = new Map([[1, blocks]]), before = inspect(data);
    for (const [text, delta] of [['alpha beta', -18], ['', -32]] as const) {
      const after = inspect(await applyTextEdits(data, source, [operation(blocks[0], text)]));
      expect(after.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(before.find(row => row.text === 'Following paragraph')!.y + delta, 2);
      expect(after.find(row => row.text === 'Final paragraph')?.y).toBeCloseTo(before.find(row => row.text === 'Final paragraph')!.y + delta, 2);
    }
  });
  it('lets an object gain rows without moving any other text object', async () => {
    const { data, blocks } = await fixture(), first = blocks[0];
    const line = first.lines[0], second = first.lines[1];
    const object: TextBlock = { ...first, kind: 'line', lines: [line], text: line.text, rect: { x: line.x, y: line.y, width: line.width, height: line.height } };
    const neighbor: TextBlock = { ...first, kind: 'line', id: 'second-row', lines: [second], text: second.text, rect: { x: second.x, y: second.y, width: second.width, height: second.height } };
    const text = 'alpha beta gamma\nobject line two';
    const after = inspect(await applyTextEdits(data, new Map([[1, [object, neighbor, ...blocks.slice(1)]]]), [operation(object, text, 'object')]));
    expect(after.find(row => row.text === second.text)?.y).toBeCloseTo(second.baseline, 2);
    expect(after.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(114, 2);
    expect(after.filter(row => row.text.includes('object line'))).toHaveLength(1);
    expect(after.find(row => row.text === 'alpha beta gamma')?.size).toBeCloseTo(14, 2);
  });
  it('combines edits in reading order and uses the same layout for mixed Chinese/English text', async () => {
    const { data, blocks } = await fixture(), source = new Map([[1, blocks]]);
    const edits = [operation(blocks[1], 'Following paragraph has more text and continues on several new rows'),
      operation(blocks[0], 'alpha beta gamma 中文编辑自动换行，保留完整内容。 delta epsilon')];
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    const output = await applyTextEdits(data, source, edits);
    expect(inspect(output)).toEqual(inspect(preview));
    const shift = ['first', 'next'].reduce((sum, id, index) => sum + layouts.get(id)!.input.rect.height - blocks[index].rect.height, 0);
    expect(inspect(output).find(row => row.text === 'Final paragraph')?.y).toBeCloseTo(164 + shift, 2);
    expect(inspect(output).map(row => row.text).join('')).toContain('中文编辑');
    expect([...layouts.values()].every(item => item.layout.fits && item.input.fontSize === 14)).toBe(true);
  });
  it('reports a fixed artwork conflict in the live plan and text check before rejecting save', async () => {
    const { data, blocks } = await fixture(), document = await PDFDocument.load(data);
    document.getPage(0).drawRectangle({ x: 30, y: 375, width: 200, height: 25, color: rgb(.8, .1, .1) });
    const bytes = new Uint8Array(await document.save()).buffer, source = new Map([[1, blocks]]);
    const edits = [operation(blocks[0], 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda')];
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(bytes, source, edits, undefined, layouts);
    expect(layouts.get('last')!.layout).toMatchObject({ fits: false, overflow: expect.stringContaining('image, drawing') });
    expect(inspect(preview).some(row => row.text.includes('lambda'))).toBe(true);
    expect((await inspectTextBlocks(bytes, source, edits)).issues).toContainEqual(expect.objectContaining({ blockId: 'last', kind: 'overflow', blocking: true }));
    await expect(applyTextEdits(bytes, source, edits)).rejects.toThrow(/image, drawing/);
    expect(inspect(bytes).find(row => row.text === 'Final paragraph')?.y).toBe(164);
  });
  it('retains the full draft and font size when the physical page is actually exhausted', async () => {
    const { data, blocks } = await fixture(), source = new Map([[1, blocks]]);
    const text = 'alpha beta gamma delta epsilon '.repeat(45) + 'END OF COMPLETE DRAFT';
    const edits = [operation(blocks[0], text)], layouts = new Map<string, PreparedTextEditLayout>();
    await previewInlineTextEdits(data, source, edits, undefined, layouts);
    const prepared = layouts.get('first')!;
    expect(prepared.layout.fits).toBe(false);
    expect(prepared.layout.overflow).toContain('bottom of the page');
    expect(prepared.layout.lines.map(line => line.text).join(' ').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    expect(prepared.input.fontSize).toBe(14);
    await expect(applyTextEdits(data, source, edits)).rejects.toThrow(/bottom of the page/);
  });
  it('does not remove a neighboring object whose font box overlaps a tightly led source row', async () => {
    const document = await PDFDocument.create(), page = document.addPage([400, 500]);
    const font = await document.embedFont(StandardFonts.Courier);
    const objects: TextBlock[] = ['alpha beta', 'gamma delta', 'third row'].map((text, index) => {
      const baseline = 80 + index * 9, width = font.widthOfTextAtSize(text, 11);
      page.drawText(text, { x: 40, y: 500 - baseline, font, size: 11 });
      return { id: `row-${index}`, kind: 'line', pageNumber: 1, text, editable: true,
        rect: { x: 40, y: baseline - 11, width, height: 11 },
        lines: [{ text, items: [], x: 40, y: baseline - 11, width, height: 11, baseline }],
        style: { fontName: 'Courier', fontSize: 11, alignment: 'left', lineHeight: 1.2 } };
    });
    const data = new Uint8Array(await document.save()).buffer;
    const after = inspect(await applyTextEdits(data, new Map([[1, objects]]), [operation(objects[0], 'omega beta', 'object')]));
    expect(after.find(row => row.text === 'gamma delta')?.y).toBeCloseTo(89, 2);
    expect(after.find(row => row.text === 'third row')?.y).toBeCloseTo(98, 2);
  });
  it('keeps the printed page number fixed instead of manufacturing a page-bottom overflow', async () => {
    const { data, blocks } = await fixture(), document = await PDFDocument.load(data);
    document.getPage(0).drawText('1933', { x: 240, y: 20, size: 14 });
    const footer: TextBlock = { ...blocks[0], id: 'page-number', text: '1933',
      rect: { x: 240, y: 566, width: 32, height: 14 },
      lines: [{ text: '1933', items: [], x: 240, y: 566, width: 32, height: 14, baseline: 580 }] };
    const source = new Map([[1, [...blocks, footer]]]);
    const output = await applyTextEdits(new Uint8Array(await document.save()).buffer, source,
      [operation(blocks[0], 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda')]);
    expect(inspect(output).find(row => row.text === '1933')?.y).toBeCloseTo(580, 2);
  });
});
