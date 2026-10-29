import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { CLEANUP_SECRETS, createCleanupPDF, decodedPDFStrings } from '../fixtures/cleanupPDF';
import { inspectPDFCleanup } from '../../src/core/DocumentCleanup';

async function open(page: Page) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'cleanup.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createCleanupPDF()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toBeVisible();
}
async function dialog(page: Page) {
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: 'Clean Document…', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Clean Document', exact: true });
  await expect(result.getByRole('checkbox', { name: 'Document metadata', exact: true })).toBeVisible();
  return result;
}
async function ready(panel: Locator) {
  await expect(panel.getByText('Cleanup preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.decoration-pdf-preview').filter({ visible: true })).toHaveAttribute('aria-busy', 'false');
}
async function apply(panel: Locator) {
  await panel.getByRole('button', { name: 'Apply cleanup', exact: true }).click();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
}
async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await pending).path())!);
}
function text(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), content = page.toStructuredText('');
  try { return content.asText(); } finally { content.destroy(); page.destroy(); pdf.destroy(); }
}

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('reviews and removes selected data with current text/forms, native and working notes, and undo across refresh', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Current 中文 value');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click(); await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original body text' }).dblclick();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ }); await editor.fill('Updated body'); await editor.press('Enter');
  await page.getByTitle('Select (V)', { exact: true }).click();
  const panel = await dialog(page);
  await expect(panel.getByRole('checkbox', { name: 'Comments and annotations', exact: true })).toBeEnabled();
  await panel.getByRole('checkbox', { name: 'Comments and annotations', exact: true }).check();
  await ready(panel);
  await panel.getByRole('button', { name: 'Current', exact: true }).click();
  await expect(panel.getByText('Current document preview', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'After cleanup', exact: true }).click(); await ready(panel);
  await page.screenshot({ path: test.info().outputPath('cleanup-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('checkbox', { name: 'Comments and annotations', exact: true }).scrollIntoViewIfNeeded();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: 'Apply cleanup', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('cleanup-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 }); await apply(panel);
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Current 中文 value');
  const bytes = await download(page), strings = await decodedPDFStrings(bytes);
  for (const secret of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.metadata, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.script, CLEANUP_SECRETS.comment]) expect(strings).not.toContain(secret);
  expect(text(bytes)).toContain('Updated body'); expect(text(bytes)).not.toContain('Original body text');
  const report = await inspectPDFCleanup(new Uint8Array(bytes).buffer);
  for (const category of ['metadata', 'attachments', 'activeContent', 'comments'] as const) expect(report.counts[category]).toBe(0);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Undo Clean document', exact: true }).click();
  const undone = await decodedPDFStrings(await download(page));
  for (const secret of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.script, CLEANUP_SECRETS.comment]) expect(undone).toContain(secret);
  await page.getByRole('button', { name: 'Redo Clean document', exact: true }).click();
  expect(await decodedPDFStrings(await download(page))).not.toContain(CLEANUP_SECRETS.author);
});

test('removes form values, defaults, comments and links as an explicit selection while preserving page text', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Draft field value');
  const panel = await dialog(page);
  for (const label of ['Form fields and values', 'Comments and annotations', 'Links']) await panel.getByRole('checkbox', { name: label, exact: true }).check();
  await ready(panel); await apply(panel);
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveCount(0);
  const bytes = await download(page), pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.catalog.has(PDFName.of('AcroForm'))).toBe(false);
  const strings = await decodedPDFStrings(bytes);
  for (const secret of [...Object.values(CLEANUP_SECRETS), 'Draft field value', 'https://example.com/review']) expect(strings).not.toContain(secret);
  expect(text(bytes)).toContain('Original body text');
  await page.getByRole('button', { name: 'Undo Clean document', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Draft field value');
});

test('downloads only current visible page images with no source structures, and cancels generation without changing the workspace', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Visible 中文 value');
  const expected = await download(page);
  const panel = await dialog(page);
  await panel.getByRole('tab', { name: 'Save visible copy', exact: true }).click();
  await expect(panel.getByText('Visible copy preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.decoration-pdf-preview').filter({ visible: true })).toHaveAttribute('aria-busy', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('textbox', { name: 'PDF file name', exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole('button', { name: 'Download image-only PDF', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('visible-copy-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  const downloadReady = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download image-only PDF', exact: true }).click();
  const saved = await downloadReady; expect(saved.suggestedFilename()).toBe('cleanup-visible-copy.pdf');
  const bytes = await readFile((await saved.path())!), strings = await decodedPDFStrings(bytes);
  for (const secret of [...Object.values(CLEANUP_SECRETS), 'Visible 中文 value', 'Original body text']) expect(strings).not.toContain(secret);
  expect(text(bytes).trim()).toBe('');
  const original = new mupdf.PDFDocument(expected), copied = new mupdf.PDFDocument(bytes);
  try {
    expect(copied.countPages()).toBe(2);
    for (let index = 0; index < 2; index++) {
      const source = original.loadPage(index), output = copied.loadPage(index);
      const a = source.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
      const b = output.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
      try { expect(Buffer.from(b.getPixels()).equals(Buffer.from(a.getPixels()))).toBe(true); }
      finally { b.destroy(); a.destroy(); output.destroy(); source.destroy(); }
    }
  } finally { copied.destroy(); original.destroy(); }
  await expect(panel.getByText(/Downloaded 2 pages/)).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = []; page.on('download', item => requests.push(item.suggestedFilename()));
  await page.route('**/*mupdf*.wasm*', async route => { await held; await route.abort().catch(() => {}); });
  try {
    const loading = page.waitForRequest('**/*mupdf*.wasm*');
    await panel.getByRole('button', { name: 'Download image-only PDF', exact: true }).click(); await loading;
    await panel.getByRole('button', { name: 'Cancel generation', exact: true }).click();
    await expect(panel.getByText('Generation canceled. No file was downloaded.', { exact: true })).toBeVisible();
    expect(requests).toEqual([]);
  } finally { release(); await page.unroute('**/*mupdf*.wasm*'); }
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Visible 中文 value');
  await expect(page.getByRole('button', { name: 'Undo Clean document', exact: true })).toHaveCount(0);
  expect(await decodedPDFStrings(await download(page))).toContain(CLEANUP_SECRETS.author);
});
