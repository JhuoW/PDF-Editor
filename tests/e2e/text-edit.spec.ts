import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

const originals = ['Original first-page content to replace completely', 'Original second-page content to replace completely'];

async function openSource(page: Page) {
  const document = await PDFDocument.create();
  for (const [index, original] of originals.entries()) {
    const pdfPage = document.addPage([400, 600]);
    pdfPage.drawText(original, { x: 30, y: 520, size: 12 });
    pdfPage.drawText(`UNCHANGED OUTSIDE ${index + 1}`, { x: 30, y: 180, size: 12 });
  }
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'original-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()),
  });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

async function editText(page: Page, original: string, replacement: string) {
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: original }).dblclick();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ });
  await editor.fill(replacement);
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.text-block').filter({ hasText: replacement })).toHaveCount(1);
}

async function exportedText(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await ready;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const document = new mupdf.PDFDocument(Buffer.concat(chunks));
  try {
    return Array.from({ length: document.countPages() }, (_, index) => {
      const pdfPage = document.loadPage(index);
      const text = pdfPage.toStructuredText('');
      try { return text.asText(); }
      finally { text.destroy(); pdfPage.destroy(); }
    });
  } finally {
    document.destroy();
  }
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('original text edits export as Unicode and remain exportable after refresh', async ({ page }) => {
  await openSource(page);
  const replacement = '中文修改后的内容 Hello';
  await editText(page, originals[0], replacement);
  const firstExport = await exportedText(page);
  expect(firstExport[0]).toContain(replacement);
  expect(firstExport[0]).not.toContain(originals[0]);
  expect(firstExport[0]).toContain('UNCHANGED OUTSIDE 1');
  expect(firstExport[1]).toContain(originals[1]);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);

  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  const restoredExport = await exportedText(page);
  expect(restoredExport).toEqual(firstExport);
});

test('reordering pages and editing a newly detected page keeps both text edits distinct', async ({ page }) => {
  await openSource(page);
  await editText(page, originals[0], 'First English replacement');
  await page.getByRole('button', { name: 'Move page 1 later', exact: true }).click();
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await expect(pageNumber).toHaveValue('2');
  await pageNumber.fill('1');
  await pageNumber.press('Enter');
  await expect(page.locator('.page-wrapper[data-page="1"]')).toBeVisible();
  await editText(page, originals[1], '第二页的新中文内容');

  const result = await exportedText(page);
  expect(result[0]).toContain('第二页的新中文内容');
  expect(result[0]).not.toContain(originals[1]);
  expect(result[0]).toContain('UNCHANGED OUTSIDE 2');
  expect(result[1]).toContain('First English replacement');
  expect(result[1]).not.toContain(originals[0]);
  expect(result[1]).toContain('UNCHANGED OUTSIDE 1');
});

test('applying content changes updates the reading page and supports undo and redo', async ({ page }) => {
  await openSource(page);
  const replacement = 'Applied replacement 中文';
  await editText(page, originals[0], replacement);
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText(replacement);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
  await expect(page.locator('.text-block')).toHaveCount(0);
  const applied = await exportedText(page);
  expect(applied[0]).toContain(replacement);
  expect(applied[0]).not.toContain(originals[0]);

  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.locator('.textLayer')).toContainText(originals[0]);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeVisible();
  expect(await exportedText(page)).toEqual(applied);

  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect(page.locator('.textLayer')).toContainText(replacement);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
});
