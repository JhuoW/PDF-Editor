import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createPDFFromImages, inspectPDFImage, validateImageCollection } from '../../src/core/ImagePDF';

function bitmap(width: number, height: number, color: number[], jpeg = false) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  try {
    const pixels = pixmap.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
    return new Uint8Array(jpeg ? pixmap.asJPEG(95) : pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
const red = bitmap(80, 40, [255, 0, 0]), green = bitmap(60, 30, [0, 255, 0], true);
const imageOptions = { pageSize: 'image' as const, orientation: 'portrait' as const, margin: 0 };
function pixels(data: Uint8Array, index = 0) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(index);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return { width: pixmap.getWidth(), data: new Uint8Array(pixmap.getPixels()) }; }
  finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}
function sample(render: ReturnType<typeof pixels>, x: number, y: number) { return [...render.data.slice((y * render.width + x) * 3, (y * render.width + x) * 3 + 3)]; }

describe('images to PDF', () => {
  it('creates ordered PNG/JPEG pages at image dimensions and preserves pixels and margins', async () => {
    const progress: number[] = [];
    const result = await createPDFFromImages([{ name: 'green.jpg', data: green }, { name: 'red.png', data: red }],
      { ...imageOptions, margin: 12, onProgress: completed => progress.push(completed) });
    const document = await PDFDocument.load(result);
    expect(document.getPages().map(page => page.getSize())).toEqual([{ width: 84, height: 54 }, { width: 104, height: 64 }]);
    expect(sample(pixels(result), 2, 2)).toEqual([255, 255, 255]);
    const center = sample(pixels(result), 40, 20);
    expect(center[1]).toBeGreaterThan(240); expect(center[0]).toBeLessThan(10);
    expect(sample(pixels(result, 1), 40, 20)).toEqual([255, 0, 0]);
    expect(progress).toEqual([0, 1, 2]);
  });

  it.each(['a4', 'letter'] as const)('fits images on landscape %s paper without stretching or clipping', async pageSize => {
    const result = await createPDFFromImages([{ name: 'red.png', data: red }], { pageSize, orientation: 'landscape', margin: 36 });
    const pdf = await PDFDocument.load(result), size = pdf.getPage(0).getSize();
    expect(size.width).toBeCloseTo(pageSize === 'a4' ? 841.8898 : 792);
    expect(size.height).toBeCloseTo(pageSize === 'a4' ? 595.2756 : 612);
    const document = new mupdf.PDFDocument(result), page = document.loadPage(0), text = page.toStructuredText('preserve-images');
    const boxes: number[][] = [];
    try { text.walk({ onImageBlock(bounds) { boxes.push(bounds); } }); }
    finally { text.destroy(); page.destroy(); document.destroy(); }
    expect(boxes).toHaveLength(1);
    expect((boxes[0][2] - boxes[0][0]) / (boxes[0][3] - boxes[0][1])).toBeCloseTo(2);
    expect(boxes[0][0]).toBeCloseTo(36);
    expect(boxes[0][2]).toBeCloseTo(size.width - 36, 3);
  });

  it.each(['Exif only', 'Exif before XMP', 'Exif after XMP'])('honors JPEG EXIF rotation (%s) without changing the original image bytes', async order => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
    let jpg: Uint8Array;
    try {
      const samples = pixmap.getPixels();
      for (let offset = 0; offset < samples.length; offset += 3) samples.set((offset / 3) % 40 < 20 ? [255, 0, 0] : [0, 0, 255], offset);
      jpg = new Uint8Array(pixmap.asJPEG(100));
    } finally { pixmap.destroy(); }
    const app1 = new Uint8Array(36), view = new DataView(app1.buffer);
    app1.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0]);
    view.setUint16(18, 1, true); view.setUint16(20, 0x112, true); view.setUint16(22, 3, true); view.setUint32(24, 1, true); view.setUint16(28, 6, true);
    const xmpData = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>');
    const xmp = new Uint8Array(xmpData.length + 4); xmp.set([255, 225]); new DataView(xmp.buffer).setUint16(2, xmpData.length + 2); xmp.set(xmpData, 4);
    const segments = order === 'Exif only' ? [app1] : order === 'Exif before XMP' ? [app1, xmp] : [xmp, app1];
    const rotated = new Uint8Array(jpg.length + segments.reduce((sum, segment) => sum + segment.length, 0));
    rotated.set(jpg.subarray(0, 2)); let offset = 2;
    for (const segment of segments) { rotated.set(segment, offset); offset += segment.length; }
    rotated.set(jpg.subarray(2), offset);
    expect(inspectPDFImage({ name: 'camera.jpg', data: rotated })).toMatchObject({ width: 40, height: 20, orientation: 6 });
    const before = rotated.slice();
    const result = await createPDFFromImages([{ name: 'camera.jpg', data: rotated }], imageOptions);
    expect((await PDFDocument.load(result)).getPage(0).getSize()).toEqual({ width: 20, height: 40 });
    const output = pixels(result);
    expect(sample(output, 10, 5)[0]).toBeGreaterThan(240);
    expect(sample(output, 10, 35)[2]).toBeGreaterThan(240);
    expect(rotated).toEqual(before);
  });

  it('rejects unsupported, truncated, oversized, or over-budget selections atomically', async () => {
    const invalid = [{ name: 'red.png', data: red }, { name: 'unsupported.webp', data: new TextEncoder().encode('RIFF WEBP') }];
    await expect(createPDFFromImages(invalid, imageOptions)).rejects.toThrow('only still PNG and JPEG');
    expect(() => inspectPDFImage({ name: 'truncated.jpg', data: green.subarray(0, green.length - 2) })).toThrow('incomplete');
    expect(() => inspectPDFImage({ name: 'truncated.png', data: red.subarray(0, red.length - 12) })).toThrow('incomplete');
    const enormous = red.slice(); new DataView(enormous.buffer).setUint32(16, 100_000);
    expect(() => inspectPDFImage({ name: 'huge.png', data: enormous })).toThrow('40 megapixels');
    const fortyMP = red.slice(); new DataView(fortyMP.buffer).setUint32(16, 8000); new DataView(fortyMP.buffer).setUint32(20, 5000);
    expect(() => validateImageCollection(Array.from({ length: 3 }, () => ({ name: 'large.png', data: fortyMP })))).toThrow('80 megapixel');
    await expect(createPDFFromImages([{ name: 'red.png', data: red }], { ...imageOptions, margin: -1 })).rejects.toThrow('margin');
  });

  it('rejects empty JPEG scans and cannot mistake a metadata EOI for the real file ending', async () => {
    const scanStart = green.findIndex((byte, index) => byte === 255 && green[index + 1] === 218);
    const entropyStart = scanStart + 2 + new DataView(green.buffer, green.byteOffset).getUint16(scanStart + 2);
    const empty = new Uint8Array(entropyStart + 2); empty.set(green.subarray(0, entropyStart)); empty.set([255, 217], entropyStart);
    expect(() => inspectPDFImage({ name: 'empty.jpg', data: empty })).toThrow('no encoded image data');
    await expect(createPDFFromImages([{ name: 'valid.png', data: red }, { name: 'empty.jpg', data: empty }], imageOptions)).rejects.toThrow('no encoded image data');
    const metadata = new Uint8Array([255, 225, 0, 4, 255, 217]);
    const missingEnd = new Uint8Array(green.length - 2 + metadata.length);
    missingEnd.set(green.subarray(0, 2)); missingEnd.set(metadata, 2); missingEnd.set(green.subarray(2, green.length - 2), 2 + metadata.length);
    expect(() => inspectPDFImage({ name: 'false-end.jpg', data: missingEnd })).toThrow('incomplete');
  });

  it('cancels between images without returning a partial PDF', async () => {
    const controller = new AbortController(), progress: number[] = [];
    await expect(createPDFFromImages([{ name: 'red.png', data: red }, { name: 'green.jpg', data: green }], {
      ...imageOptions, signal: controller.signal, onProgress: value => { progress.push(value); if (value === 1) controller.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([0, 1]);
  });
});
