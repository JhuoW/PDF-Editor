import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function fixture(overlap: boolean) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
  let bitmap: Uint8Array;
  try {
    const pixels = pixmap.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set([255, 0, 0], offset);
    bitmap = new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
  const source = await PDFDocument.create(), sheet = source.addPage([100, 100]);
  sheet.drawText('BEFORE_IMAGE', { x: 2, y: 80, size: 8 });
  sheet.drawImage(await source.embedPng(bitmap), { x: 10, y: 10, width: 30, height: 30, opacity: .25 });
  if (overlap) sheet.drawRectangle({ x: 15, y: 15, width: 20, height: 20, color: rgb(0, 1, 0) });
  sheet.drawRectangle({ x: 110, y: 10, width: 40, height: 30, color: rgb(0, 1, 0) });
  sheet.drawText('AFTER_IMAGE', { x: 2, y: 65, size: 8 });
  const document = await PDFDocument.create(), [form] = await document.embedPdf(await source.save(), [0]);
  const page = document.addPage([400, 600]);
  page.drawPage(form, { x: 20, y: 400, width: 100, height: 100 });
  page.drawPage(form, { x: 200, y: 400, width: 100, height: 100 });
  return Buffer.from(await document.save());
}
function inspect(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0);
  const text = page.toStructuredText(''), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    const pixels = new Uint8Array(pixmap.getPixels()), width = pixmap.getWidth();
    return { text: text.asText(), pixels, pixel: (x: number, y: number) => [...pixels.slice((y * width + x) * 3, (y * width + x) * 3 + 3)] };
  } finally { pixmap.destroy(); text.destroy(); page.destroy(); document.destroy(); }
}
async function download(page: Page, action: 'Save' | 'Export') {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  return readFile((await (await ready).path())!);
}
async function open(page: Page, bytes: Buffer) {
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'form-fidelity.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click();
  const images = page.locator('.object-edit-layer [data-object-kind="image"]');
  await expect(images).toHaveCount(2);
  await images.first().click();
}
for (const overlap of [false, true]) test(`preserves Form opacity and ${overlap ? 'occluding artwork' : 'clipping'} through moving, Save, reopen and Export`, async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  const original = await fixture(overlap);
  await open(page, original);
  await page.keyboard.press('Shift+ArrowRight');
  const first = await download(page, 'Save'), saved = inspect(first);
  expect(saved.pixel(45, 170)).toEqual(overlap ? [0, 255, 0] : [255, 192, 192]);
  expect(saved.pixel(220, 170)).toEqual(inspect(original).pixel(220, 170));
  expect(saved.text.match(/BEFORE_IMAGE/g)).toHaveLength(2);
  expect(saved.text.match(/AFTER_IMAGE/g)).toHaveLength(2);
  await open(page, first);
  for (let index = 0; index < 10; index++) await page.keyboard.press('Shift+ArrowRight');
  const second = inspect(await download(page, 'Export'));
  expect(second.pixel(150, 170)).toEqual([255, 192, 192]);
  expect(second.pixel(175, 170)).toEqual([255, 255, 255]);
  expect(second.pixel(220, 170)).toEqual(saved.pixel(220, 170));
  expect(second.text.match(/BEFORE_IMAGE/g)).toHaveLength(2);
  expect(second.text.match(/AFTER_IMAGE/g)).toHaveLength(2);
  await expect(page.locator('.error-state')).toHaveCount(0);
});
