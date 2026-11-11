import { Buffer } from 'node:buffer';
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

test('a failed edit snapshot excludes stale words but keeps unaffected pages searchable and supports retry', async ({ page }) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]).drawText('Original wording', { x: 40, y: 480, size: 16 });
  pdf.addPage([400, 600]).drawText('Unaffected searchable page', { x: 40, y: 480, size: 16 });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'search-partial.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.locator('.workspace-ribbon [data-command=edit-text]').click();
  await page.locator('.text-block').first().click();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('Changed wording');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.route(/PDFExport\.worker/, route => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage=()=>self.postMessage({type:"error",message:"Text does not fit the current page"})' }));
  await page.keyboard.press('Control+f');
  const search = page.getByRole('search'), query = search.getByRole('textbox', { name: 'Search document text' });
  await query.fill('Unaffected');
  await expect(search.locator('.search-status')).toHaveText('1 of 1 matches');
  await expect(search.locator('.search-index-error')).toContainText('1');
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('2');
  await expect(page.locator('mark.search-highlight.active:visible')).toHaveText('Unaffected');
  await query.fill('Original');
  await expect(search.locator('.search-status')).toHaveText('No matches found');
  await page.unroute(/PDFExport\.worker/);
  await search.getByRole('button', { name: /Retry/i }).click();
  await expect(search.locator('.search-index-error')).toHaveCount(0);
  await query.fill('Changed');
  await expect(search.locator('.search-status')).toHaveText('1 of 1 matches');
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('1');
  await expect(page.locator('mark.search-highlight.active:visible')).toHaveText('Changed');
});

test('document search and Save shortcuts commit the focused original text editor', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pdf = await PDFDocument.create(); pdf.addPage([400, 600]).drawText('Original words', { x: 40, y: 480, size: 16 });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'focused-commands.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  const edit = async (value: string) => {
    await page.locator('.workspace-ribbon [data-command=edit-text]').click();
    await page.locator('.text-block').first().click();
    const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
    await input.fill(value); return input;
  };
  await (await edit('Search this draft')).press('Control+f');
  const search = page.getByRole('search');
  await search.getByRole('textbox', { name: 'Search document text' }).fill('draft');
  await expect(search.locator('.search-status')).toHaveText('1 of 1 matches');
  await expect(page.locator('mark.search-highlight.active:visible')).toHaveText('draft');
  await page.keyboard.press('Control+f'); await expect(search).toBeVisible();
  await search.getByRole('button', { name: 'Close search' }).click();
  const input = await edit('Saved from the focused editor');
  const downloaded = page.waitForEvent('download'); await input.press('Control+s');
  const file = await downloaded;
  const { readFile } = await import('node:fs/promises'), mupdf = await import('mupdf');
  const saved = new mupdf.PDFDocument(await readFile((await file.path())!)), sheet = saved.loadPage(0), text = sheet.toStructuredText('');
  try { expect(text.asText()).toContain('Saved from the focused editor'); expect(text.asText()).not.toContain('Original'); }
  finally { text.destroy(); sheet.destroy(); saved.destroy(); }
  await expect(page.locator('.document-title')).not.toContainText('*');
});
