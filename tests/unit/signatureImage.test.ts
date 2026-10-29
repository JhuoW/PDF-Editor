import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createDrawnSignature, paintSignature, readSignatureImage, SIGNATURE_LIMITS, type SignatureStroke } from '../../src/components/Dialogs/signatureImage';
import { createImageAnnotation } from '../../src/store/annotationStore';
import { serializeAnnotationsToPDF } from '../../src/annotations/AnnotationSerializer';

const strokes: SignatureStroke[] = [{ points: [{ x: 20, y: 40 }, { x: 100, y: 60 }, { x: 120, y: 40 }], color: '#174ea6', width: 3 }];
const decoder = vi.fn();
beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => { if (tag !== 'canvas') throw new Error('Unexpected element'); return createCanvas(1, 1); } });
  decoder.mockReset().mockImplementation(async (blob: Blob) => {
    const image = await loadImage(new Uint8Array(await blob.arrayBuffer()));
    Object.assign(image, { close: vi.fn() }); return image;
  });
  vi.stubGlobal('createImageBitmap', decoder);
});
afterEach(() => { vi.unstubAllGlobals(); });
const uploaded = (data: Uint8Array, name = 'sample.png') => new File([new Uint8Array(data)], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' });
function bitmap(white = false) {
  const canvas = createCanvas(80, 40), context = canvas.getContext('2d');
  if (white) { context.fillStyle = '#fff'; context.fillRect(0, 0, 80, 40); }
  context.strokeStyle = '#111'; context.lineWidth = 3; context.beginPath(); context.moveTo(12, 12); context.lineTo(65, 28); context.stroke();
  return canvas;
}

describe('signature image preparation', () => {
  it('crops unused drawing space, preserves transparent pixels and exports visible ink without a digital signature field', async () => {
    const image = createDrawnSignature(strokes);
    expect(image.originalWidth).toBe(232); expect(image.originalHeight).toBe(72); expect(image.mimeType).toBe('image/png');
    const decoded = await loadImage(image.imageData), canvas = createCanvas(decoded.width, decoded.height), context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0);
    expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    expect([...context.getImageData(0, 0, canvas.width, canvas.height).data].filter((value, index) => index % 4 === 3 && value > 0).length).toBeGreaterThan(500);
    const source = await PDFDocument.create(), page = source.addPage([200, 100]); page.drawRectangle({ x: 0, y: 0, width: 200, height: 100, color: rgb(0, 1, 0) });
    const annotation = createImageAnnotation(1, [30, 30, 116, 36], image.imageData, image.originalWidth, image.originalHeight, { mimeType: image.mimeType });
    const result = await serializeAnnotationsToPDF(new Uint8Array(await source.save()).buffer, new Map([[1, [annotation]]]));
    const pdf = await PDFDocument.load(result); expect(pdf.getForm().getFields()).toHaveLength(0);
    const native = new mupdf.PDFDocument(result), nativePage = native.loadPage(0), pixels = nativePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const data = pixels.getPixels(), at = (x: number, y: number) => [...data.slice((y * 200 + x) * 3, (y * 200 + x) * 3 + 3)];
      expect(at(31, 35)).toEqual([0, 255, 0]);
      let blue = 0; for (let index = 0; index < data.length; index += 3) if (data[index] < 50 && data[index + 1] < 120 && data[index + 2] > 120) blue++;
      expect(blue).toBeGreaterThan(150);
    } finally { pixels.destroy(); nativePage.destroy(); native.destroy(); }
  });
  it('keeps dots and distinct pen colors without filling unused canvas space', () => {
    const canvas = createCanvas(50, 40), context = canvas.getContext('2d');
    paintSignature(context as unknown as CanvasRenderingContext2D, [{ color: '#ff0000', width: 5, points: [{ x: 10, y: 10 }] }, { color: '#0000ff', width: 3, points: [{ x: 25, y: 10 }, { x: 35, y: 20 }] }]);
    expect([...context.getImageData(10, 10, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(30, 15, 1, 1).data]).toEqual([0, 0, 255, 255]);
    expect(context.getImageData(45, 35, 1, 1).data[3]).toBe(0);
  });
  it('rejects empty, excessive, nonfinite or invalid drawing inputs', () => {
    expect(() => createDrawnSignature([])).toThrow(/Draw/);
    for (const stroke of [{ ...strokes[0], points: [{ x: NaN, y: 1 }] }, { ...strokes[0], color: 'red' }, { ...strokes[0], width: 0 }, { ...strokes[0], points: [{ x: 801, y: 1 }] }, { ...strokes[0], points: Array.from({ length: SIGNATURE_LIMITS.points + 1 }, () => ({ x: 1, y: 1 })) }]) expect(() => createDrawnSignature([stroke])).toThrow(/invalid|detailed/);
  });
  it('keeps uploaded PNG alpha, optionally removes white, and normalizes output as PNG', async () => {
    const input = uploaded(bitmap().toBuffer('image/png')), signal = new AbortController().signal;
    const result = await readSignatureImage(input, false, signal); expect(result.originalWidth).toBe(80); expect(result.originalHeight).toBe(40);
    const decoded = await loadImage(result.imageData), output = createCanvas(80, 40), context = output.getContext('2d'); context.drawImage(decoded, 0, 0); expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
    const white = uploaded(bitmap(true).toBuffer('image/jpeg'), 'signature.jpg');
    const kept = await readSignatureImage(white, false, signal), erased = await readSignatureImage(white, true, signal);
    for (const [value, expectedAlpha] of [[kept, 255], [erased, 0]] as const) { context.clearRect(0, 0, 80, 40); context.drawImage(await loadImage(value.imageData), 0, 0); expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(expectedAlpha); }
    expect(decoder).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' });
    expect(erased.filename).toBe('signature-signature.png');
  });
  it('validates dimensions and size before decoding, rejects nonimages and fully transparent output', async () => {
    const signal = new AbortController().signal;
    await expect(readSignatureImage(uploaded(new Uint8Array([1, 2, 3])), false, signal)).rejects.toThrow(/PNG|JPEG/);
    await expect(readSignatureImage(uploaded(new Uint8Array(SIGNATURE_LIMITS.bytes + 1)), false, signal)).rejects.toThrow(/5 MB/);
    const oversized = new Uint8Array(bitmap().toBuffer('image/png')); new DataView(oversized.buffer).setUint32(16, 8193);
    await expect(readSignatureImage(uploaded(oversized), false, signal)).rejects.toThrow(/8,192/); expect(decoder).not.toHaveBeenCalled();
    const empty = createCanvas(40, 20); await expect(readSignatureImage(uploaded(empty.toBuffer('image/png')), false, signal)).rejects.toThrow(/no visible/);
    const context = empty.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 40, 20);
    await expect(readSignatureImage(uploaded(empty.toBuffer('image/png')), true, signal)).rejects.toThrow(/no visible/);
  });
  it('closes a decoded image after cancellation and never returns obsolete data', async () => {
    const controller = new AbortController(); let resolve!: (value: unknown) => void;
    decoder.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = readSignatureImage(uploaded(bitmap().toBuffer('image/png')), false, controller.signal);
    await vi.waitFor(() => expect(decoder).toHaveBeenCalled()); const close = vi.fn(); controller.abort(); resolve({ width: 80, height: 40, close });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(close).toHaveBeenCalledTimes(1);
  });
});
