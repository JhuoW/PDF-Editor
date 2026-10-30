import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createOptimizationPDF } from '../fixtures/optimizationPDF';
import { CLEANUP_SECRETS, decodedPDFStrings } from '../fixtures/cleanupPDF';

async function open(page: Page) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'compression.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createOptimizationPDF()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toBeVisible();
}
async function dialog(page: Page) {
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Compress PDF…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Compress PDF', exact: true });
  await expect(panel.getByRole('button', { name: 'Compress PDF', exact: true })).toBeEnabled({ timeout: 30_000 });
  return panel;
}
async function compress(panel: Locator) {
  await panel.getByRole('button', { name: 'Compress PDF', exact: true }).click();
  await expect(panel.getByText('Compression ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  for (const preview of await panel.locator('.decoration-pdf-preview').filter({ visible: true }).all()) await expect(preview).toHaveAttribute('aria-busy', 'false');
}
async function download(page: Page, button: Locator) {
  const pending = page.waitForEvent('download', { timeout: 30_000 }); await button.click();
  const file = await pending; return { bytes: await readFile((await file.path())!), name: file.suggestedFilename() };
}
function text(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), content = page.toStructuredText('');
  try { return content.asText(); } finally { content.destroy(); page.destroy(); pdf.destroy(); }
}
function samePixels(source: Uint8Array, output: Uint8Array) {
  const before = new mupdf.PDFDocument(source), after = new mupdf.PDFDocument(output);
  try {
    expect(after.countPages()).toBe(before.countPages());
    for (let index = 0; index < before.countPages(); index++) {
      const first = before.loadPage(index), second = after.loadPage(index);
      const a = first.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true), b = second.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      try { expect(Buffer.from(a.getPixels()).equals(Buffer.from(b.getPixels()))).toBe(true); }
      finally { b.destroy(); a.destroy(); second.destroy(); first.destroy(); }
    }
  } finally { after.destroy(); before.destroy(); }
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('compresses current edits losslessly with real previews, editable forms, native data and an unchanged workspace', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Compression 中文 field');
  await page.getByRole('button', { name: 'All tools' }).click(); await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original body text' }).dblclick();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ }); await editor.fill('Updated body'); await editor.press('Control+Enter');
  await page.getByTitle('Select (V)', { exact: true }).click();
  const expected = (await download(page, page.getByRole('button', { name: 'Export', exact: true }))).bytes;
  const panel = await dialog(page); await compress(panel);
  await expect(panel.getByText(/% smaller|No size reduction with these settings/)).toBeVisible();
  await panel.getByRole('combobox', { name: 'Preview page', exact: true }).selectOption('2');
  for (const preview of await panel.locator('.decoration-pdf-preview').filter({ visible: true }).all()) await expect(preview).toHaveAttribute('aria-busy', 'false');
  await panel.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('2');
  for (const canvas of await panel.locator('.decoration-pdf-preview canvas').filter({ visible: true }).all()) await expect(canvas).toHaveCSS('width', '800px');
  await panel.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('fit');
  await panel.getByRole('combobox', { name: 'Preview page', exact: true }).selectOption('1');
  for (const preview of await panel.locator('.decoration-pdf-preview').filter({ visible: true }).all()) await expect(preview).toHaveAttribute('aria-busy', 'false');
  expect(await panel.locator('.decoration-pdf-preview canvas').evaluateAll(canvases => {
    const [a, b] = canvases as HTMLCanvasElement[];
    return a.style.width === b.style.width && a.style.height === b.style.height && a.toDataURL() === b.toDataURL();
  })).toBe(true);
  await page.screenshot({ path: test.info().outputPath('compression-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole('button', { name: 'Current', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Current PDF preview', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Compressed', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Download PDF', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('compression-narrow.png') });
  const saved = await download(page, panel.getByRole('button', { name: 'Download PDF', exact: true }));
  expect(saved.name).toBe('compression-compressed.pdf'); expect(saved.bytes.length).toBeLessThanOrEqual(expected.length);
  samePixels(expected, saved.bytes);
  const output = await PDFDocument.load(saved.bytes, { updateMetadata: false });
  expect(output.getForm().getTextField('Contact').getText()).toBe('Compression 中文 field');
  const strings = await decodedPDFStrings(saved.bytes);
  for (const retained of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.metadata, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.comment, CLEANUP_SECRETS.defaultValue, CLEANUP_SECRETS.script,
    'Second page bookmark', 'https://example.com/review']) expect(strings).toContain(retained);
  expect(text(saved.bytes)).toContain('Updated body'); expect(text(saved.bytes)).not.toContain('Original body text');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Compression 中文 field');
  await expect(page.getByRole('button', { name: /Undo Compress/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  samePixels(expected, (await download(page, page.getByRole('button', { name: 'Export', exact: true }))).bytes);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: saved.name, mimeType: 'application/pdf', buffer: saved.bytes });
  await page.getByRole('dialog', { name: 'Save changes?', exact: true }).getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect(page.locator('.document-title')).toHaveText(saved.name);
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Compression 中文 field');
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Still editable');
  expect((await PDFDocument.load((await download(page, page.getByRole('button', { name: 'Export', exact: true }))).bytes)).getForm().getTextField('Contact').getText()).toBe('Still editable');
});

test('downsamples only the image, retains text and fields, invalidates old results and cancels the worker without downloading', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page); const panel = await dialog(page);
  await panel.getByRole('radio', { name: 'Optimize images', exact: true }).check();
  await panel.getByRole('combobox', { name: 'Image resolution', exact: true }).selectOption('150');
  await compress(panel);
  const saved = await download(page, panel.getByRole('button', { name: 'Download PDF', exact: true }));
  const output = await PDFDocument.load(saved.bytes, { updateMetadata: false });
  const images = output.context.enumerateIndirectObjects().map(([, object]) => object).filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  expect(images.some(image => image.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber() === 450 && image.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber() === 300
    && image.dict.get(PDFName.of('Filter')) === PDFName.of('DCTDecode'))).toBe(true);
  expect(output.getPageCount()).toBe(2); expect(output.getForm().getTextField('Contact').getText()).toBe(CLEANUP_SECRETS.form);
  expect(text(saved.bytes)).toContain('Original body text');
  await panel.getByRole('combobox', { name: 'Image resolution', exact: true }).selectOption('200');
  await expect(panel.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/*mupdf*.wasm*', async route => { await held; await route.abort().catch(() => {}); });
  try {
    const requested = page.waitForRequest('**/*mupdf*.wasm*');
    await panel.getByRole('button', { name: 'Compress PDF', exact: true }).click(); await requested;
    await panel.getByRole('button', { name: 'Cancel compression', exact: true }).click();
    await expect(panel.getByText('Compression canceled. No file was downloaded.', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
    expect(downloads).toEqual([]);
  } finally { release(); await page.unroute('**/*mupdf*.wasm*'); }
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue(CLEANUP_SECRETS.form);
  await expect(page.getByRole('button', { name: /Undo Compress/ })).toHaveCount(0);
});
