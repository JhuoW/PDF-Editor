import { Buffer } from 'node:buffer';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path fill="red" d="M0 0H40V40H0Z"/><path fill="blue" d="M40 0H80V40H40Z"/></svg>';
async function file(label: string, pages = 3) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([400, 500]).drawText(`${label} page ${i + 1}`, { x: 35, y: 450, size: 16 });
  return { name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}
async function open(page: Page, label = 'First', pages = 3) {
  await page.goto('./'); await page.locator('.main-toolbar input[type=file]').setInputFiles(await file(label, pages));
  await expect(page.locator('.page-wrapper[data-page="1"] canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function png(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 10;
    canvas.getContext('2d')!.fillRect(0, 0, 20, 10); return canvas.toDataURL('image/png').split(',')[1];
  });
}
async function paste(page: Page, base64: string, target = '.pdf-viewer-container') {
  return page.locator(target).evaluate((element, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    element.dispatchEvent(event); return event.defaultPrevented;
  }, base64);
}
async function exportedImages(page: Page) {
  const pending = page.waitForEvent('download', { timeout: 8000 }); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const pdf = new mupdf.PDFDocument(Buffer.concat(chunks));
  try {
    return Array.from({ length: pdf.countPages() }, (_, index) => {
      const sheet = pdf.loadPage(index), text = sheet.toStructuredText('preserve-images'), images: number[][] = [];
      try { text.walk({ onImageBlock(bounds) { images.push([...bounds]); } }); return images; } finally { text.destroy(); sheet.destroy(); }
    });
  } finally { pdf.destroy(); }
}

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('pastes a clipboard image once on the current page in continuous view', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Continuous view', exact: true }).click();
  await expect.poll(() => page.locator('.drawing-annotation-layer').count()).toBeGreaterThan(1);
  const input = page.getByRole('spinbutton', { name: 'Page number', exact: true }); await input.fill('2'); await input.press('Enter');
  await expect(input).toHaveValue('2'); await page.locator('.pdf-viewer-container').click({ position: { x: 5, y: 5 } });
  await paste(page, await png(page)); await expect(page.getByTitle('Delete Image', { exact: true })).toBeVisible();
  expect((await exportedImages(page)).map(images => images.length)).toEqual([0, 1, 0]);
});

test('PDF drag and drop still opens a new PDF over an existing page', async ({ page }) => {
  await open(page); const next = await file('Dropped', 2);
  const transfer = await page.evaluateHandle(data => {
    const files = new DataTransfer(); files.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'Dropped.pdf', { type: 'application/pdf' })); return files;
  }, next.buffer.toString('base64'));
  await page.locator('.drawing-annotation-layer').first().dispatchEvent('drop', { dataTransfer: transfer, clientX: 400, clientY: 350 });
  await expect(page.locator('.page-total')).toHaveText('2'); await expect(page.locator('.document-title')).toHaveText('Dropped.pdf');
});

test('a modal image paste does not modify the PDF in the background', async ({ page }) => {
  await open(page, 'Modal', 1); await page.getByRole('button', { name: 'All tools', exact: true }).click(); await page.locator('.workspace-all-tools [data-command="properties"]').click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  expect(await paste(page, await png(page), 'dialog[open]')).toBe(false);
  await dialog.getByRole('button', { name: 'Close document properties', exact: true }).click();
  expect((await exportedImages(page)).map(images => images.length)).toEqual([0]);
});

test('dropped SVG images are normalized into exportable PDF pixels', async ({ page }) => {
  await open(page, 'SVG', 1);
  const transfer = await page.evaluateHandle(data => { const files = new DataTransfer(); files.items.add(new File([data], 'image.svg', { type: 'image/svg+xml' })); return files; }, svg);
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.locator('.drawing-annotation-layer').dispatchEvent('drop', { dataTransfer: transfer, clientX: bounds.x + 200, clientY: bounds.y + 250 });
  await expect(page.getByTitle('Delete Image', { exact: true })).toBeVisible();
  const images = await exportedImages(page); expect(images[0]).toHaveLength(1);
  const [left, top, right, bottom] = images[0][0]; expect((right - left) / (bottom - top)).toBeCloseTo(2);
});

test('an image read from a previous document cannot finish inside a new document', async ({ page }) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    const appWindow = window as unknown as { holdImages?: boolean; imageReads?: Array<() => void> };
    FileReader.prototype.readAsDataURL = function(blob) {
      if (appWindow.holdImages && blob.type.startsWith('image/')) (appWindow.imageReads ??= []).push(() => original.call(this, blob));
      else original.call(this, blob);
    };
  });
  await open(page, 'Old', 1); await page.evaluate(() => { (window as unknown as { holdImages: boolean }).holdImages = true; });
  await paste(page, await png(page));
  await expect.poll(() => page.evaluate(() => (window as unknown as { imageReads?: unknown[] }).imageReads?.length ?? 0)).toBe(1);
  await page.locator('.main-toolbar input[type=file]').setInputFiles(await file('New', 1)); await expect(page.locator('.document-title')).toHaveText('New.pdf');
  await page.evaluate(() => { const appWindow = window as unknown as { holdImages: boolean; imageReads: Array<() => void> }; appWindow.holdImages = false; appWindow.imageReads.forEach(read => read()); });
  // The old FileReader can complete after the new document is visible.
  await page.waitForTimeout(250);
  expect((await exportedImages(page)).map(images => images.length)).toEqual([0]);
  await expect(page.getByTitle('Delete Image', { exact: true })).toHaveCount(0);
});
