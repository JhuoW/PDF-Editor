import { revealPDFRegion } from './pdf-region';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page) {
  const pdf = await PDFDocument.create(), first = pdf.addPage([600, 700]);
  first.drawRectangle({ x: 0, y: 0, width: 600, height: 700, color: rgb(.85, 1, .85) });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original'); field.addToPage(first, { x: 30, y: 630, width: 220, height: 24 });
  await page.goto('./'); await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'signature.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible(); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
}
async function dialog(page: Page) {
  await page.getByRole('button', { name: 'All tools', exact: true }).click(); await page.getByRole('button', { name: 'Signature…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Signature', exact: true }); await expect(panel).toBeVisible(); return panel;
}
async function exported(page: Page) { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click(); return readFile((await (await pending).path())!); }
function images(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('preserve-images'), result: number[][] = [];
  try { text.walk({ onImageBlock(rect) { result.push([...rect]); } }); return result; } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}
function sample(data: Uint8Array, x: number, y: number) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), pixels = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { const start = (Math.floor(y) * pixels.getWidth() + Math.floor(x)) * 3; return [...pixels.getPixels().slice(start, start + 3)]; } finally { pixels.destroy(); page.destroy(); pdf.destroy(); }
}
async function place(page: Page, x = 300, y = 380) { await expect(page.locator('.image-placement-status')).toBeVisible(); const box = (await page.locator('canvas.page-canvas').boundingBox())!; await page.mouse.click(box.x + x, box.y + y); await expect(page.locator('.image-placement-status')).toHaveCount(0); await expect(page.getByTitle('Delete Image', { exact: true })).toBeVisible(); }
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('draws a transparent signature and preserves movement, resizing, deletion, current forms and history across refresh', async ({ page }) => {
  test.setTimeout(120_000); await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('签名后的表单');
  const background = await exported(page);
  const panel = await dialog(page); await expect(panel.getByRole('button', { name: 'Place signature', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Pen color', exact: true }).selectOption('#174ea6');
  const pad = (await panel.getByLabel('Draw your signature', { exact: true }).boundingBox())!;
  await page.mouse.move(pad.x + pad.width * .15, pad.y + pad.height * .6); await page.mouse.down();
  for (const [x, y] of [[.3, .25], [.42, .7], [.55, .35], [.73, .6]] as const) await page.mouse.move(pad.x + pad.width * x, pad.y + pad.height * y, { steps: 5 }); await page.mouse.up();
  await page.screenshot({ path: test.info().outputPath('signature-desktop.png') });
  await panel.getByRole('button', { name: 'Place signature', exact: true }).click(); await expect(panel).toHaveCount(0); await place(page);
  const initialData = await exported(page), initial = images(initialData); expect(initial).toHaveLength(1);
  expect((await PDFDocument.load(initialData)).getForm().getTextField('Contact').getText()).toBe('签名后的表单');
  expect(sample(initialData, initial[0][0] + 1, initial[0][1] + 1)).toEqual(sample(background, initial[0][0] + 1, initial[0][1] + 1));
  let box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.keyboard.down('Shift'); await page.mouse.move(box.x + 300, box.y + 380); await page.mouse.down(); await page.mouse.move(box.x + 330, box.y + 405, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift');
  const moved = images(await exported(page))[0]; expect(moved[0]).toBeCloseTo(initial[0][0] + 30, 0); expect(moved[1]).toBeCloseTo(initial[0][1] + 25, 0);
  await revealPDFRegion(page, moved[1], moved[3] + 20);
  box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(box.x + moved[2], box.y + moved[3]); await page.mouse.down(); await page.mouse.move(box.x + moved[2] + 35, box.y + moved[3] + 15, { steps: 5 }); await page.mouse.up();
  const enlarged = images(await exported(page))[0]; expect(enlarged[2] - enlarged[0]).toBeGreaterThan(moved[2] - moved[0]);
  await page.getByRole('button', { name: /^Undo/ }).click(); await page.getByRole('button', { name: /^Undo/ }).click(); await page.getByRole('button', { name: /^Undo/ }).click(); expect(images(await exported(page))).toHaveLength(0);
  for (let index = 0; index < 3; index++) await page.getByRole('button', { name: /^Redo/ }).click(); expect(images(await exported(page))[0]).toEqual(enlarged);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/); await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible(); expect(images(await exported(page))[0]).toEqual(enlarged);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1'); box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(box.x + (enlarged[0] + enlarged[2]) / 2, box.y + (enlarged[1] + enlarged[3]) / 2); await page.getByTitle('Delete Image', { exact: true }).click(); expect(images(await exported(page))).toHaveLength(0);
  await page.getByRole('button', { name: /^Undo/ }).click(); expect(images(await exported(page))[0]).toEqual(enlarged);
});

test('supports narrow touch drawing and oriented JPEG upload, rejects invalid input, and cancels without adding an image', async ({ page }) => {
  test.setTimeout(90_000); await open(page); const panel = await dialog(page); await page.setViewportSize({ width: 390, height: 844 });
  const pad = (await panel.getByLabel('Draw your signature', { exact: true }).boundingBox())!, cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pad.x + 30, y: pad.y + 30 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pad.x + 90, y: pad.y + 55 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
  await expect(panel.getByRole('button', { name: 'Place signature', exact: true })).toBeEnabled();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await expect(panel.getByRole('button', { name: 'Place signature', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('signature-narrow.png') }); await panel.getByRole('button', { name: 'Clear', exact: true }).click(); await panel.getByRole('button', { name: 'Upload image', exact: true }).click();
  await panel.getByLabel('Signature image', { exact: true }).setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }); await expect(panel.getByRole('alert')).toContainText(/PNG|JPEG/); await expect(panel.getByRole('button', { name: 'Place signature', exact: true })).toBeDisabled();
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 80, 40], false); let jpeg: Uint8Array;
  try { const values = pixels.getPixels(); for (let offset = 0; offset < values.length; offset += 3) values.set((offset / 3) % 80 < 40 ? [255, 0, 0] : [0, 0, 255], offset); jpeg = new Uint8Array(pixels.asJPEG(100)); } finally { pixels.destroy(); }
  const exif = new Uint8Array(36), view = new DataView(exif.buffer); exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0]); view.setUint16(18, 1, true); view.setUint16(20, 0x112, true); view.setUint16(22, 3, true); view.setUint32(24, 1, true); view.setUint16(28, 6, true);
  const file = { name: 'oriented.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([...jpeg.slice(0, 2), ...exif, ...jpeg.slice(2)]) };
  await panel.getByLabel('Signature image', { exact: true }).setInputFiles(file); await expect(panel.getByRole('img', { name: 'Signature preview', exact: true })).toBeVisible();
  expect(await panel.getByRole('img').evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([40, 80]);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(images(await exported(page))).toHaveLength(0);
  await page.setViewportSize({ width: 1280, height: 900 }); const reopened = await dialog(page); await reopened.getByRole('button', { name: 'Upload image', exact: true }).click(); await reopened.getByLabel('Signature image', { exact: true }).setInputFiles(file); await expect(reopened.getByRole('img')).toBeVisible();
  await reopened.getByRole('button', { name: 'Place signature', exact: true }).click(); await place(page); const saved = await exported(page), area = images(saved)[0]; expect((area[2] - area[0]) / (area[3] - area[1])).toBeCloseTo(.5);
  expect(sample(saved, (area[0] + area[2]) / 2, area[1] + 15)[0]).toBeGreaterThan(240); expect(sample(saved, (area[0] + area[2]) / 2, area[3] - 15)[2]).toBeGreaterThan(240);
});
