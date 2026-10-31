import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page) {
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  let png: Uint8Array;
  try {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels.getPixels().set(colors[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)], (y * 8 + x) * 3);
    png = new Uint8Array(pixels.asPNG());
  } finally { pixels.destroy(); }
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([400, 500]);
  sheet.drawText('Original wording', { x: 40, y: 430, size: 16 });
  sheet.drawImage(await pdf.embedPng(png), { x: 60, y: 240, width: 80, height: 60 });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original'); field.addToPage(sheet, { x: 40, y: 350, width: 250, height: 25 });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'combined.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}
async function command(page: Page, id: string) {
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  await page.locator(`.workspace-all-tools [data-command="${id}"]`).click();
  if (id === 'crop-pages') await page.locator('.page-crop-controls [data-crop-action="options"]').click();
}
async function download(page: Page, button?: string) {
  const pending = page.waitForEvent('download');
  if (button) await page.locator('dialog').getByRole('button', { name: button, exact: true }).click();
  else await page.locator('.main-toolbar .toolbar-btn-primary').click();
  const file = await pending; return readFile((await file.path())!);
}
async function crop(page: Page) {
  await command(page, 'crop-pages'); const dialog = page.locator('dialog');
  await dialog.getByLabel('Top margin (mm)', { exact: true }).fill('10');
  await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click(); await expect(dialog).toHaveCount(0);
}
function firstStyle(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  const glyphs: { font: string; color: number[] }[] = [];
  try {
    text.walk({ onChar(char, _point, font, _size, _quad, color) { try { if (char === 'O') glyphs.push({ font: font.getName(), color: [...color] }); } finally { font.destroy(); } } });
    return glyphs[0];
  } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); localStorage.setItem('pdf-editor.locale', 'en'); });
});

test('reset form values survive page edits, duplication, export, refresh and undo', async ({ page }) => {
  await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Edited');
  await crop(page); await command(page, 'form-reset');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Original');
  await command(page, 'duplicate-pages'); const dialog = page.locator('dialog');
  await dialog.getByLabel('Insert copies', { exact: true }).selectOption('end');
  await dialog.getByRole('button', { name: 'Duplicate pages', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const pdf = await PDFDocument.load(await download(page));
  expect(pdf.getForm().getTextField('Contact').getText()).toBe('Original'); expect(pdf.getForm().getTextField('Contact_2').getText()).toBe('Original');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/); await page.reload();
  await expect(page.locator('.page-total')).toHaveText('2');
  await page.locator('.workspace-history > button').first().click(); await expect(page.locator('.page-total')).toHaveText('1');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Original');
});

test('restoring original wording retains formatting and resetting the font shows the actual original bold state', async ({ page }) => {
  await open(page); await command(page, 'edit-objects');
  const text = page.locator('.object-edit-box[data-object-kind="text"]').first(); await text.click();
  const panel = page.locator('.native-text-properties'), font = panel.getByLabel('Text font', { exact: true });
  await expect(font).toBeEnabled(); await font.selectOption('Courier-Bold');
  await panel.getByLabel('Text color', { exact: true }).fill('#cc2200');
  await text.dblclick(); const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await input.fill('Temporary wording'); await input.fill('Original wording'); await input.press('Control+Enter');
  const style = firstStyle(await download(page)); expect(style.font).toMatch(/Bold/i); expect(style.color[0]).toBeCloseTo(.8, 3);
  await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.object-edit-box[data-object-kind="image"]').click(); await text.click();
  await expect(font).toBeEnabled(); await font.selectOption('original');
  await expect(panel.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const original = firstStyle(await download(page)); expect(original.font).not.toMatch(/Bold/i); expect(original.color[0]).toBeCloseTo(.8, 3);
});

test('cropped and rotated native images remain restorable after page duplication and match the PNG export', async ({ page }) => {
  await open(page); await crop(page); await command(page, 'edit-objects');
  const image = page.locator('.object-edit-box[data-object-kind="image"]'); await image.click();
  const panel = page.locator('.native-image-properties');
  await panel.getByLabel('Left (%)', { exact: true }).fill('50'); await panel.getByRole('button', { name: 'Apply crop', exact: true }).click();
  await panel.getByRole('button', { name: 'Rotate right 90°', exact: true }).click();
  await command(page, 'duplicate-pages'); const dialog = page.locator('dialog');
  await dialog.getByLabel('Insert copies', { exact: true }).selectOption('end');
  await dialog.getByRole('button', { name: 'Duplicate pages', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const number = page.getByRole('spinbutton', { name: 'Page number', exact: true }); await number.fill('2'); await number.press('Enter');
  await command(page, 'edit-objects'); await image.click();
  await expect(panel.getByLabel('Left (%)', { exact: true })).toHaveValue('50');
  await panel.getByRole('button', { name: 'Restore full image', exact: true }).click();
  await expect(panel.getByLabel('Left (%)', { exact: true })).toHaveValue('0');
  const pdf = new mupdf.PDFDocument(await download(page));
  await command(page, 'pdf-to-images');
  await page.getByRole('radio', { name: 'Current page (2)', exact: true }).check();
  const imageBytes = await download(page, 'Convert to images');
  const raster = new mupdf.Image(imageBytes), actual = raster.toPixmap(), sheet = pdf.loadPage(1);
  const expected = sheet.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    expect(actual.getWidth()).toBe(expected.getWidth()); expect(actual.getHeight()).toBe(expected.getHeight());
    expect(Buffer.from(actual.getPixels())).toEqual(Buffer.from(expected.getPixels()));
    const colors = new Set<string>(); const pixels = actual.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) if (pixels[offset] === 255 && pixels[offset + 1] === 0 && pixels[offset + 2] === 0) { colors.add('red'); break; }
    expect(colors.has('red')).toBe(true);
  } finally { expected.destroy(); sheet.destroy(); actual.destroy(); raster.destroy(); pdf.destroy(); }
});

test('formatting active inline text keeps the inspector usable and commits the latest wording', async ({ page }) => {
  await open(page); await command(page, 'edit-objects');
  await page.locator('.object-edit-box[data-object-kind="text"]').first().dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('Original revised');
  const panel = page.locator('.native-text-properties'), color = panel.getByLabel('Text color', { exact: true });
  await expect(color).toBeEnabled(); await color.focus();
  await expect(panel).toBeVisible(); await expect(color).toBeFocused(); await color.fill('#cc2200');
  await panel.getByRole('button', { name: 'Bold', exact: true }).click();
  const bytes = await download(page), glyph = firstStyle(bytes);
  expect(glyph.font).toMatch(/Bold/i); expect(glyph.color[0]).toBeCloseTo(.8, 3);
  const pdf = new mupdf.PDFDocument(bytes), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  try { expect(text.asText()).toContain('Original revised'); } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
});
