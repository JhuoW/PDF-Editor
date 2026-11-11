import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyImageEdits } from '../../src/editing/ImageEditApplier';
import type { PDFImage, ImageEditOperation } from '../../src/editing/types';
import { changeImageAppearance, imageAppearance } from '../../src/editing/imageAppearance';
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


async function formStateFixture(options: { opacity?: number; overlap?: boolean; nested?: boolean; clip?: boolean; outsidePaint?: boolean; blend?: boolean; formMatrix?: ImageMatrix } = {}) {
  const document = new mupdf.PDFDocument(), bitmap = new mupdf.Image(red), font = new mupdf.Font('Helvetica');
  const imageObject = document.addImage(bitmap), fontObject = document.addSimpleFont(font);
  const state = { Type: 'ExtGState', ca: options.opacity ?? 1, ...(options.blend ? { BM: 'Multiply' } : {}) };
  const content = 'BT /F1 8 Tf 2 80 Td (BEFORE_IMAGE) Tj ET\n' +
    `q ${options.clip ? '10 10 20 30 re W n' : ''} /G1 gs 30 0 0 30 10 10 cm /Im Do Q\n` +
    (options.overlap ? '0 1 0 rg 15 15 20 20 re f\n' : '') +
    (options.outsidePaint ? '0 1 0 rg 110 10 40 30 re f\n' : '') +
    'BT /F1 8 Tf 2 65 Td (AFTER_IMAGE) Tj ET\n';
  const inner = document.addStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100],
    Resources: { XObject: { Im: imageObject }, Font: { F1: fontObject }, ExtGState: { G1: state } }, ...(options.formMatrix ? { Matrix: options.formMatrix } : {}) });
  const form = options.nested ? document.addStream('q 1 0 0 1 5 5 cm /Inner Do Q\n', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { XObject: { Inner: inner } },
  }) : inner;
  const page = document.addPage([0, 0, 400, 600], 0, { XObject: { Form: form } },
    (options.blend ? '0 1 1 rg 0 0 400 600 re f\n' : '') + 'q 1 0 0 1 20 400 cm /Form Do Q\nq 1 0 0 1 200 400 cm /Form Do Q');
  document.insertPage(-1, page);
  const buffer = document.saveToBuffer('garbage=1');
  const data = new Uint8Array(buffer.asUint8Array()).buffer;
  buffer.destroy(); page.destroy(); if (form !== inner) form.destroy(); inner.destroy(); imageObject.destroy(); fontObject.destroy(); bitmap.destroy(); font.destroy(); document.destroy();
  const delta = options.nested ? 5 : 0;
  const selected = image(multiplyMatrix([1, 0, 0, 1, 20 + delta, 400 + delta], multiplyMatrix(options.formMatrix ?? [1, 0, 0, 1, 0, 0], [30, 0, 0, 30, 10, 10])), 0, 1, undefined, true);
  return { data, selected, images: new Map([[1, [selected]]]) };
}

describe('applyImageEdits', () => {

  it.each([
    [1, .2, .3, 1, 0, 0], [0, 1, -1, 0, 100, 0], [1.3, 0, 0, .7, 0, 0],
  ] as ImageMatrix[])('preserves nested Form Matrix %j and image opacity beyond its bounds', async (...formMatrix) => {
    const { data, selected, images } = await formStateFixture({ opacity: .25, nested: true, formMatrix: formMatrix as ImageMatrix });
    const output = inspect(await applyImageEdits(data, images, [operation('move', { newRect: { ...selected.rect, x: selected.rect.x + 130 } })]));
    const x = Math.round(selected.rect.x + selected.rect.width / 2), y = Math.round(selected.rect.y + selected.rect.height / 2);
    expect(pixel(output, x + 130, y)).toEqual([255, 192, 192]);
    expect(pixel(output, x + 180, y)).toEqual(pixel(inspect(data), x + 180, y));
    expect(output.text.match(/BEFORE_IMAGE/g)).toHaveLength(2);
  });
  it('retains a Form image crop and opacity when the cropped image leaves the original Form bounds', async () => {
    const { data, selected, images } = await formStateFixture({ opacity: .25, overlap: true });
    const crop = changeImageAppearance(selected, imageAppearance(selected, []), { crop: { x: .5, y: 0, width: .5, height: 1 } });
    const cropped = inspect(await applyImageEdits(data, images, [crop]));
    expect(pixel(cropped, 40, 188)).toEqual([255, 255, 255]);
    expect(pixel(cropped, 50, 188)).toEqual([255, 192, 192]);
    const moved = inspect(await applyImageEdits(data, images, [crop, operation('move', { newRect: { ...crop.newRect!, x: 145 } })]));
    expect(pixel(moved, 150, 188)).toEqual([255, 192, 192]);
    expect(pixel(moved, 135, 188)).toEqual([255, 255, 255]);
    expect(pixel(moved, 45, 170)).toEqual([0, 255, 0]);
  });

  it.each([false, true])('preserves Form opacity, stacking, text and shared uses (nested=%s)', async nested => {
    for (const overlap of [false, true]) {
      const { data, selected, images } = await formStateFixture({ opacity: .25, overlap, nested });
      const output = await applyImageEdits(data, images, [operation('move', { newRect: { ...selected.rect, x: selected.rect.x + 10 } })]);
      const before = inspect(data), after = inspect(output), delta = nested ? 5 : 0;
      expect(pixel(after, 45 + delta, 170 - delta)).toEqual(overlap ? [0, 255, 0] : [255, 192, 192]);
      expect(pixel(after, 220 + delta, 170 - delta)).toEqual(pixel(before, 220 + delta, 170 - delta));
      expect(after.count).toBe(before.count);
      expect(after.text.match(/BEFORE_IMAGE/g)).toHaveLength(2);
      expect(after.text.match(/AFTER_IMAGE/g)).toHaveLength(2);
    }
  });
  it.each([false, true])('expands only the moved image clipping box and leaves other artwork clipped (nested=%s)', async nested => {
    const { data, selected, images } = await formStateFixture({ opacity: .25, outsidePaint: true, nested });
    const output = await applyImageEdits(data, images, [operation('move', { newRect: { ...selected.rect, x: 130 } })]);
    const result = inspect(output), delta = nested ? 5 : 0;
    // This region used to be outside both Form bounding boxes. The invisible
    // green path must stay clipped when the image is moved into that region.
    expect(pixel(result, 140, 170 - delta)).toEqual([255, 192, 192]);
    expect(pixel(result, 165, 170 - delta)).toEqual([255, 255, 255]);
    expect(result.text.match(/BEFORE_IMAGE/g)).toHaveLength(2);
    expect(result.text.match(/AFTER_IMAGE/g)).toHaveLength(2);
  });
  it('preserves Form blend modes and explicit clipping paths while resizing an image', async () => {
    const { data, selected, images } = await formStateFixture({ blend: true, clip: true });
    const output = await applyImageEdits(data, images, [operation('resize', { newRect: { ...selected.rect, width: 60 } })]);
    const result = inspect(output);
    expect(pixel(result, 40, 170)).toEqual([0, 0, 0]); // red multiplied by cyan
    expect(pixel(result, 55, 170)).toEqual([0, 255, 255]); // explicit 20pt clip remains
    expect(pixel(result, 225, 170)).toEqual(pixel(inspect(data), 225, 170));
  });
  it('keeps Form opacity and order through rotation, replacement, and deletion', async () => {
    const { data, images } = await formStateFixture({ opacity: .25, overlap: true, nested: true });
    const transformed = await applyImageEdits(data, images, [operation('replace', { newImageData: blue.buffer }), operation('rotate', { rotation: 180, flipX: true })]);
    const result = inspect(transformed);
    expect(pixel(result, 37, 180)).toEqual([192, 192, 255]);
    expect(pixel(result, 50, 165)).toEqual([0, 255, 0]);
    expect(result.text.match(/AFTER_IMAGE/g)).toHaveLength(2);
    const deleted = inspect(await applyImageEdits(data, images, [operation('delete')]));
    expect(pixel(deleted, 37, 180)).toEqual([255, 255, 255]);
    expect(pixel(deleted, 50, 165)).toEqual([0, 255, 0]);
  });

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
  });
  it('lifts a moved image out of its shared Form, keeping the other invocation and the text', async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([100, 100]);
    sourcePage.drawText('FORM_TEXT', { x: 10, y: 80, size: 8 });
    sourcePage.drawImage(await source.embedPng(red), { x: 10, y: 10, width: 30, height: 30 });
    const document = await PDFDocument.create();
    const [form] = await document.embedPdf(await source.save(), [0]);
    const page = document.addPage([400, 600]);
    page.drawPage(form, { x: 20, y: 400, width: 100, height: 100 });
    page.drawPage(form, { x: 200, y: 400, width: 100, height: 100 });
    const images = new Map([[1, [image([30, 0, 0, 30, 30, 410], 0, 1, undefined, true)]]]);
    const output = await applyImageEdits(new Uint8Array(await document.save()).buffer, images, [operation('move', { newRect: { x: 100, y: 300, width: 30, height: 30 } })]);
    const result = inspect(output);
    expect(result.count).toBe(2);
    expect(result.text.match(/FORM_TEXT/g)).toHaveLength(2);
    expect(pixel(result, 115, 315)).toEqual([255, 0, 0]); // moved outside the Form's own box
    expect(pixel(result, 40, 170)).toEqual([255, 255, 255]); // gone from its old place
    expect(pixel(result, 220, 170)).toEqual([255, 0, 0]); // the other invocation is untouched
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
