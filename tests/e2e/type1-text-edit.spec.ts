import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import * as mupdf from 'mupdf';

function pageText(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); document.destroy(); }
}

test('edits text in a Type 1 font and reopens the saved file for another edit', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  const open = async (name: string, buffer: Buffer) => {
    await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await expect(page.locator('canvas.page-canvas')).toBeVisible();
    await expect(page.getByRole('button', { name: 'All tools' })).toBeVisible();
  };
  const append = async (from: string, added: string) => {
    const allTools = page.getByRole('button', { name: 'All tools' });
    await allTools.click();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
    const block = page.locator('.text-block').filter({ hasText: from });
    await block.click({ position: { x: 20, y: 5 } });
    const input = page.locator('.pdf-text-input');
    await input.press('ControlOrMeta+End');
    await input.pressSequentially(added);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    return readFile((await (await pending).path())!);
  };

  await open('type1.pdf', await readFile('tests/fixtures/type1-font.pdf'));
  const first = await append('Plain Type one row', ' one');
  expect(pageText(first).replace(/\s+/g, ' ')).toContain('Plain Type one row Second row stays here one');
  // A bare Type 1 program must stay behind its simple font, or other readers paint garbage.
  expect(first.includes('/FontFile ') && first.includes('/CIDFontType0 ')).toBe(false);

  await page.goto('./');
  await open('type1-saved.pdf', first);
  const second = await append('Plain Type one row', ' two');
  expect(pageText(second).replace(/\s+/g, ' ')).toContain('Plain Type one row Second row stays here one two');
});
