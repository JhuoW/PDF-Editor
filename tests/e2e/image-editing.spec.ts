import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

function png(color: number[]) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  try {
    const pixels = pixmap.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
    return Buffer.from(pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
const red = png([255, 0, 0]), blue = png([0, 0, 255]);
async function fixture(rotated: boolean) {
  const document = await PDFDocument.create();
  const image = await document.embedPng(red);
  const page = document.addPage([600, 800]);
  if (rotated) {
    page.setCropBox(50, 100, 500, 650);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  page.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(0, 1, 1) });
  page.drawText('TEXT_UNDER_IMAGE', { x: 80, y: 520, size: 12 });
  page.drawImage(image, { x: 80, y: 500, width: 80, height: 60 });
  page.drawImage(image, { x: 300, y: 500, width: 80, height: 60 });
  return Buffer.from(await document.save());
}
function inspect(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), text = page.toStructuredText('preserve-images');
  try {
    const images: { bounds: number[]; pixel: number[] }[] = [];
    text.walk({ onImageBlock(bounds, _matrix, image) {
      const pixmap = image.toPixmap();
      try { images.push({ bounds, pixel: Array.from(pixmap.getPixels().slice(0, 3)) }); } finally { pixmap.destroy(); }
    } });
    return { text: text.asText(), images, transform: page.getTransform() };
  } finally { text.destroy(); page.destroy(); document.destroy(); }
}
async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function enterImages(page: Page) {
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '🖼 Edit Images', exact: true }).click();
  await expect(page.locator('.image-box')).toHaveCount(2);
  await page.getByRole('button', { name: 'Select original image 1', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});
for (const rotated of [false, true]) {
  test(`original images can replace, move, delete, apply, and undo on a ${rotated ? 'cropped rotated UserUnit=2' : 'normal'} page`, async ({ page }) => {
    await page.goto('/');
    await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'images.pdf', mimeType: 'application/pdf', buffer: await fixture(rotated) });
    await expect(page.locator('canvas.page-canvas')).toBeVisible();
    await enterImages(page);
    await page.getByLabel('Replacement image', { exact: true }).setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: blue });
    await expect(page.locator('.image-box.pending')).toHaveCount(1);
    for (const [key, value] of Object.entries({ x: 150, y: 300, width: 120, height: 40 })) await page.getByLabel(`Image ${key}`, { exact: true }).fill(String(value));
    await page.getByRole('button', { name: 'Set position and size', exact: true }).click();
    const output = inspect(await download(page));
    expect(output.images).toHaveLength(2);
    expect(output.images[0].pixel).toEqual([0, 0, 255]);
    expect(output.images[1].pixel).toEqual([255, 0, 0]);
    expect(output.text).toContain('TEXT_UNDER_IMAGE');
    const nativeRect: mupdf.Rect = rotated ? [125, 580, 185, 600] : [150, 460, 270, 500];
    expect(output.images[0].bounds).toEqual(mupdf.Rect.transform(nativeRect, output.transform));
    // Repeated export always starts from the original bytes, so pending edits
    // are never applied twice or rebound to the newly inserted resource.
    expect(inspect(await download(page)).images).toEqual(output.images);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const deleted = inspect(await download(page));
    expect(deleted.images).toHaveLength(1);
    expect(deleted.images[0].pixel).toEqual([255, 0, 0]);
    expect(deleted.text).toContain('TEXT_UNDER_IMAGE');
    await page.getByRole('button', { name: 'Reset image edits', exact: true }).click();
    expect(inspect(await download(page)).images).toHaveLength(2);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
    await expect(page.getByTitle('Undo Apply text and image changes (Ctrl+Z)', { exact: true })).toBeEnabled();
    expect(inspect(await download(page)).images).toHaveLength(1);
    const committedCanvas = await page.locator('canvas.page-canvas').elementHandle();
    await page.getByTitle('Undo Apply text and image changes (Ctrl+Z)', { exact: true }).click();
    await expect(page.getByTitle('Redo Apply text and image changes (Ctrl+Shift+Z)', { exact: true })).toBeEnabled();
    // History moves before the asynchronous PDF reload publishes its workspace.
    await committedCanvas!.waitForElementState('hidden');
    await expect(page.locator('canvas.page-canvas')).toBeVisible();
    // Undo restores both source bytes and the pending delete workspace.
    await enterImages(page);
    await page.getByRole('button', { name: 'Reset image edits', exact: true }).click();
    expect(inspect(await download(page)).images).toHaveLength(2);
  });
}
