import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, TextRenderingMode, degrees, rgb, setTextRenderingMode } from 'pdf-lib';
import { applyTextEdits, prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { loadMuPDF, toMuPDFPageRect } from '../../src/utils/mupdf';
import { appendInvisibleText } from '../../src/ocr/pdfTextLayer';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

function block(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: 'block-1-0', pageNumber: 1, text: 'OLD CONTENT', editable: true,
    rect: { x: 30, y: 60, width: 220, height: 40 },
    lines: [{ items: [], text: 'OLD CONTENT', x: 30, y: 68, width: 90, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 },
    ...overrides,
  };
}

function edit(newText: string, timestamp = 1, originalText = 'OLD CONTENT'): TextEditOperation {
  return { blockId: 'block-1-0', originalText, newText, timestamp };
}

async function fixture() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  page.drawRectangle({ x: 30, y: 500, width: 220, height: 40, color: rgb(0.7, 0.9, 1) });
  page.drawText('OLD CONTENT', { x: 30, y: 520, size: 12, color: rgb(0.2, 0.1, 0.6) });
  page.drawText('UNCHANGED OUTSIDE', { x: 30, y: 200, size: 12 });
  const image = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64'));
  page.drawImage(image, { x: 210, y: 510, width: 20, height: 20 });
  const field = pdf.getForm().createTextField('Preserved form');
  field.setText('Original form value');
  field.addToPage(page, { x: 30, y: 100, width: 200, height: 20 });
  return new Uint8Array(await pdf.save()).buffer;
}

async function inspect(data: ArrayBuffer | Uint8Array, pageIndex = 0) {
  const engine = await loadMuPDF();
  const document = new engine.PDFDocument(data);
  const page = document.loadPage(pageIndex);
  const structured = page.toStructuredText('preserve-images');
  const pixmap = page.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, true);
  let imageCount = 0;
  structured.walk({ onImageBlock() { imageCount++; } });
  const result = {
    text: structured.asText(), imageCount,
    pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth(), height: pixmap.getHeight(),
  };
  structured.destroy(); pixmap.destroy(); page.destroy(); document.destroy();
  return result;
}

async function mixedOCRFixture() {
  const engine = await loadMuPDF();
  const original = new engine.PDFDocument(await fixture());
  const originalPage = original.loadPage(0);
  const rendered = originalPage.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, false);
  const png = new Uint8Array(rendered.asPNG());
  rendered.destroy(); originalPage.destroy(); original.destroy();
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]).drawText('OLD CONTENT', { x: 30, y: 520, size: 12 });
  const scan = await pdf.embedPng(png);
  const scannedPage = pdf.addPage([400, 600]);
  scannedPage.drawImage(scan, { x: 0, y: 0, width: 400, height: 600 });
  scannedPage.drawText('VISIBLE OUTSIDE OCR', { x: 30, y: 220, size: 12 });
  const document = new engine.PDFDocument(await pdf.save());
  const page = document.loadPage(1);
  try {
    // Use the actual OCR writer, including its nested Form and render mode 3.
    appendInvisibleText(engine, document, page, [{ text: 'OLD CONTENT', bbox: { x0: 30, y0: 68, x1: 120, y1: 84 } }], { scale: 1, x: 0, y: 0 });
    const saved = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { return new Uint8Array(saved.asUint8Array()).buffer; }
    finally { saved.destroy(); }
  } finally { page.destroy(); document.destroy(); }
}

describe('original PDF text replacement', () => {
  it('resolves the actual source font and color without mutating the original block', async () => {
    const source = block(), copy = structuredClone(source), prepared = await prepareTextEditLayout(await fixture(), source);
    expect(prepared.input.fontName).toBe('Helvetica'); expect(prepared.input.fontColor).toBe('#331a99'); expect(prepared.input.legacyBaseline).toBe(80);
    expect(prepared.page).toEqual({ width: 400, height: 600 }); expect(source).toEqual(copy);
  });
  it('rejects mismatched source identities, invalid target bounds and read-only blocks during measurement', async () => {
    const data = await fixture(), source = block();
    await expect(prepareTextEditLayout(data, source, { ...edit('Changed'), blockId: 'another-block' })).rejects.toThrow(/selected source block/);
    await expect(prepareTextEditLayout(data, source, { ...edit('Changed'), layout: { targetRect: { x: 350, y: 100, width: 100, height: 50 } } })).rejects.toThrow(/inside the visible page/);
    await expect(prepareTextEditLayout(data, { ...source, editable: false }, edit('Changed'))).rejects.toThrow(/read-only/);
    const output = await applyTextEdits(data, new Map([[1, [source]]]), [edit('\n')]); expect((await inspect(output)).text).not.toContain('OLD CONTENT');
  });
  it('applies style-only changes at a moved target without deleting neighboring content inside the enlarged layout region', async () => {
    const data = await fixture(), source = block(), copy = structuredClone(source), target = { x: 30, y: 300, width: 300, height: 220 };
    const operation = { ...edit('OLD CONTENT'), layout: { targetRect: target, fontSize: 22, fontName: 'Times-Bold', fontColor: '#cc2200' } };
    const prepared = await prepareTextEditLayout(data, source, operation); expect(prepared.layout.fits).toBe(true); expect(prepared.input.legacyBaseline).toBeUndefined();
    const output = await applyTextEdits(data, new Map([[1, [source]]]), [operation]), result = await inspect(output), before = await inspect(data);
    expect(result.text.match(/OLD CONTENT/g)).toHaveLength(1); expect(result.text).toContain('UNCHANGED OUTSIDE'); expect(result.imageCount).toBe(1);
    // The unrelated original line is inside targetRect, but outside the original removal rect.
    expect(Buffer.from(result.pixels.slice(385 * result.width * 3, 410 * result.width * 3)).equals(Buffer.from(before.pixels.slice(385 * before.width * 3, 410 * before.width * 3)))).toBe(true);
    const engine = await loadMuPDF(), document = new engine.PDFDocument(output), page = document.loadPage(0), text = page.toStructuredText('');
    let color: number[] | undefined, fontName = '', firstBaseline = 0;
    text.walk({ onChar(character, origin, font, _size, _quad, rgb) { try { if (!color && character === 'O' && origin[1] > 300 && origin[1] < 350) { color = rgb; fontName = font.getName(); firstBaseline = origin[1]; } } finally { font.destroy(); } } });
    expect(color).toEqual([0.8, expect.closeTo(34 / 255, 5), 0]); expect(fontName).toMatch(/Times|NimbusRoman/i); expect(firstBaseline).toBeCloseTo(prepared.layout.lines[0].baseline, 3);
    text.destroy(); page.destroy(); document.destroy(); expect(source).toEqual(copy);
  });
  it('exports a longer Latin/CJK paragraph using exactly the measured line positions', async () => {
    const data = await fixture(), source = block(), replacement = 'This paragraph is longer than the original text. 中文段落自动换行，完整保留所有文字。\nThe second paragraph stays separate.';
    const operation = { ...edit(replacement), layout: { targetRect: { x: 30, y: 125, width: 220, height: 180 }, fontSize: 15, alignment: 'justify' as const, lineHeight: 1.4 } };
    const prepared = await prepareTextEditLayout(data, source, operation); expect(prepared.layout.fits).toBe(true); expect(prepared.layout.lines.length).toBeGreaterThan(3);
    const output = await applyTextEdits(data, new Map([[1, [source]]]), [operation]), result = await inspect(output);
    expect(result.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, '')); expect(result.text).not.toContain('OLD CONTENT'); expect(result.text).toContain('UNCHANGED OUTSIDE'); expect(result.imageCount).toBe(1);
  });
  it('measures overflow before any content removal and only accepts an explicitly chosen suggested font size', async () => {
    const data = await fixture(), source = block(), operation = { ...edit('A long paragraph that needs a substantially smaller font size to fit in this rectangle.'), layout: { targetRect: { x: 30, y: 150, width: 130, height: 35 }, fontSize: 24 } };
    const prepared = await prepareTextEditLayout(data, source, operation); expect(prepared.layout.fits).toBe(false); expect(prepared.layout.suggestedFontSize).toBeDefined();
    const engine = await loadMuPDF(), create = vi.spyOn(engine.PDFPage.prototype, 'createAnnotation');
    try { await expect(applyTextEdits(data, new Map([[1, [source]]]), [operation])).rejects.toThrow(/no text was truncated/); expect(create).not.toHaveBeenCalled(); } finally { create.mockRestore(); }
    const output = await applyTextEdits(data, new Map([[1, [source]]]), [{ ...operation, layout: { ...operation.layout, fontSize: prepared.layout.suggestedFontSize } }]);
    expect((await inspect(output)).text.replace(/\s/g, '')).toContain(operation.newText.replace(/\s/g, ''));
  });
  it('exports a legacy draft after one suggested shrink or height adjustment', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 600]), font = await pdf.embedFont(StandardFonts.HelveticaBold);
    page.drawText('OLD', { x: 30, y: 520, size: 12, font });
    const data = new Uint8Array(await pdf.save()).buffer, source = block({ text: 'OLD', rect: { x: 30, y: 68, width: 70.02, height: 12 } });
    const operation = edit('Longer text needs a smaller font', 1, 'OLD'), prepared = await prepareTextEditLayout(data, source, operation);
    expect(prepared.input.fontName).toBe('Helvetica-Bold'); expect(prepared.input.legacyBaseline).toBe(80); expect(prepared.layout.fits).toBe(false);
    for (const layout of [{ fontSize: prepared.layout.suggestedFontSize }, { targetRect: { ...source.rect, height: prepared.layout.suggestedHeight! } }]) {
      const explicit = { ...operation, layout }, measured = await prepareTextEditLayout(data, source, explicit); expect(measured.layout.fits).toBe(true);
      const output = await applyTextEdits(data, new Map([[1, [source]]]), [explicit]); expect((await inspect(output)).text.replace(/\s/g, '')).toContain(operation.newText.replace(/\s/g, ''));
    }
  });
  it.each([0, 90, 180, 270])('positions explicit source and target regions independently with CropBox/UserUnit/Rotate %i', async rotation => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 700]); page.setCropBox(50, 70, 300, 450); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    page.drawText('OLD CONTENT', { x: 80, y: 450, size: 12 }); page.drawText('KEEP NEIGHBOR', { x: 150, y: 300, size: 12 });
    const data = new Uint8Array(await pdf.save()).buffer, source = block({ rect: { x: 60, y: 116, width: 250, height: 40 }, lines: [{ items: [], text: 'OLD CONTENT', x: 60, y: 116, width: 180, height: 24, baseline: 140 }], style: { fontName: 'Helvetica', fontSize: 24, alignment: 'left', lineHeight: 1.2 } });
    const target = { x: 180, y: 300, width: 330, height: 240 }, operation = { ...edit('中文 NEW TARGET'), layout: { targetRect: target, fontSize: 26, fontColor: '#0044cc', alignment: 'center' as const } };
    const output = await applyTextEdits(data, new Map([[1, [source]]]), [operation]), result = await inspect(output);
    expect(result.text).not.toContain('OLD CONTENT'); expect(result.text).toContain('KEEP NEIGHBOR'); expect(result.text).toContain('中文 NEW TARGET');
    const engine = await loadMuPDF(), document = new engine.PDFDocument(output), editedPage = document.loadPage(0), text = editedPage.toStructuredText(''), bounds = toMuPDFPageRect(engine, editedPage, target);
    const quads = text.search('中文 NEW TARGET', {}).flat(); expect(quads.length).toBeGreaterThan(0);
    for (const quad of quads) for (let index = 0; index < quad.length; index += 2) { expect(quad[index]).toBeGreaterThanOrEqual(bounds[0] - 3); expect(quad[index]).toBeLessThanOrEqual(bounds[2] + 3); expect(quad[index + 1]).toBeGreaterThanOrEqual(bounds[1] - 3); expect(quad[index + 1]).toBeLessThanOrEqual(bounds[3] + 3); }
    text.destroy(); editedPage.destroy(); document.destroy();
  });
  it('replaces text content while retaining images, background vectors, outside text, and form fields', async () => {
    const data = await fixture();
    const output = await applyTextEdits(data, new Map([[1, [block()]]]), [edit('NEW CONTENT')]);
    const before = await inspect(data);
    const after = await inspect(output);
    expect(after.text).toContain('NEW CONTENT');
    expect(after.text).not.toContain('OLD CONTENT');
    expect(after.text).toContain('UNCHANGED OUTSIDE');
    expect(after.imageCount).toBe(before.imageCount);
    expect(after.imageCount).toBe(1);
    // Unchanged regions render identically, including the image inside the edited area.
    const pixel = (pixels: Uint8Array, x: number, y: number) => pixels.slice((y * before.width + x) * 3, (y * before.width + x) * 3 + 3);
    expect(pixel(after.pixels, 220, 80)).toEqual(pixel(before.pixels, 220, 80));
    expect(pixel(after.pixels, 45, 95)).toEqual(pixel(before.pixels, 45, 95));
    expect(pixel(after.pixels, 45, 95)).not.toEqual(new Uint8Array([255, 255, 255]));
    expect(after.pixels.slice(150 * before.width * 3)).toEqual(before.pixels.slice(150 * before.width * 3));
    const parsed = await PDFDocument.load(output);
    expect(parsed.getForm().getTextField('Preserved form').getText()).toBe('Original form value');
  });

  it('embeds Chinese and mixed Latin text with extractable Unicode', async () => {
    const output = await applyTextEdits(await fixture(), new Map([[1, [block()]]]), [edit('中文修改 Hello 世界')]);
    const result = await inspect(output);
    expect(result.text).toContain('中文修改 Hello 世界');
    expect(result.text).not.toContain('OLD CONTENT');
    expect(result.text).not.toContain('�');
  });

  it('uses only the latest edit per block and supports deleting all text', async () => {
    const data = await fixture();
    const map = new Map([[1, [block()]]]);
    const output = await applyTextEdits(data, map, [edit('First', 1), edit('Final', 3, 'First'), edit('Obsolete', 2, 'First')]);
    expect((await inspect(output)).text).toContain('Final');
    expect((await inspect(output)).text).not.toContain('First');
    const deleted = await applyTextEdits(data, map, [edit('')]);
    expect((await inspect(deleted)).text).not.toContain('OLD CONTENT');
    expect((await inspect(deleted)).text).toContain('UNCHANGED OUTSIDE');
  });

  it('preserves explicit newlines and wraps words within the available block', async () => {
    const output = await applyTextEdits(await fixture(), new Map([[1, [block({ rect: { x: 30, y: 60, width: 100, height: 55 } })]]]), [edit('First line\nsecond line wraps here')]);
    const text = (await inspect(output)).text;
    expect(text).toMatch(/First line\nsecond line/);
    expect(text.replace(/\s+/g, ' ')).toContain('First line second line wraps here');
    expect(text.trim().split('\n').filter(Boolean)).toHaveLength(4); // outside text plus three replacement lines
  });

  it('rejects overflow and unsupported glyphs instead of dropping content', async () => {
    const data = await fixture();
    const map = new Map([[1, [block({ rect: { x: 30, y: 60, width: 20, height: 12 } })]]]);
    await expect(applyTextEdits(data, map, [edit('A replacement that cannot fit')])).rejects.toThrow(/no text was truncated|wider than/);
    await expect(applyTextEdits(data, new Map([[1, [block()]]]), [edit('\u{10FFFF}')])).rejects.toThrow('does not support');
    expect((await inspect(data)).text).toContain('OLD CONTENT');
  });

  it('returns unchanged bytes for no-op edits and fails clearly for a missing block', async () => {
    const data = await fixture();
    expect(await applyTextEdits(data, new Map(), [])).toEqual(new Uint8Array(data));
    expect(await applyTextEdits(data, new Map([[1, [block()]]]), [edit('Temporary'), edit('OLD CONTENT', 2, 'Temporary')])).toEqual(new Uint8Array(data));
    await expect(applyTextEdits(data, new Map(), [edit('New')])).rejects.toThrow('text block block-1-0 is missing');
  });

  it.each(['REPLACEMENT', ''])('rejects replacing or deleting invisible OCR text despite stale editable flags (%j)', async replacement => {
    const data = await mixedOCRFixture();
    const copy = data.slice(0);
    const before = await inspect(data, 1);
    expect(before.text).toContain('OLD CONTENT');
    expect(before.imageCount).toBe(1);
    const staleBlock = block({ pageNumber: 2, editable: true });
    await expect(applyTextEdits(data, new Map([[2, [staleBlock]]]), [edit(replacement)])).rejects.toThrow(/Page 2.*invisible OCR text layer.*original image/);
    expect(data).toEqual(copy);
    expect((await inspect(data, 1)).pixels).toEqual(before.pixels);
  });

  it('preflights all edited pages before modifying a clean page when another target contains OCR text', async () => {
    const data = await mixedOCRFixture();
    const engine = await loadMuPDF();
    const createAnnotation = vi.spyOn(engine.PDFPage.prototype, 'createAnnotation');
    try {
      const clean = block();
      const scanned = block({ id: 'block-2-0', pageNumber: 2 });
      await expect(applyTextEdits(data, new Map([[1, [clean]], [2, [scanned]]]), [
        edit('CLEAN PAGE EDIT'), { ...edit('SCANNED PAGE EDIT'), blockId: scanned.id },
      ])).rejects.toThrow('Page 2 contains an invisible OCR text layer');
      expect(createAnnotation).not.toHaveBeenCalled();
      expect((await inspect(data)).text).toContain('OLD CONTENT');
    } finally { createAnnotation.mockRestore(); }
  });

  it('conservatively refuses visible text elsewhere on an OCR page', async () => {
    const data = await mixedOCRFixture();
    const visible = block({ pageNumber: 2, text: 'VISIBLE OUTSIDE OCR', rect: { x: 30, y: 360, width: 220, height: 40 },
      lines: [{ items: [], text: 'VISIBLE OUTSIDE OCR', x: 30, y: 368, width: 150, height: 12, baseline: 380 }] });
    await expect(applyTextEdits(data, new Map([[2, [visible]]]), [edit('CHANGED', 1, visible.text)])).rejects.toThrow('invisible OCR text layer');
  });

  it('still allows no-op OCR edits and editing a different clean page in the same document', async () => {
    const data = await mixedOCRFixture();
    expect(await applyTextEdits(data, new Map([[2, [block({ pageNumber: 2 })]]]), [edit('OLD CONTENT')])).toEqual(new Uint8Array(data));
    const output = await applyTextEdits(data, new Map([[1, [block()]]]), [edit('CHANGED CLEAN PAGE')]);
    expect((await inspect(output)).text).toContain('CHANGED CLEAN PAGE');
    const beforeOCR = await inspect(data, 1);
    const afterOCR = await inspect(output, 1);
    expect(afterOCR.text).toEqual(beforeOCR.text);
    expect(afterOCR.pixels).toEqual(beforeOCR.pixels);
  });

  it.each([TextRenderingMode.FillAndClip, TextRenderingMode.OutlineAndClip, TextRenderingMode.FillAndOutlineAndClip, TextRenderingMode.Clip])('rejects clipping text rendering mode %i even when cached blocks are editable', async mode => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 600]);
    page.pushOperators(setTextRenderingMode(mode));
    page.drawText('OLD CONTENT', { x: 30, y: 520, size: 12 });
    const data = new Uint8Array(await pdf.save()).buffer;
    const copy = data.slice(0);
    await expect(applyTextEdits(data, new Map([[1, [block()]]]), [edit('NEW CONTENT')])).rejects.toThrow('Page 1 uses text as a clipping path');
    expect(data).toEqual(copy);
  });

  it.each([0, 90, 180, 270])('handles a nonzero CropBox, /UserUnit, and page rotation %i', async rotation => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([500, 700]);
    page.setCropBox(50, 70, 300, 450);
    page.setRotation(degrees(rotation));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    page.drawText('OLD CONTENT', { x: 80, y: 450, size: 12 });
    page.drawText('UNCHANGED OUTSIDE', { x: 80, y: 170, size: 12 });
    const source = new Uint8Array(await pdf.save()).buffer;
    const target = block({
      rect: { x: 60, y: 116, width: 400, height: 80 },
      lines: [{ items: [], text: 'OLD CONTENT', x: 60, y: 116, width: 180, height: 24, baseline: 140 }],
      style: { fontName: 'Helvetica', fontSize: 24, alignment: 'left', lineHeight: 1.2 },
    });
    const output = await applyTextEdits(source, new Map([[1, [target]]]), [edit('中文 NEW')]);
    const result = await inspect(output);
    expect(result.text).toContain('中文 NEW');
    expect(result.text).not.toContain('OLD CONTENT');
    expect(result.text).toContain('UNCHANGED OUTSIDE');
    const engine = await loadMuPDF();
    const edited = new engine.PDFDocument(output);
    const editedPage = edited.loadPage(0);
    const text = editedPage.toStructuredText('');
    const matches = text.search('中文', {});
    expect(matches).toHaveLength(1);
    expect(matches[0][0].every(Number.isFinite)).toBe(true);
    text.destroy(); editedPage.destroy(); edited.destroy();
  });
});
