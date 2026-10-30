import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier);
  const sheet = pdf.addPage([500, 650]);
  sheet.drawText('abcdefghij', { x: 40, y: 550, size: 20, font });
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'text-review.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  const block = page.locator('.text-block').filter({ hasText: 'abcdefghij' });
  await block.click({ position: { x: 2, y: 10 } });
  const input = page.locator('.pdf-text-input');
  await expect(input).toBeFocused();
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'abcdefghij');
  return { block, input };
}
async function selection(page: Page) {
  return page.locator('.pdf-text-input').evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection]);
}

test('Shift-click extends backward selection from its fixed anchor', async ({ page }) => {
  const { block, input } = await open(page);
  await input.press('Control+Home');
  for (let index = 0; index < 8; index++) await input.press('ArrowRight');
  for (let index = 0; index < 3; index++) await input.press('Shift+ArrowLeft');
  await expect.poll(() => selection(page)).toEqual([5, 8, 'backward']);
  await block.click({ position: { x: 2 * 12 + 1, y: 10 }, modifiers: ['Shift'] });
  await expect.poll(() => selection(page)).toEqual([2, 8, 'backward']);
  // Extend across the fixed anchor in the opposite direction without starting a new range.
  await block.click({ position: { x: 9 * 12 + 1, y: 10 }, modifiers: ['Shift'] });
  await expect.poll(() => selection(page)).toEqual([8, 9, 'forward']);
});

test('vertical navigation keeps its preferred PDF column across a shorter line', async ({ page }) => {
  const { input } = await open(page);
  const text = 'abcdefghij\nxy\nabcdefghij';
  await input.fill(text);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', text);
  await input.press('Control+Home');
  for (let index = 0; index < 8; index++) await input.press('ArrowRight');
  await input.press('ArrowDown');
  await expect.poll(() => selection(page)).toEqual([13, 13, 'forward']);
  await input.press('ArrowDown');
  await expect.poll(() => selection(page)).toEqual([22, 22, 'forward']);
  await input.press('ArrowUp'); await input.press('ArrowUp');
  await expect.poll(() => selection(page)).toEqual([8, 8, 'forward']);
});

test('IME composition commits its latest value when exporting directly and can be undone', async ({ page }) => {
  const { input } = await open(page);
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(element, '保留正在输入的中文');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '保留正在输入的中文', isComposing: true, inputType: 'insertCompositionText' }));
  });
  await expect(input).toHaveValue('保留正在输入的中文');
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const pdf = new mupdf.PDFDocument(Buffer.concat(chunks)), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  try { expect(text.asText()).toContain('保留正在输入的中文'); } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
  await page.locator('.workspace-history > button').nth(0).click();
  await expect(page.locator('.text-block').filter({ hasText: 'abcdefghij' })).toBeVisible();
});
