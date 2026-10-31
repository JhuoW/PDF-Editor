import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page, readonlyPage = false) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 500]).drawText('Original text', { x: 40, y: 400, size: 16 });
  if (readonlyPage) pdf.addPage([400, 500]).drawText('Rotated region', { x: 100, y: 100, size: 16, rotate: degrees(90) });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'reliability.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
}
async function edit(page: Page, replacement: string) {
  await page.locator('.workspace-ribbon').getByRole('button', { name: 'Edit text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original text' }).click();
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await input.fill(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
}
async function exportText(page: Page) {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await downloading).createReadStream(), parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  const pdf = new mupdf.PDFDocument(Buffer.concat(parts)), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
}

test('checks every page and locates a read-only region, with live bilingual report labels', async ({ page }) => {
  await open(page, true);
  await page.getByRole('button', { name: 'Check text', exact: true }).click();
  const dialog = page.locator('.text-check-dialog');
  await expect(dialog.locator('.text-check-issues')).toContainText('Page 2');
  await expect(dialog.locator('.text-check-issues')).toContainText('For review');
  await dialog.locator('.language-switcher [lang=zh-CN]').click();
  await expect(dialog).toContainText('第 2 页'); await expect(dialog).toContainText('供参考');
  await dialog.getByRole('button', { name: '定位到区域', exact: true }).first().click();
  await expect(page.locator('.text-check-dialog')).toHaveCount(0);
  await expect(page.locator('.document-statusbar input[type=number]')).toHaveValue('2');
  await expect(page.locator('.text-block.readonly').first()).toBeVisible();
});

test('shows original and replacement font information without changing the edited wording', async ({ page }) => {
  await open(page); await edit(page, 'Updated 中文');
  const details = page.getByLabel('Font details', { exact: true });
  await expect(details).toContainText('Helvetica');
  await expect(details).toContainText('Some characters use a substitute font');
  for (const label of await details.locator('dt').all()) {
    const bounds = await label.boundingBox();
    expect(bounds!.width).toBeGreaterThan(100); expect(bounds!.height).toBeLessThan(40);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await exportText(page)).toContain('Updated 中文');
});

test('cancels an export worker without downloading or losing edits, then exports successfully', async ({ page }) => {
  await open(page); await edit(page, 'Keep this edit');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  let stalled = false, downloads = 0;
  page.on('download', () => downloads++);
  await page.route(/PDFExport\.worker/, async route => {
    if (stalled) return route.continue();
    stalled = true;
    await route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage = () => self.postMessage({type:"progress",progress:{stage:"text",progress:0.55}});' });
  });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Preparing PDF', exact: true });
  await expect(progress).toBeVisible();
  await progress.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(progress).toHaveCount(0); expect(downloads).toBe(0);
  await expect(page.locator('.error-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled();
  expect(await exportText(page)).toContain('Keep this edit');
  expect(downloads).toBe(1);
});

test('cancels PDF preparation from the page export dialog without a second modal and can retry', async ({ page }) => {
  await open(page); await edit(page, 'Keep page export edits');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  let started = false, downloads = 0;
  page.on('download', () => downloads++);
  await page.route(/PDFExport\.worker/, async route => {
    started = true;
    await route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage=()=>self.postMessage({type:"progress",progress:{stage:"text",progress:0.55}});' });
  });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Export Pages…', exact: true }).click();
  await page.getByRole('button', { name: 'Export pages', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(downloads).toBe(0);
  await expect(page.locator('.error-state')).toHaveCount(0);
  await page.unroute(/PDFExport\.worker/);
  expect(await exportText(page)).toContain('Keep page export edits');
});

test('retains an unexpected worker error in Chinese diagnostics and recovers on the next export', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await page.route(/PDFExport\.worker/, route => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage=()=>self.postMessage({type:"error",message:"Unexpected font object X-987"});' }));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('.error-state')).toBeVisible();
  await page.locator('.main-toolbar .language-switcher [lang=zh-CN]').click();
  await expect(page.locator('.error-state .diagnostic-summary')).not.toContainText('X-987');
  await page.locator('.error-state').getByRole('button', { name: '技术详情', exact: true }).click();
  await expect(page.locator('.error-state code')).toContainText('Unexpected font object X-987');
  await page.locator('.error-state').getByRole('button', { name: '复制诊断信息', exact: true }).click();
  await expect(page.locator('.error-state')).toContainText('诊断信息已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Unexpected font object X-987');
  await page.unroute(/PDFExport\.worker/);
  await page.locator('.main-toolbar .language-switcher [lang=en]').click();
  expect(await exportText(page)).toContain('Original text');
  await expect(page.locator('.error-state')).toHaveCount(0);
});

test('lists a pending overflowing edit and opens its layout controls from the report', async ({ page }) => {
  await open(page); await edit(page, 'Longer replacement text. '.repeat(150));
  await expect(page.locator('.text-edit-notice')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Check text', exact: true }).click();
  const report = page.locator('.text-check-dialog');
  await expect(report.locator('.text-check-blocking')).toContainText('Fix before exporting');
  await report.getByRole('button', { name: 'Go to region', exact: true }).first().click();
  await expect(report).toHaveCount(0);
  await expect(page.locator('.text-layout-dialog')).toBeVisible();
});

test('limits backing pixels for large PDF and annotation canvases while retaining page coordinates', async ({ page }) => {
  const pdf = await PDFDocument.create(); pdf.addPage([12000, 1200]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'wide-page.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('4');
  await expect(page.locator('canvas.page-canvas')).toHaveCSS('width', '48000px');
  for (const selector of ['canvas.page-canvas', 'canvas.annotation-canvas']) {
    await expect.poll(() => page.locator(selector).evaluate((canvas: HTMLCanvasElement) => ({ dimension: Math.max(canvas.width, canvas.height), pixels: canvas.width * canvas.height })))
      .toEqual({ dimension: 8192, pixels: 8192 * 819 });
  }
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
});
