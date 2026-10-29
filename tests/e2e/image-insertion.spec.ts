import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
function outputImage(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), text = page.toStructuredText('preserve-images'), areas: number[][] = [];
  try {
    text.walk({ onImageBlock(rect) { areas.push([...rect]); } });
    const bitmap = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
    try { const pixels = new Uint8Array(bitmap.getPixels()), width = bitmap.getWidth(); return { areas, sample: (x: number, y: number) => Array.from(pixels.slice((Math.floor(y) * width + Math.floor(x)) * 3, (Math.floor(y) * width + Math.floor(x)) * 3 + 3)) }; }
    finally { bitmap.destroy(); }
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}
for (const format of ['webp', 'svg', 'oriented-jpeg'] as const) test(`inserts ${format} with matching preview, placement and actual PDF export`, async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pdf = await PDFDocument.create(); pdf.addPage([600, 700]); await page.goto('./');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'images.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible(); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  let bytes: Uint8Array, mimeType: string, name: string;
  if (format === 'svg') { bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path fill="red" d="M0 0H40V40H0Z"/><path fill="blue" d="M40 0H80V40H40Z"/></svg>'); mimeType = 'image/svg+xml'; name = 'image.svg'; }
  else {
    const data = await page.evaluate(type => { const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40; const context = canvas.getContext('2d')!; context.fillStyle = 'red'; context.fillRect(0, 0, 40, 40); context.fillStyle = 'blue'; context.fillRect(40, 0, 40, 40); return canvas.toDataURL(type, 1).split(',')[1]; }, format === 'webp' ? 'image/webp' : 'image/jpeg');
    bytes = Buffer.from(data, 'base64'); mimeType = format === 'webp' ? 'image/webp' : 'image/jpeg'; name = format === 'webp' ? 'image.webp' : 'oriented.jpg';
    if (format === 'oriented-jpeg') {
      const exif = new Uint8Array(36), view = new DataView(exif.buffer); exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0]); view.setUint16(18, 1, true); view.setUint16(20, 0x112, true); view.setUint16(22, 3, true); view.setUint32(24, 1, true); view.setUint16(28, 6, true); bytes = new Uint8Array([...bytes.slice(0, 2), ...exif, ...bytes.slice(2)]);
    }
  }
  await page.getByLabel('Insert images', { exact: true }).setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) }); await expect(page.locator('.image-placement-status')).toBeVisible();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!; await page.mouse.click(box.x + 300, box.y + 380); await expect(page.locator('.image-placement-status')).toHaveCount(0);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click(); const saved = await readFile((await (await download).path())!); const output = outputImage(saved); expect(output.areas).toHaveLength(1);
  const [left, top, right, bottom] = output.areas[0], width = right - left, height = bottom - top, rotated = format === 'oriented-jpeg';
  expect(width / height).toBeCloseTo(rotated ? .5 : 2);
  const redPoint = [left + width * (rotated ? .5 : .25), top + height * (rotated ? .25 : .5)], bluePoint = [left + width * (rotated ? .5 : .75), top + height * (rotated ? .75 : .5)];
  expect(output.sample(redPoint[0], redPoint[1])[0]).toBeGreaterThan(240); expect(output.sample(redPoint[0], redPoint[1])[2]).toBeLessThan(15);
  expect(output.sample(bluePoint[0], bluePoint[1])[2]).toBeGreaterThan(240); expect(output.sample(bluePoint[0], bluePoint[1])[0]).toBeLessThan(15);
  await expect.poll(async () => page.locator('canvas.annotation-canvas').evaluate((canvas: HTMLCanvasElement, point) => canvas.getContext('2d')!.getImageData(Math.floor(point[0]), Math.floor(point[1]), 1, 1).data[0], redPoint)).toBeGreaterThan(240);
  await expect.poll(async () => page.locator('canvas.annotation-canvas').evaluate((canvas: HTMLCanvasElement, point) => canvas.getContext('2d')!.getImageData(Math.floor(point[0]), Math.floor(point[1]), 1, 1).data[2], bluePoint)).toBeGreaterThan(240);
});
