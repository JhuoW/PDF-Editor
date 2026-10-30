import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyImageEdits } from '../../src/editing/ImageEditApplier';
import { changeImageAppearance, imageAppearance } from '../../src/editing/imageAppearance';
import type { PDFImage } from '../../src/editing/types';
import { imageCropFromTag } from '../../src/editing/ImageCropMarker';
import { imageCropUV } from '../../src/editing/imageAppearance';
import { inverseMatrix, matrixBounds, multiplyMatrix, type ImageMatrix } from '../../src/editing/imageMatrix';

async function fixture(rotated = false) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  let png: Uint8Array;
  try {
    const bytes = pixmap.getPixels(), colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bytes.set(colors[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)], (y * 8 + x) * 3);
    png = new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 600]), bitmap = await pdf.embedPng(png);
  if (rotated) { page.setCropBox(20, 30, 350, 550); page.setRotation(degrees(90)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0, 1, 1) });
  page.drawText('KEEP CONTENT', { x: 50, y: 300, size: 12 });
  page.drawImage(bitmap, { x: 50, y: 420, width: 100, height: 80 }); page.drawImage(bitmap, { x: 250, y: 420, width: 100, height: 80 });
  const rect = rotated ? { x: 60, y: 160, width: 200, height: 160 } : { x: 50, y: 100, width: 100, height: 80 };
  const image: PDFImage = { id: 'one', objectName: 'unused', pageNumber: 1, rect, originalRect: { ...rect },
    source: { transform: [100, 0, 0, 80, 50, 420], occurrence: 0, occurrenceCount: 2, insideForm: false, pixelWidth: 8, pixelHeight: 8 } };
  return { data: new Uint8Array(await pdf.save()).buffer, image };
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false), text = page.toStructuredText('');
  try { return { pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth(), text: text.asText() }; }
  finally { text.destroy(); pixmap.destroy(); page.destroy(); pdf.destroy(); }
}
const pixel = (result: ReturnType<typeof inspect>, x: number, y: number) => [...result.pixels.slice((y * result.width + x) * 3, (y * result.width + x) * 3 + 3)];
/** Inspect actual native draw matrices after applying, using MuPDF's display device. */
function redetect(data: Uint8Array): PDFImage {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), object = page.getObject(), contents = object.get('Contents');
  const read = (source: mupdf.PDFObject): string => {
    if (source.isArray()) {
      let text = ''; source.forEach(child => { try { text += read(child); } finally { child.destroy(); } }); return text;
    }
    const bytes = source.readStream(); try { return new TextDecoder().decode(bytes.asUint8Array()); } finally { bytes.destroy(); }
  };
  const tag = /\/(PDFEditorCrop1_[0-9a-z_]+)\s+BMC/.exec(read(contents))?.[1], crop = imageCropFromTag(tag);
  const inverse = inverseMatrix(page.getTransform()), nativeCrop = mupdf.Rect.transform(page.getBounds(), inverse), unit = Math.hypot(...page.getTransform().slice(0, 2));
  const viewport: ImageMatrix = [unit, 0, 0, -unit, -nativeCrop[0] * unit, nativeCrop[3] * unit];
  const draws: { matrix: ImageMatrix; width: number; height: number }[] = [];
  const device = new mupdf.Device({ fillImage(image, matrix) {
    // MuPDF image devices use top-left pixels; PDF image Do uses bottom-left UVs.
    try { draws.push({ matrix: multiplyMatrix(multiplyMatrix(inverse, matrix), [1, 0, 0, -1, 0, 1]), width: image.getWidth(), height: image.getHeight() }); } finally { image.destroy(); }
  } });
  try {
    page.runPageContents(device, mupdf.Matrix.identity); device.close();
    const draw = draws[0], rawRect = matrixBounds(multiplyMatrix(viewport, draw.matrix)), uv = crop && imageCropUV(crop);
    const rect = uv ? matrixBounds(multiplyMatrix(multiplyMatrix(viewport, draw.matrix), [uv.width, 0, 0, uv.height, uv.x, uv.y])) : rawRect;
    return { id: 'again', objectName: 'unused', pageNumber: 1, rect, originalRect: { ...rect }, source: {
      transform: draw.matrix, occurrence: 0, occurrenceCount: draws.length, insideForm: false, pixelWidth: draw.width, pixelHeight: draw.height,
      ...(crop ? { cropRect: crop, rawRect } : {}),
    } };
  } finally { device.destroy(); contents.destroy(); object.destroy(); page.destroy(); pdf.destroy(); }
}
describe('original image appearance', () => {
  it.each([['flipX', [0, 255, 0]], ['flipY', [0, 0, 255]]] as const)('mirrors %s without altering the shared second drawing', async (axis, color) => {
    const { data, image } = await fixture(), edit = changeImageAppearance(image, imageAppearance(image, []), { [axis]: true });
    const result = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [edit]));
    expect(pixel(result, 55, 105)).toEqual(color); expect(pixel(result, 255, 105)).toEqual([255, 0, 0]); expect(result.text).toContain('KEEP CONTENT');
  });
  it('rotates clockwise around the center and keeps vector text searchable', async () => {
    const { data, image } = await fixture(), edit = changeImageAppearance(image, imageAppearance(image, []), { rotation: 90 });
    expect(edit.newRect).toMatchObject({ x: 60, y: 90, width: 80, height: 100 });
    const result = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [edit]));
    expect(pixel(result, 65, 95)).toEqual([0, 0, 255]); expect(pixel(result, 135, 95)).toEqual([255, 0, 0]); expect(result.text).toContain('KEEP CONTENT');
  });
  it('clips original pixels while exposing the original page background', async () => {
    const { data, image } = await fixture(), edit = changeImageAppearance(image, imageAppearance(image, []), { crop: { x: .5, y: 0, width: .5, height: 1 } });
    expect(edit.newRect).toEqual({ x: 100, y: 100, width: 50, height: 80 });
    const result = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [edit]));
    expect(pixel(result, 55, 105)).toEqual([0, 255, 255]); expect(pixel(result, 105, 105)).toEqual([0, 255, 0]); expect(pixel(result, 105, 175)).toEqual([255, 255, 0]);
    expect(pixel(result, 255, 105)).toEqual([255, 0, 0]);
  });
  it('mirrors the displayed result after rotation rather than reflecting the old image axes', async () => {
    const { data, image } = await fixture(), rotate = changeImageAppearance(image, imageAppearance(image, []), { rotation: 90 });
    const flip = changeImageAppearance(image, imageAppearance(image, [rotate]), { flipX: true });
    const result = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [rotate, flip]));
    expect(pixel(result, 65, 95)).toEqual([255, 0, 0]); expect(pixel(result, 135, 95)).toEqual([0, 0, 255]);
    const reset = changeImageAppearance(image, imageAppearance(image, [rotate, flip]), { flipX: false });
    const restored = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [rotate, flip, reset]));
    expect(pixel(restored, 65, 95)).toEqual([0, 0, 255]);
  });
  it('preserves a crop through later movement and rotation', async () => {
    const { data, image } = await fixture(), crop = changeImageAppearance(image, imageAppearance(image, []), { crop: { x: .5, y: 0, width: .5, height: 1 } });
    const moved = { imageId: image.id, type: 'move' as const, newRect: { x: 120, y: 150, width: 50, height: 80 }, timestamp: 2 };
    const rotate = changeImageAppearance(image, imageAppearance(image, [crop, moved]), { rotation: 90 });
    const result = inspect(await applyImageEdits(data, new Map([[1, [image]]]), [crop, moved, rotate]));
    expect(pixel(result, 110, 170)).toEqual([255, 255, 0]); expect(pixel(result, 180, 170)).toEqual([0, 255, 0]);
  });
  for (const rotated of [false, true]) it(`preserves pixels through crop, flip, apply, repeated crop and full restoration on ${rotated ? 'CropBox/Rotate/UserUnit' : 'ordinary'} pages`, async () => {
    const { data, image } = await fixture(rotated);
    const rotate = changeImageAppearance(image, imageAppearance(image, []), { rotation: 90 });
    const flip = changeImageAppearance(image, imageAppearance(image, [rotate]), { flipX: true });
    const crop = changeImageAppearance(image, imageAppearance(image, [rotate, flip]), { crop: { x: .5, y: 0, width: .5, height: 1 } });
    const first = [rotate, flip, crop], applied = await applyImageEdits(data, new Map([[1, [image]]]), first), detected = redetect(applied);
    const nextRotation = changeImageAppearance(image, imageAppearance(image, first), { rotation: imageAppearance(image, first).rotation + 90 });
    const afterApplyRotation = changeImageAppearance(detected, imageAppearance(detected, []), { rotation: 90 });
    const expected = await applyImageEdits(data, new Map([[1, [image]]]), [...first, nextRotation]);
    const actual = await applyImageEdits(new Uint8Array(applied).buffer, new Map([[1, [detected]]]), [afterApplyRotation]);
    expect(Buffer.from(inspect(actual).pixels).equals(Buffer.from(inspect(expected).pixels))).toBe(true);
    const recrop = { x: .25, y: .25, width: .5, height: .5 };
    const second = changeImageAppearance(image, imageAppearance(image, [...first, nextRotation]), { crop: recrop });
    const afterApplyCrop = changeImageAppearance(detected, imageAppearance(detected, [afterApplyRotation]), { crop: recrop });
    const expectedCrop = await applyImageEdits(data, new Map([[1, [image]]]), [...first, nextRotation, second]);
    const actualCrop = await applyImageEdits(new Uint8Array(applied).buffer, new Map([[1, [detected]]]), [afterApplyRotation, afterApplyCrop]);
    expect(Buffer.from(inspect(actualCrop).pixels).equals(Buffer.from(inspect(expectedCrop).pixels))).toBe(true);
    const full = { x: 0, y: 0, width: 1, height: 1 };
    const restored = changeImageAppearance(image, imageAppearance(image, [...first, nextRotation, second]), { crop: full });
    const afterApplyRestored = changeImageAppearance(detected, imageAppearance(detected, [afterApplyRotation, afterApplyCrop]), { crop: full });
    const expectedFull = await applyImageEdits(data, new Map([[1, [image]]]), [...first, nextRotation, second, restored]);
    const actualFull = await applyImageEdits(new Uint8Array(applied).buffer, new Map([[1, [detected]]]), [afterApplyRotation, afterApplyCrop, afterApplyRestored]);
    expect(Buffer.from(inspect(actualFull).pixels).equals(Buffer.from(inspect(expectedFull).pixels))).toBe(true);
  });
});
