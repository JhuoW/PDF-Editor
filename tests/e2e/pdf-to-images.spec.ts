import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { unzipSync } from 'fflate';
import * as mupdf from 'mupdf';

async function fixture() {
  const pdf = await PDFDocument.create();
  for (const [index, color] of [rgb(1, 0, 0), rgb(0, 1, 0), rgb(0, 0, 1)].entries()) {
    const sheet = pdf.addPage([144, 72]);
    sheet.drawRectangle({ x: 0, y: 0, width: 144, height: 72, color });
    sheet.drawText(`PAGE ${index + 1}`, { x: 12, y: 40, size: 10 });
  }
  return Buffer.from(await pdf.save());
}
async function open(page: Page, data?: Buffer) {
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'selected-pages.pdf', mimeType: 'application/pdf', buffer: data ?? await fixture() });
  await expect(page.locator('canvas.page-canvas').first()).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function converter(page: Page) {
  await page.locator('#workspace-convert').click();
  await page.locator('.workspace-ribbon [data-command="pdf-to-images"]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('PDF to images');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  return dialog;
}
async function download(page: Page, button = 'Convert to images') {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const file = await pending;
  return { bytes: await readFile((await file.path())!), name: file.suggestedFilename() };
}
function inspect(bytes: Uint8Array) {
  const image = new mupdf.Image(bytes), pixels = image.toPixmap();
  try { return { width: pixels.getWidth(), height: pixels.getHeight(), color: [...pixels.getPixels().slice(0, 3)], pixels: new Uint8Array(pixels.getPixels()) }; }
  finally { pixels.destroy(); image.destroy(); }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); localStorage.setItem('pdf-editor.locale', 'en'); });
});

test('validates custom pages before exporting and downloads only the requested PNGs in their listed order', async ({ page }) => {
  await open(page);
  const dialog = await converter(page);
  await expect(dialog.getByRole('radio', { name: 'Selected thumbnails (0)', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Export format' }).locator('option')).toHaveCount(2);
  await dialog.getByRole('radio', { name: 'Custom page range', exact: true }).check();
  let downloads = 0; page.on('download', () => downloads++);
  await dialog.getByRole('button', { name: 'Convert to images', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter at least one page');
  await dialog.getByLabel('Page range', { exact: true }).fill('4');
  await expect(dialog.getByRole('alert')).toContainText('between 1 and 3');
  await dialog.getByRole('button', { name: 'Convert to images', exact: true }).click();
  expect(downloads).toBe(0);
  await dialog.getByLabel('Page range', { exact: true }).fill('３，１，３');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('2 of 3 pages selected');
  const result = await download(page);
  expect(result.name).toBe('selected-pages-pages.zip');
  const files = Object.entries(unzipSync(result.bytes));
  expect(files.map(([name]) => name)).toEqual(['selected-pages-page-3.png', 'selected-pages-page-1.png']);
  expect(inspect(files[0][1])).toMatchObject({ width: 300, height: 150, color: [0, 0, 255] });
  expect(inspect(files[1][1])).toMatchObject({ width: 300, height: 150, color: [255, 0, 0] });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
});

test('uses the current page number for a direct 300 dpi JPEG download', async ({ page }) => {
  await open(page);
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  await pageNumber.fill('2'); await pageNumber.press('Enter');
  const dialog = await converter(page);
  await dialog.getByRole('radio', { name: 'Current page (2)', exact: true }).check();
  await dialog.getByLabel('Export format', { exact: true }).selectOption('jpeg');
  await dialog.getByLabel('Resolution', { exact: true }).selectOption('300');
  await dialog.getByLabel('JPEG quality', { exact: true }).press('End');
  await expect(dialog.getByRole('status')).toContainText('One image will download directly');
  const result = await download(page);
  expect(result.name).toBe('selected-pages-page-2.jpg');
  const image = inspect(result.bytes);
  expect(image).toMatchObject({ width: 600, height: 300 });
  expect(image.color[1]).toBeGreaterThan(240);
  await expect(pageNumber).toHaveValue('2');
});

test('uses thumbnail selections and can then export all pages without changing the selection', async ({ page }) => {
  await open(page);
  await page.locator('.thumbnail-select[aria-label="Go to page 3"]').click({ modifiers: ['Control'] });
  await page.locator('.thumbnail-select[aria-label="Go to page 1"]').click({ modifiers: ['Control'] });
  const dialog = await converter(page);
  await dialog.getByRole('radio', { name: 'Selected thumbnails (2)', exact: true }).check();
  const selected = unzipSync((await download(page)).bytes);
  expect(Object.keys(selected)).toEqual(['selected-pages-page-1.png', 'selected-pages-page-3.png']);
  await expect(page.locator('.thumbnail-item.selected')).toHaveCount(2);
  const reopened = await converter(page);
  await expect(reopened.getByRole('radio', { name: 'All pages (3)', exact: true })).toBeChecked();
  const all = unzipSync((await download(page)).bytes);
  expect(Object.keys(all)).toEqual(['selected-pages-page-1.png', 'selected-pages-page-2.png', 'selected-pages-page-3.png']);
});

test('renders pending original-text and form edits into the image without requiring Apply changes', async ({ page }) => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier), sheet = pdf.addPage([400, 260]);
  sheet.drawText('ORIGINAL CONTENT', { x: 30, y: 200, size: 20, font });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original form'); field.addToPage(sheet, { x: 30, y: 90, width: 250, height: 30 });
  pdf.addPage([400, 260]).drawText('EXCLUDED PAGE');
  await open(page, Buffer.from(await pdf.save()));
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Visible edited form');
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.locator('.workspace-all-tools [data-command="edit-text"]').click();
  await page.locator('.text-block').filter({ hasText: 'ORIGINAL CONTENT' }).dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('EDITED CONTENT');
  const dialog = await converter(page);
  await dialog.getByRole('radio', { name: 'Current page (1)', exact: true }).check();
  const actual = inspect((await download(page)).bytes);
  const edited = new mupdf.PDFDocument((await download(page, 'Export')).bytes), first = edited.loadPage(0), text = first.toStructuredText('');
  const expected = first.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    expect(text.asText()).toContain('EDITED CONTENT'); expect(text.asText()).not.toContain('ORIGINAL CONTENT');
    expect(actual.width).toBe(expected.getWidth()); expect(actual.height).toBe(expected.getHeight());
    expect(Buffer.from(actual.pixels)).toEqual(Buffer.from(expected.getPixels()));
    const fields = first.getWidgets();
    try { expect(fields.some(widget => widget.getValue() === 'Visible edited form')).toBe(true); }
    finally { fields.forEach(widget => widget.destroy()); }
  } finally { expected.destroy(); text.destroy(); first.destroy(); edited.destroy(); }
});

test('phone controls stay within the dialog and language changes preserve the custom page draft', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const dialog = await converter(page);
  await dialog.getByRole('radio', { name: 'Custom page range', exact: true }).check();
  await dialog.getByLabel('Page range', { exact: true }).fill('1, 3');
  await dialog.getByLabel('Export format', { exact: true }).selectOption('jpeg');
  await dialog.getByLabel('Resolution', { exact: true }).selectOption('300');
  await dialog.locator('.language-switcher button[lang="zh-CN"]').click();
  await expect(dialog).toHaveAccessibleName('PDF 转图片');
  await expect(dialog.getByRole('radio', { name: '指定页面范围', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('页面范围', { exact: true })).toHaveValue('1, 3');
  await expect(dialog.getByRole('status')).toContainText('已选择 2 页，共 3 页');
  await expect(dialog.getByLabel('导出格式', { exact: true })).toHaveValue('jpeg');
  await expect(dialog.getByLabel('分辨率', { exact: true })).toHaveValue('300');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(dialog.getByRole('button', { name: '转换为图片', exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: '/tmp/pdf-to-images-mobile.png' });
  const images = unzipSync((await download(page, '转换为图片')).bytes);
  expect(Object.keys(images)).toEqual(['selected-pages-page-1.jpg', 'selected-pages-page-3.jpg']);
  await expect(page.locator('.page-total')).toHaveText('3');
});
