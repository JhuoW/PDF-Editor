import { Buffer } from 'node:buffer';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function openPDF(page: Page) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]).drawText('CAT catalog cat', { x: 40, y: 300, size: 18 });
  pdf.addPage([400, 600]).drawText('cat', { x: 40, y: 300, size: 18 });
  pdf.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'search.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}

test('search counts, highlights and navigation respect one-character, whole-word and case options', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPDF(page);
  await page.keyboard.press('Control+f');
  const panel = page.getByRole('search', { name: 'Document search' });
  const input = panel.getByRole('textbox', { name: 'Search document text' });
  await input.fill('c');
  await expect(panel.getByRole('status')).toHaveText('1 of 4 matches');
  const bounds = (await panel.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await input.fill('cat');
  await expect(panel.getByRole('status')).toHaveText('1 of 4 matches');
  await panel.getByLabel('Whole word', { exact: true }).check();
  await expect(panel.getByRole('status')).toHaveText('1 of 3 matches');
  await expect(page.locator('mark.search-highlight')).toHaveCount(2);
  await panel.getByLabel('Match case', { exact: true }).check();
  await expect(panel.getByRole('status')).toHaveText('1 of 2 matches');
  await expect(page.locator('mark.search-highlight')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
  await input.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('2 of 2 matches');
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('2');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('go to page is a bounded modal with integer validation, focus restoration and no background navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openPDF(page);
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  const opener = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
  await opener.focus();
  await page.keyboard.press('Control+g');
  const dialog = page.getByRole('dialog', { name: 'Go to Page', exact: true });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('spinbutton');
  await expect(input).toBeFocused();
  await input.fill('1.5');
  await dialog.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('whole page number');
  await expect(pageNumber).toHaveValue('1');
  await dialog.getByRole('button', { name: 'Close go to page', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(pageNumber).toHaveValue('1');
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(308);
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press('Tab');
    // Native modal Tab navigation may reach browser chrome, but never background controls.
    expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await input.fill('3');
  await dialog.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pageNumber).toHaveValue('3');
  await expect(opener).toBeFocused();
  await page.keyboard.press('Control+g');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
