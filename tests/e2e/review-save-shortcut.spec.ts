import { Buffer } from 'node:buffer';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 650]);
  sheet.drawText('Original editable paragraph', { x: 50, y: 550, size: 16 });
  const field = pdf.getForm().createTextField('Customer'); field.setText('Original customer'); field.addToPage(sheet, { x: 50, y: 400, width: 250, height: 25 });
  await page.goto('./'); await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'save-shortcut.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.getByRole('textbox', { name: 'Customer', exact: true })).toBeVisible();
}
async function saveWithKeyboard(page: Page, input: Locator) {
  const downloaded = page.waitForEvent('download', { timeout: 8000 }); await input.press('ControlOrMeta+s');
  const stream = await (await downloaded).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}

test('Ctrl or Cmd S exports the current form value while its input remains focused', async ({ page }) => {
  await open(page); const field = page.getByRole('textbox', { name: 'Customer', exact: true }); await field.fill('Saved with keyboard 中文');
  const data = await saveWithKeyboard(page, field);
  expect((await PDFDocument.load(data)).getForm().getTextField('Customer').getText()).toBe('Saved with keyboard 中文');
});

test('Ctrl or Cmd S commits original PDF text and exports it from the active editor', async ({ page }) => {
  await open(page); await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  await page.locator('.text-block').filter({ hasText: 'Original editable paragraph' }).click();
  const input = page.locator('.pdf-text-input'); await input.fill('Revised directly in the original PDF');
  const doc = new mupdf.PDFDocument(await saveWithKeyboard(page, input)), sheet = doc.loadPage(0), text = sheet.toStructuredText('');
  try { expect(text.asText()).toContain('Revised directly in the original PDF'); expect(text.asText()).not.toContain('Original editable paragraph'); }
  finally { text.destroy(); sheet.destroy(); doc.destroy(); }
});

test('Space activates focused toolbar buttons without entering temporary pan mode', async ({ page }) => {
  await open(page); const search = page.getByRole('button', { name: 'Search document', exact: true });
  await search.focus(); await search.press('Space');
  await expect(page.getByRole('search', { name: 'Document search', exact: true })).toBeVisible();
  await expect(page.locator('.pdf-viewer-container')).not.toHaveClass(/pan-mode/);
  await page.keyboard.press('Escape');
  const properties = page.getByRole('button', { name: 'Toggle properties', exact: true }); await properties.focus(); await properties.press('Space');
  await expect(page.locator('.workspace-inspector')).toBeVisible();
});
