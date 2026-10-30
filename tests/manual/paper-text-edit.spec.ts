import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import * as mupdf from 'mupdf';

// Source: https://jmlr.org/papers/volume15/srivastava14a/srivastava14a.pdf
// This suite is opt-in and uses an external, unchanged 30-page research paper.
const paperPath = process.env.PDF_EDITOR_PAPER_PATH;
if (!paperPath) throw new Error('Set PDF_EDITOR_PAPER_PATH to the downloaded JMLR Dropout paper.');
const source = await readFile(paperPath);
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== '9c196ccbe6c6a595a1adba6cd030d35f7c2e548bbf5e7f1278b0109d8dd9ebaa') {
  throw new Error('The paper differs from the reviewed source. Check its URL and SHA-256 before running this fixture.');
}
type Rect = { x: number; y: number; width: number; height: number };
const normalized = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
function documentText(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes);
  try { return Array.from({ length: document.countPages() }, (_, index) => {
    const page = document.loadPage(index), content = page.toStructuredText('');
    try { return content.asText(); } finally { content.destroy(); page.destroy(); }
  }); } finally { document.destroy(); }
}
const originalText = documentText(source);
function render(bytes: Uint8Array, pageNumber: number) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(pageNumber - 1);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return { pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth(), height: pixmap.getHeight(), stride: pixmap.getStride() }; }
  finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}
function unchangedOutside(bytes: Uint8Array, pageNumber: number, rect: Rect) {
  const before = render(source, pageNumber), after = render(bytes, pageNumber);
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  let outsidePixelsChanged = 0, insidePixelsChanged = 0;
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const i = y * before.stride + x * 3;
    if (![0, 1, 2].some(channel => before.pixels[i + channel] !== after.pixels[i + channel])) continue;
    // Allow glyph antialiasing/descenders at the boundary of the source region.
    if (x < rect.x - 3 || x > rect.x + rect.width + 3 || y < rect.y - 3 || y > rect.y + rect.height + 3) outsidePixelsChanged++;
    else insidePixelsChanged++;
  }
  expect(outsidePixelsChanged, 'Neighboring text and figures must remain pixel-identical').toBe(0);
  expect(insidePixelsChanged).toBeGreaterThan(0);
  const outputText = documentText(bytes);
  expect(outputText).toHaveLength(30);
  for (let index = 0; index < outputText.length; index++) if (index !== pageNumber - 1) expect(outputText[index]).toBe(originalText[index]);
  const neighbor = pageNumber === 1 ? 2 : 1;
  expect(Buffer.from(render(bytes, neighbor).pixels)).toEqual(Buffer.from(render(source, neighbor).pixels));
  return { outsidePixelsChanged, insidePixelsChanged, unchangedTextPages: 29 };
}
async function openPaper(page: Page, pageNumber = 1) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles(paperPath!);
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  if (pageNumber !== 1) {
    const input = page.getByRole('spinbutton', { name: 'Page number', exact: true });
    await input.fill(String(pageNumber)); await input.press('Enter');
    await expect(page.locator(`.page-wrapper[data-page="${pageNumber}"] canvas.page-canvas`)).toBeVisible();
  }
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await expect(page.locator('.text-block').first()).toBeVisible();
}
async function sourceRect(block: Locator): Promise<Rect> {
  return block.evaluate(element => ({ x: parseFloat((element as HTMLElement).style.left), y: parseFloat((element as HTMLElement).style.top), width: parseFloat((element as HTMLElement).style.width), height: parseFloat((element as HTMLElement).style.height) }));
}
async function exported(page: Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending, path = test.info().outputPath(name);
  await download.saveAs(path); return readFile(path);
}
async function noErrors(page: Page) { await expect(page.getByRole('alert')).toHaveCount(0); }

test('edits a real abstract without merging its heading or changing other pages, and restores history after refresh', async ({ page }) => {
  await openPaper(page);
  const block = page.locator('.text-block').filter({ hasText: 'Deep neural nets' });
  await expect(block).toHaveCount(1);
  const before = await block.textContent();
  expect(before).not.toContain('Abstract'); expect(before).not.toContain('Keywords');
  const rect = await sourceRect(block);
  await block.click();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ });
  const original = await editor.inputValue(), replacement = original.replace('Deep neural nets', 'Deep neural models');
  expect(replacement).not.toBe(original);
  await editor.fill(replacement); await editor.press('Control+Enter');
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0, { timeout: 30_000 });
  await noErrors(page);
  const output = await exported(page, 'abstract-edited.pdf');
  expect(normalized(documentText(output)[0])).toContain(normalized(replacement));
  expect(normalized(documentText(output)[0])).not.toContain(normalized('Deep neural nets'));
  const metrics = unchangedOutside(output, 1, rect);
  await test.info().attach('pixel-check', { body: JSON.stringify(metrics), contentType: 'application/json' });
  await page.screenshot({ path: test.info().outputPath('abstract-applied.png') });
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.locator('.textLayer')).toContainText('Deep neural nets');
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Undo/ }).click();
  expect(documentText(await exported(page, 'abstract-undone.pdf'))).toEqual(originalText);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(documentText(await exported(page, 'abstract-redone.pdf'))).toEqual(documentText(output));
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  expect(documentText(await exported(page, 'abstract-restored.pdf'))).toEqual(documentText(output));
});

test('fits longer English and Chinese text in the real abstract, with explicit overflow handling and cancellation', async ({ page }) => {
  await openPaper(page);
  const block = page.locator('.text-block').filter({ hasText: 'Deep neural nets' }), rect = await sourceRect(block);
  await block.click();
  const original = await page.getByRole('textbox', { name: /^Edit text on page/ }).inputValue();
  await page.getByRole('button', { name: 'Text layout…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Text layout', exact: true });
  const replacement = original.replace('Deep neural nets', 'Edited neural models') + '\n' + 'This added research note verifies longer paragraphs and explicit line wrapping. 中文编辑测试，文字必须完整保留。 '.repeat(5);
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill(replacement);
  await expect(panel.getByRole('alert')).toContainText(/no text was truncated|needs|wider than/);
  await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Shrink font to fit', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Shrink font to fit', exact: true }).click();
  await expect(panel.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: test.info().outputPath('long-paragraph-preview.png') });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(documentText(await exported(page, 'layout-cancelled.pdf'))).toEqual(originalText);
  await block.click();
  await page.getByRole('button', { name: 'Text layout…', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill(replacement);
  await expect(panel.getByRole('button', { name: 'Shrink font to fit', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Shrink font to fit', exact: true }).click();
  await expect(panel.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  const result = await exported(page, 'long-paragraph-edited.pdf');
  expect(normalized(documentText(result)[0])).toContain(normalized(replacement));
  unchangedOutside(result, 1, rect);
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0, { timeout: 30_000 });
  expect(documentText(await exported(page, 'long-paragraph-applied.pdf'))).toEqual(documentText(result));
});

test('edits a figure caption without changing the adjacent neural-network drawing', async ({ page }) => {
  await openPaper(page, 2);
  const block = page.locator('.text-block').filter({ hasText: 'An example of a thinned net' });
  await expect(block).toHaveCount(1);
  const rect = await sourceRect(block);
  await block.click();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ });
  const replacement = (await editor.inputValue()).replace('thinned net', 'thinned model');
  await editor.fill(replacement); await editor.press('Control+Enter');
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0, { timeout: 30_000 });
  await noErrors(page);
  const output = await exported(page, 'caption-edited.pdf');
  expect(normalized(documentText(output)[1])).toContain(normalized(replacement));
  unchangedOutside(output, 2, rect);
  await page.screenshot({ path: test.info().outputPath('caption-applied.png') });
});

test('keeps the two-line title separate from authors and supports cancelling and applying title edits', async ({ page }) => {
  await openPaper(page);
  const block = page.locator('.text-block').filter({ hasText: 'A Simple Way to Prevent' });
  await expect(block).toHaveCount(1);
  const original = (await block.textContent())!;
  expect(original.split('\n')).toHaveLength(2);
  expect(original).not.toContain('@');
  const rect = await sourceRect(block);
  await block.click();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ });
  await editor.fill('This cancelled title must never reach the PDF');
  await editor.press('Escape');
  expect(documentText(await exported(page, 'title-cancelled.pdf'))).toEqual(originalText);
  await block.click();
  const replacement = original.replace('Overfitting', 'Overtraining');
  expect(replacement).not.toBe(original);
  await editor.fill(replacement); await editor.press('Control+Enter');
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0, { timeout: 30_000 });
  await noErrors(page);
  const output = await exported(page, 'title-edited.pdf');
  expect(normalized(documentText(output)[0])).toContain(normalized(replacement));
  unchangedOutside(output, 1, rect);
  await page.screenshot({ path: test.info().outputPath('title-applied.png') });
});
