import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFOperator, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { detectTextBlocks } from '../../src/editing/TextBlockDetector';
import { originalParagraphText } from '../../src/editing/ParagraphText';
import { textRegionBaselineOffset, textRegionLeading, textRegionSource, textRegionTag } from '../../src/editing/TextRegionMarkers';
import { textFrameFromTag, textFrameTag } from '../../src/editing/TextFrameMarkers';
import { applyTextEdits, previewInlineTextEdits, type PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

async function fixture(alignment: 'left' | 'center' | 'right' = 'left') {
  const document = await PDFDocument.create(), page = document.addPage([550, 700]);
  const font = await document.embedFont(StandardFonts.Courier);
  for (const [text, x, y] of [
    ['Alpha beta gamma delta', 40, 630], ['epsilon zeta eta theta', 40, 614], ['iota kappa lambda', 40, 598],
    ['Following paragraph', 40, 570], ['second following row', 40, 554],
    ['Right column first', 320, 630], ['Right column second', 320, 614],
  ] as const) {
    const inset = x === 40 && y >= 598 ? (184.8 - font.widthOfTextAtSize(text, 14)) * (alignment === 'center' ? .5 : alignment === 'right' ? 1 : 0) : 0;
    page.drawText(text, { x: x + inset, y, font, size: 14 });
  }
  return new Uint8Array(await document.save());
}
async function detect(data: Uint8Array, kind: 'paragraph' | 'line' = 'paragraph'): Promise<TextBlock[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: data.slice(), disableFontFace: true,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
  try { return await detectTextBlocks(await document.getPage(1), kind); }
  finally { await document.destroy(); }
}
function inspect(data: Uint8Array) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(0), text = page.toStructuredText('');
  const glyphs: { text: string; x: number; y: number; size: number }[] = [];
  try { text.walk({ onChar(character, point, font, size) {
    glyphs.push({ text: character, x: point[0], y: point[1], size }); font.destroy();
  } }); return { text: text.asText(), glyphs }; }
  finally { text.destroy(); page.destroy(); document.destroy(); }
}
function edit(block: TextBlock, text: string): TextEditOperation {
  return { blockId: block.id, originalText: block.text, newText: text, timestamp: 1,
    layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true } };
}

describe('extreme paragraph editing through physical PDF round trips', () => {
  it.each([false, true])('retains one-row paragraph growth or explicit wrap width after reopening: fixed=%s', async fixed => {
    const document = await PDFDocument.create(), page = document.addPage([550, 700]), font = await document.embedFont(StandardFonts.Courier);
    page.drawText('Alpha', { x: 40, y: 630, size: 14, font });
    page.drawText('Following paragraph', { x: 40, y: 570, size: 14, font });
    let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await document.save());
    for (const [index, replacement] of ['Alpha beta', 'Alpha beta gamma'].entries()) {
      const blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
      const operation = edit(block, replacement);
      if (!index && fixed) operation.layout!.targetRect = { ...block.rect, width: font.widthOfTextAtSize('Alpha beta', 14) };
      data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [operation]);
    }
    const blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    expect(originalParagraphText(block.text, block.lines)).toBe('Alpha beta gamma');
    if (fixed) expect(block.lines.length).toBeGreaterThan(1);
    else {
      expect(block.lines).toHaveLength(1);
      expect(inspect(data).glyphs.find(glyph => glyph.text === 'F')?.y).toBe(130);
    }
  });

  it('preserves manual blank lines when reopening and replacing one word', async () => {
    let data: Uint8Array<ArrayBufferLike> = await fixture();
    let blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [edit(block, 'Alpha\n\nBeta\n\n\nGamma')]);
    const before = inspect(data);
    blocks = await detect(data); block = blocks.find(item => item.text === 'Beta')!;
    const text = originalParagraphText(block.text);
    data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [edit(block, text.replace('Beta', 'Zeta'))]);
    const after = inspect(data);
    expect(after.text).toContain('Zeta');
    expect(after.glyphs.filter(item => item.text === 'G')).toEqual(before.glyphs.filter(item => item.text === 'G'));
    expect(after.glyphs.filter(item => item.x >= 300)).toEqual(before.glyphs.filter(item => item.x >= 300));
  });

  it.each(([20, 1] as const).flatMap(size => (['left', 'center', 'right'] as const).map(alignment => ({ size, alignment }))))('preserves column and following positions over six font changes: $alignment, $size pt', async ({ size: changedSize, alignment }) => {
    let data: Uint8Array<ArrayBufferLike> = await fixture(alignment);
    const before = inspect(data);
    const originalBlock = (await detect(data)).find(item => item.text.startsWith('Alpha'))!;
    const directory = process.env.PDF_EDITOR_CORE_ARTIFACTS;
    const persist = async (name: string) => {
      if (!directory || alignment !== 'left' || changedSize !== 20) return;
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(directory, { recursive: true }); await writeFile(`${directory}/${name}.pdf`, data);
    };
    await persist('before');
    for (const [index, fontSize] of [changedSize, 14, changedSize, 14, changedSize, 14].entries()) {
      const blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
      const operation = edit(block, originalParagraphText(block.text));
      operation.layout!.fontSize = fontSize;
      data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [operation]);
      const detected = (await detect(data)).find(item => item.text.startsWith('Alpha'))!;
      expect(detected.style.alignment).toBe(originalBlock.style.alignment);
      expect(detected.rect.x).toBeCloseTo(originalBlock.rect.x, 2);
      expect(detected.rect.width).toBeCloseTo(originalBlock.rect.width, 2);
      if (index === 0) await persist('grown');
    }
    await persist('restored');
    const after = inspect(data);
    expect(after.glyphs.filter(item => item.x >= 300)).toEqual(before.glyphs.filter(item => item.x >= 300));
    expect(after.text.replace(/\s/gu, '')).toBe(before.text.replace(/\s/gu, ''));
    expect(after.glyphs.find(item => item.text === 'F')?.y).toBeCloseTo(before.glyphs.find(item => item.text === 'F')!.y, 2);
    expect(after.glyphs.every(item => Math.abs(item.size - 14) < .001)).toBe(true);
  });

  it.each([
    { name: 'delete the complete paragraph', replacement: '', fits: true },
    { name: 'blank rows', replacement: ' \n\n  ', fits: true },
    { name: 'mixed punctuation and CJK', replacement: '中文（保留标点）ABC 123，自动换行。'.repeat(8), fits: true },
    { name: 'many explicit newlines', replacement: 'Alpha\n'.repeat(80) + 'LAST', fits: false },
    { name: 'very long no-space token', replacement: 'abcdef'.repeat(600), fits: false },
  ])('retains content and uses the same preview/export decision: $name', async ({ replacement, fits }) => {
    const data = await fixture(), original = data.slice(), blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    const source = new Map([[1, blocks]]), operation = edit(block, replacement), layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data.buffer, source, [operation], undefined, layouts);
    const planned = layouts.get(block.id)!;
    expect(planned.input.text).toBe(replacement);
    expect(planned.input.fontSize).toBe(14);
    expect(planned.layout.fits).toBe(fits);
    expect(planned.layout.lines.flatMap(line => line.glyphs).map(glyph => glyph.character).join('').replace(/\s/gu, '')).toBe(replacement.replace(/\s/gu, ''));
    if (fits) expect(inspect(await applyTextEdits(data.buffer, source, [operation]))).toEqual(inspect(preview));
    else await expect(applyTextEdits(data.buffer, source, [operation])).rejects.toThrow(/bottom of the page/);
    expect(operation.newText).toBe(replacement);
    expect(data).toEqual(original);
  });

  it('scales saved logical frames with the physical PDF and retains physical object hit areas', async () => {
    const source = await fixture('center'), blocks = await detect(source), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    const operation = edit(block, originalParagraphText(block.text)); operation.layout!.fontSize = 20;
    const written = await applyTextEdits(source.buffer, new Map([[1, blocks]]), [operation]);
    const paragraph = (await detect(written)).find(item => item.text.startsWith('Alpha'))!;
    const object = (await detect(written, 'line')).find(item => item.text.startsWith('Alpha'))!;
    expect(paragraph.rect.y).toBeCloseTo(56, 2);
    expect(object.rect.y).toBeCloseTo(50, 2);
    expect(object.rect.height).toBeCloseTo(20, 2);
    expect(object.authoredLayout).toBeUndefined();
    const document = await PDFDocument.load(written);
    document.getPage(0).scale(1.5, 1.5);
    const scaled = new Uint8Array(await document.save()), scaledBlocks = await detect(scaled);
    const scaledParagraph = scaledBlocks.find(item => item.text.startsWith('Alpha'))!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(scaledParagraph.rect[key]).toBeCloseTo(paragraph.rect[key] * 1.5, 2);
    expect(scaledParagraph.style.fontSize).toBeCloseTo(30, 2);
    expect(scaledParagraph.style.alignment).toBe('center');
    expect(scaledParagraph.style.lineHeight).toBeCloseTo(paragraph.style.lineHeight, 5);
    const unchanged = inspect(await applyTextEdits(scaled.buffer, new Map([[1, scaledBlocks]]), [edit(scaledParagraph, originalParagraphText(scaledParagraph.text))]));
    const before = inspect(scaled);
    expect(unchanged.text.replace(/\s/gu, '')).toBe(before.text.replace(/\s/gu, ''));
    expect(unchanged.glyphs.length).toBe(before.glyphs.length);
    unchanged.glyphs.forEach((glyph, index) => {
      expect(glyph.x).toBeCloseTo(before.glyphs[index].x, 2);
      expect(glyph.y).toBeCloseTo(before.glyphs[index].y, 2);
      expect(glyph.size).toBeCloseTo(before.glyphs[index].size, 2);
    });
  });

  it('discards a stale logical frame when redaction removes only a row prefix', async () => {
    const source = await fixture(), blocks = await detect(source), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    const operation = edit(block, originalParagraphText(block.text)); operation.layout!.fontSize = 20;
    const written = await applyTextEdits(source.buffer, new Map([[1, blocks]]), [operation]);
    const document = new mupdf.PDFDocument(written), page = document.loadPage(0), redaction = page.createAnnotation('Redact');
    let redacted: Uint8Array;
    try {
      redaction.setRect([39, 49, 99, 72]);
      page.applyRedactions(false, 0, 0, 0);
      const saved = document.saveToBuffer('garbage=4,compress');
      try { redacted = saved.asUint8Array().slice(); } finally { saved.destroy(); }
    } finally { redaction.destroy(); page.destroy(); document.destroy(); }
    const detected = await detect(redacted);
    const remaining = detected.find(item => item.text.includes('gamma'))!;
    expect(remaining.text).not.toContain('Alpha');
    expect(remaining.authoredLayout).toBeUndefined();
    expect(remaining.rect.y).toBeCloseTo(remaining.lines[0].y, 2);
  });

  it('keeps every character of a long unbroken token across automatic wrapping', async () => {
    const data = await fixture(), blocks = await detect(data), block = blocks.find(item => item.text.startsWith('Alpha'))!;
    const replacement = 'alpha'.repeat(100), operation = edit(block, replacement);
    const layouts = new Map<string, PreparedTextEditLayout>();
    const preview = await previewInlineTextEdits(data.buffer, new Map([[1, blocks]]), [operation], undefined, layouts);
    const planned = layouts.get(block.id)!;
    expect(planned.layout.lines.flatMap(line => line.glyphs).map(glyph => glyph.character).join('')).toBe(replacement);
    expect(planned.input.fontSize).toBe(14);
    if (planned.layout.fits) {
      const output = inspect(await applyTextEdits(data.buffer, new Map([[1, blocks]]), [operation]));
      expect(output).toEqual(inspect(preview));
      expect(output.text.replace(/\s/gu, '')).toContain(replacement);
    } else await expect(applyTextEdits(data.buffer, new Map([[1, blocks]]), [operation])).rejects.toThrow();
  });

  it('validates logical baseline metadata without changing existing source identities', () => {
    const id = 'a'.repeat(80), tag = textRegionTag('paragraph', id, 20000, 14400, 14400);
    expect(textRegionBaselineOffset(tag)).toBe(14400);
    expect(textRegionLeading(tag)).toBe(14400);
    expect(textRegionSource(tag)).toBe(id);
    for (const value of [-1, 0, Infinity, NaN, 14400.001]) expect(textRegionBaselineOffset(textRegionTag('paragraph', 'source', 0, 16, value))).toBeUndefined();
    for (const value of ['0', '14400000001', '999999999999']) expect(textRegionBaselineOffset(`PDFEditorParagraph_source_0_L16000000_B${value}`)).toBeUndefined();
  });

  it('validates logical frame metadata before using it as layout bounds', () => {
    const frame = { width: 184.8, xOffset: -1.2, baselineOffset: 14, fontSize: 20, alignment: 'right' as const };
    expect(textFrameFromTag(textFrameTag(frame))).toEqual(frame);
    for (const value of [0, -1, Infinity, NaN, 14401]) {
      expect(textFrameTag({ ...frame, width: value })).toBeUndefined();
      expect(textFrameTag({ ...frame, baselineOffset: value })).toBeUndefined();
    }
    expect(textFrameFromTag('PDFEditorFrame_99999999999_0_14000000_14000000_0')).toBeUndefined();
    expect(textFrameFromTag('PDFEditorFrame_1000000_0_0_14000000_0')).toBeUndefined();
    expect(textFrameFromTag('PDFEditorFrame_1000000_0_14000000_0_0')).toBeUndefined();
  });

  it('ignores forged PDF frames that become oversized after font scaling', async () => {
    const document = await PDFDocument.create(), page = document.addPage([550, 700]), font = await document.embedFont(StandardFonts.Courier);
    const frame = textFrameTag({ width: 14400, xOffset: 14400, baselineOffset: 14400, fontSize: 1, alignment: 'right' })!;
    page.pushOperators(PDFOperator.of('BMC', [PDFName.of(textRegionTag('paragraph', 'forged', 0, 16))]), PDFOperator.of('BMC', [PDFName.of(frame)]));
    page.drawText('Alpha beta', { x: 40, y: 630, size: 14, font });
    page.pushOperators(PDFOperator.of('EMC'), PDFOperator.of('EMC'));
    const [block] = await detect(new Uint8Array(await document.save()));
    expect(block.authoredLayout).toBeUndefined();
    expect(block.rect.x).toBe(40);
    expect(block.rect.y).toBe(56);
    expect(block.rect.width).toBeCloseTo(font.widthOfTextAtSize('Alpha beta', 14), 2);
    expect(block.rect.height).toBe(14);
    expect(block.style.alignment).toBe('left');
    expect(block.style.lineHeight).toBeCloseTo(16 / 14, 6);
  });
});
