import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { unzipSync } from 'fflate';

function image(width: number, height: number, color: number[], jpeg = false) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  try {
    const pixels = pixmap.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
    return Buffer.from(jpeg ? pixmap.asJPEG(95) : pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
function imageInfo(bytes: Uint8Array) {
  const source = new mupdf.Image(bytes), pixels = source.toPixmap();
  try { return { width: pixels.getWidth(), height: pixels.getHeight(), color: [...pixels.getPixels().slice(0, 3)] }; }
  finally { pixels.destroy(); source.destroy(); }
}
async function download(page: Page, button = 'Export') {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const result = await pending;
  return { bytes: await readFile((await result.path())!), name: result.suggestedFilename() };
}
async function openExport(page: Page) {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Export Pages…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Pages', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  return dialog;
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('creates ordered image pages, removes a selection, and downloads selected pages as PNG or JPEG ZIP', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Create PDF from Images…', exact: true }).click();
  const creator = page.getByRole('dialog', { name: 'Create PDF from Images', exact: true });
  await expect(creator).toBeVisible();
  expect(await creator.evaluate(element => element.matches(':modal'))).toBe(true);
  await page.getByLabel('Images', { exact: true }).setInputFiles([
    { name: 'red.png', mimeType: 'image/png', buffer: image(144, 72, [255, 0, 0]) },
    { name: 'green.jpg', mimeType: 'image/jpeg', buffer: image(72, 36, [0, 255, 0], true) },
    { name: 'extra.png', mimeType: 'image/png', buffer: image(10, 10, [0, 0, 255]) },
  ]);
  await expect(page.getByLabel('Image page order').locator('li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Remove image 3: extra.png', exact: true }).click();
  await page.getByRole('button', { name: 'Move image 2 earlier', exact: true }).click();
  await page.getByRole('combobox', { name: 'Page size', exact: true }).selectOption('image');
  await page.getByLabel('Margin (mm)', { exact: true }).fill('0');
  await page.getByLabel('PDF file name', { exact: true }).fill('created-images.pdf');
  await page.getByRole('button', { name: 'Create PDF', exact: true }).click();
  await expect(creator).toHaveCount(0);
  await expect(page.locator('.page-total')).toHaveText('2');
  const created = await download(page);
  expect(created.name).toBe('created-images.pdf');
  const document = await PDFDocument.load(created.bytes);
  expect(document.getPages().map(pdfPage => pdfPage.getSize())).toEqual([{ width: 72, height: 36 }, { width: 144, height: 72 }]);

  await openExport(page);
  await page.getByLabel('Page range', { exact: true }).fill('2');
  await page.getByLabel('Resolution', { exact: true }).selectOption('300');
  const png = await download(page, 'Export pages');
  expect(png.name).toBe('created-images-page-2.png');
  expect(imageInfo(png.bytes)).toEqual({ width: 600, height: 300, color: [255, 0, 0] });
  await openExport(page);
  await page.getByLabel('Export format', { exact: true }).selectOption('jpeg');
  await page.getByLabel('Page range', { exact: true }).fill('2,1');
  await page.getByLabel('Resolution', { exact: true }).selectOption('150');
  const zip = await download(page, 'Export pages');
  expect(zip.name).toBe('created-images-pages.zip');
  const images = Object.entries(unzipSync(zip.bytes));
  expect(images.map(([name]) => name)).toEqual(['created-images-page-2.jpg', 'created-images-page-1.jpg']);
  expect(imageInfo(images[0][1])).toMatchObject({ width: 300, height: 150 });
  expect(imageInfo(images[0][1]).color[0]).toBeGreaterThan(240);
  expect(imageInfo(images[1][1])).toMatchObject({ width: 150, height: 75 });
  expect(imageInfo(images[1][1]).color[1]).toBeGreaterThan(240);
});

test('exports current text and Unicode form edits to UTF-8 and rejects invalid ranges without a download', async ({ page }) => {
  const pdf = await PDFDocument.create(), first = pdf.addPage([400, 600]);
  first.drawText('OLD PAGE CONTENT', { x: 30, y: 500, size: 14 });
  const field = pdf.getForm().createTextField('Name'); field.setText('Original'); field.addToPage(first, { x: 30, y: 400, width: 300, height: 30 });
  pdf.addPage().drawText('EXCLUDED SECOND PAGE');
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'text-source.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('客户 中文');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'OLD PAGE CONTENT' }).dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('NEW TEXT');
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).press('Enter');
  const dialog = await openExport(page);
  await page.getByLabel('Export format', { exact: true }).selectOption('text');
  await page.getByLabel('Page range', { exact: true }).fill('3');
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Export pages', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('between 1 and 2');
  expect(downloads).toBe(0);
  await page.getByLabel('Page range', { exact: true }).fill('1');
  const text = await download(page, 'Export pages');
  expect(text.name).toBe('text-source-pages.txt');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(text.bytes);
  expect(value).toContain('NEW TEXT'); expect(value).toContain('客户 中文');
  expect(value).not.toContain('OLD PAGE CONTENT'); expect(value).not.toContain('EXCLUDED SECOND PAGE');
});

test('rejects an invalid image batch atomically and cancels a running page export', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 40; index++) pdf.addPage([595, 842]).drawText(`CANCEL PAGE ${index + 1}`);
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'many-pages.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('.page-total')).toHaveText('40');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Create PDF from Images…', exact: true }).click();
  await page.getByLabel('Images', { exact: true }).setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: image(20, 20, [255, 0, 0]) });
  await expect(page.getByLabel('Image page order').locator('li')).toHaveCount(1);
  await page.getByLabel('Images', { exact: true }).setInputFiles([
    { name: 'another.png', mimeType: 'image/png', buffer: image(20, 20, [0, 255, 0]) },
    { name: 'unsupported.webp', mimeType: 'image/webp', buffer: Buffer.from('not a supported image') },
  ]);
  await expect(page.getByRole('alert')).toContainText('only still PNG and JPEG');
  await expect(page.getByLabel('Image page order').locator('li')).toHaveCount(1);
  const jpg = image(40, 20, [0, 0, 0], true);
  const scan = jpg.findIndex((byte, index) => byte === 255 && jpg[index + 1] === 218);
  const entropy = scan + 2 + jpg.readUInt16BE(scan + 2);
  const emptyJPEG = Buffer.concat([jpg.subarray(0, entropy), Buffer.from([255, 217])]);
  await page.getByLabel('Images', { exact: true }).setInputFiles({ name: 'empty-scan.jpg', mimeType: 'image/jpeg', buffer: emptyJPEG });
  await expect(page.getByRole('alert')).toContainText('no encoded image data');
  await expect(page.getByLabel('Image page order').locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = await openExport(page);
  await page.getByLabel('Resolution', { exact: true }).selectOption('300');
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Export pages', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.page-total')).toHaveText('40');
  await page.waitForTimeout(300);
  expect(downloads).toBe(0);
  // A fresh export still works after the terminated worker was discarded.
  await openExport(page);
  await page.getByLabel('Export format', { exact: true }).selectOption('text');
  await page.getByLabel('Page range', { exact: true }).fill('40');
  expect((await download(page, 'Export pages')).bytes.toString('utf8')).toContain('CANCEL PAGE 40');
});
