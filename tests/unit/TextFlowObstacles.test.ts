import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, clip, degrees, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyTextEdits, inspectTextBlocks, previewInlineTextEdits, type PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

function block(id: string, text: string, x: number, top: number, width: number, size = 12): TextBlock {
  const rows = text.split('\n');
  return { id, kind: 'paragraph', pageNumber: 1, text, editable: true,
    rect: { x, y: top, width, height: size + (rows.length - 1) * 16 },
    lines: rows.map((text, index) => ({ text, x, y: top + index * 16, width, height: size, baseline: top + size + index * 16, items: [] })),
    style: { fontName: 'Times-Roman', fontSize: size, alignment: 'left', lineHeight: 16 / size } };
}
const edit = (block: TextBlock, newText: string): TextEditOperation => ({ blockId: block.id, originalText: block.text, newText, timestamp: 1,
  layout: { flow: 'paragraph', keepBaseline: true, reflow: true, autoGrow: true } });
function read(data: ArrayBuffer | Uint8Array) {
  const doc = new mupdf.PDFDocument(data), page = doc.loadPage(0), text = page.toStructuredText('');
  const chars: { c: string; x: number; y: number; size: number }[] = [];
  try {
    text.walk({ onChar(c, origin, font, size) { chars.push({ c, x: origin[0], y: origin[1], size }); font.destroy(); } });
    return chars;
  } finally { text.destroy(); page.destroy(); doc.destroy(); }
}

describe('paragraph flow around painted page content', () => {
  it.each([0, 90, 180, 270].flatMap(rotation => [1, 2].map(unit => ({ rotation, unit }))))('allows replacements above superscripts with crop/rotation $rotation and unit $unit', async ({ rotation, unit }) => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    page.setCropBox(20, 20, 360, 360); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
    const first = block('body', 'Hanging ggg', 20 * unit, 68 * unit, 100 * unit, 12 * unit);
    page.drawText(first.text, { x: 40, y: 300, font, size: 12 });
    page.drawText('n', { x: 85, y: 290.9, font, size: 8 });
    page.drawText('formula', { x: 40, y: 286, font, size: 12 });
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first]]]);
    const edits = [edit(first, 'Changed ggg')], layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    expect(layouts.get(first.id)!.layout.fits).toBe(true);
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
    const saved = await applyTextEdits(data, source, edits);
    expect(read(saved)).toEqual(read(preview));
    expect(read(saved).filter(c => c.size === 8 * unit)).toEqual(read(data).filter(c => c.size === 8 * unit));
    expect(read(saved).map(c => c.c).join('')).toContain('formula');
  });

  it.each(['delete', 'add'] as const)('stops %s propagation across fixed artwork instead of moving unrelated lower paragraphs', async change => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = block('first', 'First row\nSecond row', 40, 50, 100);
    const next = block('after-artwork', 'After the figure', 40, 137, 100);
    for (const item of [first, next]) for (const row of item.lines) page.drawText(row.text, { x: row.x, y: 400 - row.baseline, font, size: 12 });
    page.drawRectangle({ x: 30, y: 270, width: 200, height: 25, color: rgb(.3, .4, .5) });
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first, next]]]);
    const edits = [edit(first, change === 'delete' ? '' : 'First row\nSecond row\nThird row')];
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    expect(layouts.has(next.id)).toBe(false);
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
    const saved = await applyTextEdits(data, source, edits);
    expect(read(saved)).toEqual(read(preview));
    expect(read(saved).filter(c => c.y >= 137)).toEqual(read(data).filter(c => c.y >= 137));
  });

  it('uses existing paragraph whitespace before declaring a downstream artwork conflict', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = block('caption', 'First row\nSecond row', 40, 50, 100);
    const next = block('body', 'Following paragraph', 40, 110, 110);
    const last = block('after', 'After the figure', 40, 175, 100);
    for (const item of [first, next, last]) for (const row of item.lines) page.drawText(row.text, { x: row.x, y: 400 - row.baseline, font, size: 12 });
    page.drawRectangle({ x: 30, y: 240, width: 200, height: 25, color: rgb(.3, .4, .5) });
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first, next, last]]]);
    const edits = [edit(first, 'First row\nSecond row\nThird row\nFourth row')];
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data, source, edits, undefined, layouts);
    const prepared = layouts.get(next.id)!;
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.input.rect.y).toBeGreaterThanOrEqual(110);
    expect(prepared.layout.inkBounds!.y + prepared.layout.inkBounds!.height).toBeLessThan(135);
    expect(prepared.input.fontSize).toBe(12);
    expect(layouts.has(last.id)).toBe(false);
    const saved = await applyTextEdits(data, source, edits);
    expect(read(saved)).toEqual(read(preview));
    expect(read(saved).map(glyph => glyph.c).join('')).toContain('Following paragraph');
    expect(read(saved).filter(c => c.y >= 175)).toEqual(read(data).filter(c => c.y >= 175));
  });

  it.each(['clipped', 'transparent'] as const)('allows growth where %s artwork paints no pixels', async kind => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = block('body', 'First row\nSecond row', 40, 50, 100);
    for (const row of first.lines) page.drawText(row.text, { x: row.x, y: 400 - row.baseline, font, size: 12 });
    if (kind === 'clipped') page.pushOperators(pushGraphicsState(), rectangle(300, 300, 10, 10), clip(), endPath());
    page.drawRectangle({ x: 30, y: 240, width: 200, height: 75, color: rgb(.5, .4, .3), opacity: kind === 'transparent' ? 0 : 1 });
    if (kind === 'clipped') page.pushOperators(popGraphicsState());
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first]]]);
    const edits = [edit(first, 'First row\nSecond row\nThird row\nFourth row')];
    expect((await inspectTextBlocks(data, source, edits)).issues.filter(issue => issue.blocking)).toEqual([]);
    const saved = await applyTextEdits(data, source, edits);
    expect(read(saved).map(c => c.c).join('')).toBe('First rowSecond rowThird rowFourth row');
  });

  it('treats the edges of an unfilled frame as obstacles, including when the paragraph started inside it', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = block('body', 'First row\nSecond row', 40, 70, 100);
    for (const row of first.lines) page.drawText(row.text, { x: row.x, y: 400 - row.baseline, font, size: 12 });
    page.drawRectangle({ x: 30, y: 230, width: 200, height: 120, borderColor: rgb(.3, .4, .5), borderWidth: 1 });
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first]]]);
    const fits = edit(first, 'First row\nSecond row\nThird row\nFourth row\nFifth row');
    expect((await applyTextEdits(data, source, [fits])).byteLength).toBeGreaterThan(0);
    const crosses = edit(first, `${fits.newText}\nSixth row\nSeventh row`);
    const layouts = new Map<string, PreparedTextEditLayout>();
    await previewInlineTextEdits(data, source, [crosses], undefined, layouts);
    expect(layouts.get(first.id)!.layout.fits).toBe(false);
    expect(layouts.get(first.id)!.layout.lines.map(line => line.text).join('\n')).toBe(crosses.newText);
    await expect(applyTextEdits(data, source, [crosses])).rejects.toThrow(/image, drawing/);
  });

  it('keeps object editing independent even where paragraph editing would hit fixed content', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]), font = await pdf.embedFont(StandardFonts.TimesRoman);
    const first = { ...block('object', 'Object row', 40, 50, 100), kind: 'line' as const };
    const next = { ...block('neighbor', 'Neighbor row', 40, 66, 100), kind: 'line' as const };
    for (const item of [first, next]) page.drawText(item.text, { x: 40, y: 400 - item.lines[0].baseline, font, size: 12 });
    const data = new Uint8Array(await pdf.save()).buffer, source = new Map([[1, [first, next]]]);
    const operation = edit(first, 'Object row\nLocal second row'); operation.layout!.flow = 'object';
    const saved = await applyTextEdits(data, source, [operation]);
    expect(read(saved).filter(c => c.y === 78).map(c => c.c).join('')).toContain('Neighbor row');
    expect(read(saved).map(c => c.c).join('')).toContain('Local second row');
  });
});
