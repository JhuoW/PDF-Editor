import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyImageEdits } from '../../src/editing/ImageEditApplier';
import type { PDFImage, ImageEditOperation } from '../../src/editing/types';
import { matrixBounds, multiplyMatrix, type ImageMatrix } from '../../src/editing/imageMatrix';

function png(color: [number, number, number]) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
  try {
    const pixels = pixmap.getPixels();
    for (let index = 0; index < pixels.length; index += 3) pixels.set(color, index);
    return new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
const red = png([255, 0, 0]);
const blue = png([0, 0, 255]);
function image(matrix: ImageMatrix, occurrence = 0, pageNumber = 1, viewport: ImageMatrix = [1, 0, 0, -1, 0, 600], insideForm = false): PDFImage {
  const rect = matrixBounds(multiplyMatrix(viewport, matrix));
  return { id: `image-${pageNumber}-${occurrence}`, pageNumber, objectName: 'irrelevant-pdfjs-name', rect, originalRect: { ...rect },
    source: { transform: matrix, occurrence, occurrenceCount: 2, pixelWidth: 4, pixelHeight: 4, insideForm } };
}
async function fixture(rotation = 0, crop = false) {
  const document = await PDFDocument.create();
  const embedded = await document.embedPng(red);
  const page = document.addPage([400, 600]);
  if (crop) { page.setCropBox(20, 30, 350, 550); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  page.setRotation(degrees(rotation));
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0, 1, 1) });
  page.drawText('UNDER_IMAGE', { x: 40, y: 500, size: 10 });
  page.drawText('UNCHANGED_TEXT', { x: 40, y: 300, size: 10 });
  page.drawImage(embedded, { x: 40, y: 480, width: 50, height: 50 });
  page.drawImage(embedded, { x: 200, y: 480, width: 50, height: 50 });
  const second = document.addPage([400, 600]);
  second.drawImage(embedded, { x: 40, y: 480, width: 50, height: 50 });
  const viewport: ImageMatrix = crop ? [2, 0, 0, -2, -40, 1160] : [1, 0, 0, -1, 0, 600];
  return { data: new Uint8Array(await document.save()).buffer, images: new Map([[1, [image([50, 0, 0, 50, 40, 480], 0, 1, viewport), image([50, 0, 0, 50, 200, 480], 1, 1, viewport)]]]) };
}
function inspect(data: Uint8Array | ArrayBuffer, pageNumber = 1) {
  const document = new mupdf.PDFDocument(data);
  const page = document.loadPage(pageNumber - 1);
  const text = page.toStructuredText('preserve-images');
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    let count = 0;
    text.walk({ onImageBlock() { count++; } });
    return { count, text: text.asText(), pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth() };
  } finally { pixmap.destroy(); text.destroy(); page.destroy(); document.destroy(); }
}
// Copy pixels before destroying native memory in the helper above.
function pixel(result: ReturnType<typeof inspect>, x: number, y: number) { return Array.from(result.pixels.slice((y * result.width + x) * 3, (y * result.width + x) * 3 + 3)); }
const operation = (type: ImageEditOperation['type'], overrides: Partial<ImageEditOperation> = {}): ImageEditOperation => ({ imageId: 'image-1-0', type, timestamp: 1, ...overrides });

describe('applyImageEdits', () => {
  it('deletes exactly one shared image draw while preserving background, text, and other pages', async () => {
    const { data, images } = await fixture();
    const output = await applyImageEdits(data, images, [operation('delete')]);
    const result = inspect(output);
    expect(result.count).toBe(1);
    expect(result.text).toContain('UNDER_IMAGE');
    expect(result.text).toContain('UNCHANGED_TEXT');
    expect(pixel(result, 50, 80)).toEqual([0, 255, 255]);
    expect(pixel(result, 210, 80)).toEqual([255, 0, 0]);
    expect(inspect(output, 2).count).toBe(1);
    expect(pixel(inspect(output, 2), 50, 80)).toEqual([255, 0, 0]);
    expect(inspect(data).count).toBe(2);
  });
  it('replaces one occurrence without replacing a shared XObject globally', async () => {
    const { data, images } = await fixture();
    const output = await applyImageEdits(data, images, [operation('replace', { newImageData: blue.buffer })]);
    const result = inspect(output);
    expect(result.count).toBe(2);
    expect(pixel(result, 50, 80)).toEqual([0, 0, 255]);
    expect(pixel(result, 210, 80)).toEqual([255, 0, 0]);
    expect(result.text).toContain('UNDER_IMAGE');
    expect(pixel(inspect(output, 2), 50, 80)).toEqual([255, 0, 0]);
  });
  it.each([0, 90, 180, 270])('moves and resizes content with CropBox, UserUnit=2 and Rotate=%i', async rotation => {
    const { data, images } = await fixture(rotation, true);
    const output = await applyImageEdits(data, images, [operation('resize', { newRect: { x: 100, y: 300, width: 160, height: 80 } })]);
    const document = new mupdf.PDFDocument(output);
    const page = document.loadPage(0);
    const text = page.toStructuredText('preserve-images');
    try {
      const bounds: mupdf.Rect[] = [];
      text.walk({ onImageBlock(bbox) { bounds.push(bbox); } });
      const expected = mupdf.Rect.transform([70, 390, 150, 430], page.getTransform());
      expect(bounds[0]).toEqual(expected);
      expect(text.asText()).toContain('UNDER_IMAGE');
    } finally { text.destroy(); page.destroy(); document.destroy(); }
  });
  it('clones a shared Form invocation, retaining its text and the other invocation', async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([100, 100]);
    sourcePage.drawText('FORM_TEXT', { x: 10, y: 10, size: 8 });
    sourcePage.drawImage(await source.embedPng(red), { x: 10, y: 10, width: 30, height: 30 });
    const document = await PDFDocument.create();
    const [form] = await document.embedPdf(await source.save(), [0]);
    const page = document.addPage([400, 600]);
    page.drawPage(form, { x: 20, y: 400, width: 100, height: 100 });
    page.drawPage(form, { x: 200, y: 400, width: 100, height: 100 });
    const images = new Map([[1, [image([30, 0, 0, 30, 30, 410], 0, 1, undefined, true)]]]);
    const data = new Uint8Array(await document.save()).buffer;
    const output = await applyImageEdits(data, images, [operation('delete')]);
    expect(inspect(output).count).toBe(1);
    expect(inspect(output).text.match(/FORM_TEXT/g)).toHaveLength(2);
    expect(pixel(inspect(output), 220, 170)).toEqual([255, 0, 0]);
    await expect(applyImageEdits(data, images, [operation('move', { newRect: { x: 100, y: 100, width: 30, height: 30 } })])).rejects.toThrow('Form XObjects');
  });
  it('preserves occurrence identity after pages are copied and object numbers change', async () => {
    const { data, images } = await fixture();
    const source = await PDFDocument.load(data), target = await PDFDocument.create();
    target.addPage([400, 600]);
    target.addPage((await target.copyPages(source, [0]))[0]);
    const selected = { ...images.get(1)![0], pageNumber: 2 };
    const output = await applyImageEdits(new Uint8Array(await target.save()).buffer, new Map([[2, [selected]]]), [operation('delete')]);
    expect(inspect(output, 2).count).toBe(1);
  });
  it('handles escaped names and ignores operator-like bytes in strings, comments, and dictionaries', async () => {
    const document = new mupdf.PDFDocument();
    const bitmap = new mupdf.Image(red);
    const imageObject = document.addImage(bitmap);
    const font = new mupdf.Font('Helvetica');
    const fontObject = document.addSimpleFont(font);
    const page = document.addPage([0, 0, 400, 600], 0, { XObject: { 'Image name': imageObject }, Font: { F1: fontObject } },
      'BT /F1 12 Tf 20 300 Td (Keep \\(escaped\\) Do cm BI) Tj ET\n' +
      '% /Image#20name Do\n/Span << /Nested [1 (Do BI) << /Key <4249> % comment\n >> ] >> BDC EMC\n' +
      'q 50 0 0 50 40 480 cm /Image#20name Do Q\n');
    document.insertPage(-1, page);
    const buffer = document.saveToBuffer('garbage=1');
    let input: ArrayBuffer;
    try { input = new Uint8Array(buffer.asUint8Array()).buffer; }
    finally { buffer.destroy(); page.destroy(); fontObject.destroy(); font.destroy(); imageObject.destroy(); bitmap.destroy(); document.destroy(); }
    const selected = image([50, 0, 0, 50, 40, 480]);
    selected.source!.occurrenceCount = 1;
    const output = await applyImageEdits(input, new Map([[1, [selected]]]), [operation('delete')]);
    expect(inspect(output).count).toBe(0);
    expect(inspect(output).text).toContain('Keep (escaped) Do cm BI');
    const result = new mupdf.PDFDocument(output);
    try {
      let imageCount = 0;
      for (let index = 1; index < result.countObjects(); index++) {
        const object = result.newIndirect(index), subtype = object.get('Subtype');
        try { if (subtype.asName() === 'Image') imageCount++; }
        finally { subtype.destroy(); object.destroy(); }
      }
      expect(imageCount).toBe(0);
    } finally { result.destroy(); }
  });
  it('refuses inline image data before parsing binary bytes as content operators', async () => {
    const { data, images } = await fixture();
    const document = new mupdf.PDFDocument(data), page = document.findPage(0), contents = page.get('Contents');
    const inline = document.addStream('q BI /W 1 /H 1 /BPC 8 /CS /RGB ID\nABC\nEI Q\n', {});
    const streams = document.newArray();
    if (contents.isArray()) contents.forEach(value => { streams.push(value); value.destroy(); });
    else streams.push(contents);
    streams.push(inline);
    page.put('Contents', streams);
    const buffer = document.saveToBuffer('garbage=1');
    let input: ArrayBuffer;
    try { input = new Uint8Array(buffer.asUint8Array()).buffer; }
    finally { buffer.destroy(); streams.destroy(); inline.destroy(); contents.destroy(); page.destroy(); document.destroy(); }
    await expect(applyImageEdits(input, images, [operation('delete')])).rejects.toThrow('inline images');
    expect(inspect(data).count).toBe(2);
  });
  it('retains graphics state across a Contents array with q and Q in separate streams', async () => {
    const { data, images } = await fixture();
    const document = new mupdf.PDFDocument(data), page = document.findPage(0), contents = page.get('Contents');
    const before = document.addStream('q\n', {}), after = document.addStream('Q\n', {}), streams = document.newArray();
    streams.push(before);
    if (contents.isArray()) contents.forEach(value => { streams.push(value); value.destroy(); });
    else streams.push(contents);
    streams.push(after);
    page.put('Contents', streams);
    const buffer = document.saveToBuffer('garbage=1');
    let input: ArrayBuffer;
    try { input = new Uint8Array(buffer.asUint8Array()).buffer; }
    finally { buffer.destroy(); streams.destroy(); before.destroy(); after.destroy(); contents.destroy(); page.destroy(); document.destroy(); }
    const output = await applyImageEdits(input, images, [operation('delete')]);
    expect(inspect(output).count).toBe(1);
    expect(inspect(output).text).toContain('UNDER_IMAGE');
  });
  it('fails closed for stale identities, legacy records, invalid crops, and corrupt replacements', async () => {
    const { data, images } = await fixture();
    await expect(applyImageEdits(data, images, [operation('crop')])).rejects.toThrow('crop');
    await expect(applyImageEdits(data, images, [operation('replace', { newImageData: new Uint8Array([1, 2]).buffer })])).rejects.toThrow();
    images.get(1)![0].source!.occurrenceCount = 1;
    await expect(applyImageEdits(data, images, [operation('delete')])).rejects.toThrow('image count');
    images.get(1)![0].source!.occurrenceCount = 2;
    images.get(1)![0].source!.transform[4] += 10;
    await expect(applyImageEdits(data, images, [operation('delete')])).rejects.toThrow('transform');
    delete images.get(1)![0].source;
    await expect(applyImageEdits(data, images, [operation('delete')])).rejects.toThrow('source information');
  });
});
