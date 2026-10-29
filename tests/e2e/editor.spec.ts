import { Buffer } from 'node:buffer';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function createPDF(pageCount: number, label: string, mixedSizes = false) {
  const document = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = document.addPage(mixedSizes && pageNumber % 2 === 0 ? [600, 900] : [400, 600]);
    page.drawText(`${label} - Page ${pageNumber}`, { x: 30, y: 540, size: 18 });
  }
  return Buffer.from(await document.save());
}

async function openPDF(page: Page, pageCount: number, fileName: string, mixedSizes = false) {
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: await createPDF(pageCount, fileName, mixedSizes),
  });
  await expect(page.locator('.page-total')).toHaveText(String(pageCount));
  await expect(page.locator('.page-wrapper[data-page="1"] canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-wrapper[data-page="1"] .page-loading-overlay')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible();
});

test('opens a local PDF, commits a multi-digit page, and displays a non-preset zoom', async ({ page }) => {
  await openPDF(page, 25, 'navigation.pdf');
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await pageNumber.fill('');
  await expect(pageNumber).toHaveValue('');
  await pageNumber.fill('12');
  // The current page remains visible until the user commits the input.
  await expect(page.locator('.page-wrapper[data-page="1"]')).toBeVisible();
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="12"] canvas.page-canvas')).toBeVisible();
  await expect(pageNumber).toHaveValue('12');

  const zoom = page.getByRole('combobox', { name: 'Zoom', exact: true });
  await zoom.selectOption('1.25');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(zoom).toHaveValue('1.5625');
  await expect(zoom.locator('option:checked')).toHaveText('156%');
});

test('continuous navigation renders nearby pages and preserves canvases that remain visible', async ({ page }) => {
  await openPDF(page, 40, 'continuous.pdf');
  await page.getByRole('button', { name: 'Continuous view', exact: true }).click();
  const canvases = page.locator('.page-wrapper canvas.page-canvas');
  await expect(page.locator('.page-wrapper')).toHaveCount(40);
  await expect.poll(() => canvases.count()).toBeLessThanOrEqual(5);
  const firstCanvas = await page.locator('.page-wrapper[data-page="1"] canvas.page-canvas').elementHandle();
  expect(firstCanvas).not.toBeNull();
  await page.locator('.pdf-viewer-container').evaluate(container => { container.scrollTop += 80; });
  await expect(page.locator('.page-wrapper[data-page="1"]')).toBeInViewport({ ratio: 0.5 });
  expect(await firstCanvas!.evaluate(canvas => (
    canvas.isConnected && canvas === document.querySelector('.page-wrapper[data-page="1"] canvas.page-canvas')
  ))).toBe(true);

  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await pageNumber.fill('40');
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="40"] canvas.page-canvas')).toBeInViewport({ ratio: 0.5 });
  await expect(pageNumber).toHaveValue('40');
  await expect.poll(() => canvases.count()).toBeLessThanOrEqual(5);
  await expect(page.locator('.page-wrapper[data-page="1"] canvas.page-canvas')).toHaveCount(0);
  await expect(page.locator('.page-wrapper[data-page="39"] canvas.page-canvas')).toHaveCount(1);
  await firstCanvas!.dispose();

  await pageNumber.fill('20');
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="20"] canvas.page-canvas')).toBeInViewport({ ratio: 0.5 });
  await expect(pageNumber).toHaveValue('20');
  await expect(page.locator('.page-wrapper[data-page="19"] canvas.page-canvas')).toHaveCount(1);
  await expect(page.locator('.page-wrapper[data-page="21"] canvas.page-canvas')).toHaveCount(1);
});

test('continuous zoom keeps the same page and relative viewport position', async ({ page }) => {
  await openPDF(page, 20, 'zoom-anchor.pdf', true);
  await page.getByRole('button', { name: 'Continuous view', exact: true }).click();
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await pageNumber.fill('12');
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="12"] canvas.page-canvas')).toBeInViewport({ ratio: 0.5 });
  await expect.poll(() => page.evaluate(() => Math.abs(
    document.querySelector('.page-wrapper[data-page="12"]')!.getBoundingClientRect().top -
    document.querySelector('.pdf-viewer-container')!.getBoundingClientRect().top
  ))).toBeLessThan(2);
  await expect(pageNumber).toHaveValue('12');
  const anchorFraction = () => page.evaluate(() => {
    const container = document.querySelector('.pdf-viewer-container')!;
    const slot = document.querySelector('.page-wrapper[data-page="12"] .page-viewport')!;
    return (container.getBoundingClientRect().top + container.clientHeight / 2 - slot.getBoundingClientRect().top) / slot.getBoundingClientRect().height;
  });
  const before = await anchorFraction();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('2');
  await expect.poll(async () => Math.abs(await anchorFraction() - before)).toBeLessThan(0.03);
  await expect(pageNumber).toHaveValue('12');
  await expect(page.locator('.page-wrapper[data-page="12"] canvas.page-canvas')).toBeInViewport();
  await page.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
  await expect.poll(async () => Math.abs(await anchorFraction() - before)).toBeLessThan(0.03);
  await expect(pageNumber).toHaveValue('12');
  await expect.poll(() => page.locator('.page-wrapper canvas.page-canvas').count()).toBeLessThanOrEqual(5);
});

test('continuous search mounts and reveals a match on a distant page', async ({ page }) => {
  await openPDF(page, 40, 'search-window.pdf');
  await page.getByRole('button', { name: 'Continuous view', exact: true }).click();
  await expect(page.locator('.page-wrapper[data-page="37"] canvas.page-canvas')).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await page.getByPlaceholder('Search in document...').fill('Page 37');
  await expect(page.locator('.search-status')).toHaveText('1 of 1 matches');
  await expect(page.locator('.page-wrapper[data-page="37"] .search-highlight.active')).toBeInViewport();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('37');
  await expect.poll(() => page.locator('.page-wrapper canvas.page-canvas').count()).toBeLessThanOrEqual(6);
});

test('a failed open preserves the current PDF and a new PDF resets navigation', async ({ page }) => {
  await openPDF(page, 4, 'original.pdf');
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await pageNumber.fill('3');
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="3"]')).toBeVisible();

  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'invalid.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('This file is not a PDF.'),
  });
  await expect(page.locator('.error-state')).toBeVisible();
  await expect(page.locator('.page-total')).toHaveText('4');
  await expect(pageNumber).toHaveValue('3');
  await expect(page.locator('.page-wrapper[data-page="3"] canvas.page-canvas')).toBeVisible();

  await openPDF(page, 2, 'replacement.pdf');
  await expect(pageNumber).toHaveValue('1');
  await expect(page.locator('.error-state')).toHaveCount(0);
});
