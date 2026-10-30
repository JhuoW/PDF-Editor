import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createTextLayoutPDF, LAYOUT_ORIGINAL, LAYOUT_NEIGHBOR } from '../fixtures/textLayoutPDF';

const replacement = 'A longer paragraph with 中文内容 that wraps into several lines and is saved in full. 第二行也必须完整保留。';
async function open(page: Page) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'layout.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createTextLayoutPDF()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}
async function layout(page: Page, text: string) {
  if (!await page.locator('.text-edit-layer').count()) {
    await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
    await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  }
  await page.locator('.text-block').filter({ hasText: text }).dblclick();
  await page.getByRole('button', { name: 'Text layout…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Text layout', exact: true });
  await expect(panel.getByRole('textbox', { name: 'Text', exact: true })).toBeVisible();
  return panel;
}
async function ready(panel: Locator) {
  await expect(panel.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.text-layout-preview')).toHaveAttribute('aria-busy', 'false');
  await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await pending).path())!);
}
function text(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes);
  try { return Array.from({ length: document.countPages() }, (_, index) => {
    const page = document.loadPage(index), content = page.toStructuredText('');
    try { return content.asText(); } finally { content.destroy(); page.destroy(); }
  }); } finally { document.destroy(); }
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('reflows a longer Unicode paragraph, preserves neighbors and forms, and restores layout through undo, refresh and apply', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Current layout form draft');
  const panel = await layout(page, LAYOUT_ORIGINAL);
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill(replacement);
  await expect(panel.getByRole('alert')).toContainText(/no text was truncated|needs|wider than/);
  await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  for (const [name, value] of [['X', '35'], ['Y', '210'], ['Width', '300'], ['Height', '110'], ['Font size', '16'], ['Line spacing', '1.4']]) {
    await panel.getByRole('spinbutton', { name, exact: true }).fill(value);
    await panel.getByRole('spinbutton', { name, exact: true }).press('Tab');
  }
  await panel.getByRole('combobox', { name: 'Alignment', exact: true }).selectOption('justify');
  await ready(panel);
  await page.screenshot({ path: test.info().outputPath('text-layout-desktop.png') });
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Undo Change text layout/ })).toBeEnabled();
  const result = await exported(page), output = text(result);
  expect(output[0].replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  expect(output[0]).not.toContain(LAYOUT_ORIGINAL); expect(output[0]).toContain(LAYOUT_NEIGHBOR);
  expect(output[1]).toContain('Second page remains unchanged');
  expect((await PDFDocument.load(result)).getForm().getTextField('Contact').getText()).toBe('Current layout form draft');
  await page.getByRole('button', { name: /^Undo/ }).click();
  expect(text(await exported(page))[0]).toContain(LAYOUT_ORIGINAL);
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(text(await exported(page))).toEqual(output);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  expect(text(await exported(page))).toEqual(output);
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
  expect(text(await exported(page))).toEqual(output);
});

test('fits overflow explicitly, supports narrow screens and discards or resets layout drafts', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  let panel = await layout(page, LAYOUT_ORIGINAL);
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill('Longer text needs a smaller font');
  await expect(panel.getByRole('button', { name: 'Shrink font to fit', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Shrink font to fit', exact: true }).click();
  await ready(panel);
  expect(Number(await panel.getByRole('spinbutton', { name: 'Font size', exact: true }).inputValue())).toBeLessThan(12);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(text(await exported(page))[0]).toContain(LAYOUT_ORIGINAL);
  await expect(page.getByRole('button', { name: /Undo Change text layout/ })).toHaveCount(0);
  panel = await layout(page, LAYOUT_ORIGINAL);
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill('A longer paragraph that fits after the area grows');
  await panel.getByRole('spinbutton', { name: 'Width', exact: true }).fill('240');
  await panel.getByRole('spinbutton', { name: 'Width', exact: true }).press('Tab');
  await expect(panel.getByRole('button', { name: 'Fit height', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Fit height', exact: true }).click();
  await ready(panel);
  const x = Number(await panel.getByRole('spinbutton', { name: 'X', exact: true }).inputValue());
  const area = await panel.getByRole('button', { name: 'Move text area', exact: true }).boundingBox();
  expect(area).not.toBeNull();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
  await page.mouse.down(); await page.mouse.move(area!.x + area!.width / 2 + 30, area!.y + area!.height / 2 + 40, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await panel.getByRole('spinbutton', { name: 'X', exact: true }).inputValue())).toBeGreaterThan(x);
  await ready(panel);
  const corner = await panel.getByRole('button', { name: 'Resize text area', exact: true }).boundingBox();
  await page.mouse.move(corner!.x + corner!.width / 2, corner!.y + corner!.height / 2);
  await page.mouse.down(); await page.mouse.move(corner!.x + corner!.width / 2 + 25, corner!.y + corner!.height / 2 + 30, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await panel.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue())).toBeGreaterThan(240);
  await ready(panel);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('text-layout-narrow.png') });
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  panel = await layout(page, 'A longer paragraph that fits after the area grows');
  await panel.getByRole('button', { name: 'Reset to original', exact: true }).click();
  await ready(panel);
  await expect(panel.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue(LAYOUT_ORIGINAL);
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  expect(text(await exported(page))[0]).toContain(LAYOUT_ORIGINAL);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeDisabled();
});
