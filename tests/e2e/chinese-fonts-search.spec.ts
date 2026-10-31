import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page, rotated = false) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 600]);
  sheet.drawText('Original editable text', { x: 60, y: 480, size: 16 });
  sheet.drawText('Unchanged neighbor', { x: 60, y: 200, size: 12 });
  if (rotated) { sheet.setCropBox(20, 30, 440, 550); sheet.setRotation(degrees(90)); }
  await page.context().addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'chinese-edit.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
}
async function properties(page: Page) {
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click();
  await page.locator('.object-edit-box[data-object-kind="text"]').first().click();
  const panel = page.locator('.native-text-properties');
  await expect(panel.getByRole('combobox', { name: 'Text font', exact: true })).toBeEnabled();
  return panel;
}
async function replace(page: Page, text: string) {
  await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  await page.locator('.text-block').first().click();
  const editor = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await editor.fill(text);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
async function query(page: Page, text: string) {
  if (!await page.getByRole('search').count()) await page.keyboard.press('Control+f');
  const panel = page.getByRole('search');
  await panel.getByRole('textbox', { name: 'Search document text' }).fill(text);
  return panel.getByRole('status');
}
async function exportPDF(page: Page) {
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await download).path())!);
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), text = page.toStructuredText('');
  const names: string[] = [];
  try {
    text.walk({ onChar(character, _position, font) { try { if (character === '中') names.push(font.getName()); } finally { font.destroy(); } } });
    return { text: text.asText(), names };
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}

test('built-in Chinese font, live search, deletion, undo and redo use the current PDF', async ({ page }) => {
  await open(page);
  const panel = await properties(page);
  await panel.getByRole('combobox', { name: 'Text font' }).selectOption('zh-Hans');
  await expect(panel.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  await replace(page, '中文编辑 ABC 中文测试');
  await expect(await query(page, 'Original')).toHaveText('No matches found');
  await expect(await query(page, '中文')).toHaveText('1 of 2 matches');
  await expect(page.locator('.text-edit-preview-selection mark.search-highlight')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next search result' }).click();
  await expect(page.locator('.text-edit-preview-selection mark.active')).toHaveText('中文');
  await replace(page, '中文编辑 ABC');
  await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 1 matches');
  await page.locator('.workspace-history > button').nth(0).click();
  await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 2 matches');
  await page.locator('.workspace-history > button').nth(1).click();
  await expect(page.getByRole('search').getByRole('status')).toHaveText('1 of 1 matches');
  const bytes = await exportPDF(page), output = inspect(bytes);
  expect(output.text).toContain('中文编辑 ABC'); expect(output.text).not.toContain('Original'); expect(output.text).toContain('Unchanged neighbor');
  expect(output.names[0]).toContain('Droid');
  // A fresh document session searches exactly the text indexed before export.
  const reopened = await page.context().newPage(); await reopened.goto('./');
  await reopened.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'exported.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(reopened.locator('canvas.page-canvas')).toBeVisible();
  await expect(await query(reopened, '中文')).toHaveText('1 of 1 matches');
  await expect(await query(reopened, 'Original')).toHaveText('No matches found');
  await reopened.close();
});

test('local Chinese OTF is embedded, persists after reload and remains usable after library removal', async ({ page }) => {
  await open(page, true);
  let panel = await properties(page);
  await panel.getByRole('button', { name: 'Manage fonts…' }).click();
  let manager = page.getByRole('dialog', { name: 'Manage fonts…' });
  const desktopBounds = (await manager.boundingBox())!;
  expect(desktopBounds.x + desktopBounds.width / 2).toBeCloseTo(page.viewportSize()!.width / 2, 0);
  expect(desktopBounds.y + desktopBounds.height / 2).toBeCloseTo(page.viewportSize()!.height / 2, 0);
  await manager.locator('input[type=file]').setInputFiles(fileURLToPath(new URL('../fixtures/fonts/TestCJK.otf', import.meta.url)));
  await expect(manager.getByText('PDFEditorTestCJK', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Use font', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Text font' })).toHaveValue(/^custom:/);
  await replace(page, '中文字体编辑 ABC\n搜索测试，第二行。');
  await expect(await query(page, '搜索')).toHaveText('1 of 1 matches');
  const mark = page.locator('.text-edit-preview-selection mark.active'); await expect(mark).toHaveText('搜索');
  const canvas = (await page.locator('canvas.page-canvas').boundingBox())!, highlight = (await mark.boundingBox())!;
  expect(highlight.x).toBeGreaterThan(canvas.x); expect(highlight.x + highlight.width).toBeLessThan(canvas.x + canvas.width);
  expect(highlight.y).toBeGreaterThan(canvas.y); expect(highlight.y + highlight.height).toBeLessThan(canvas.y + canvas.height);
  const before = inspect(await exportPDF(page)); expect(before.names).toEqual(['PDFEditorTestCJK']);
  await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  panel = await properties(page); await expect(panel.getByRole('combobox', { name: 'Text font' })).toHaveValue(/^custom:/);
  await panel.getByRole('button', { name: 'Manage fonts…' }).click(); manager = page.getByRole('dialog', { name: 'Manage fonts…' });
  await manager.getByRole('button', { name: 'Remove PDFEditorTestCJK' }).click();
  await expect(manager.getByText('PDFEditorTestCJK', { exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: 'Close (Esc)' }).click();
  await expect(panel.getByRole('combobox', { name: 'Text font' })).toHaveValue(/^custom:/);
  expect(inspect(await exportPDF(page))).toEqual(before);
  await expect(await query(page, '中文')).toHaveText('1 of 1 matches');
  await page.screenshot({ path: test.info().outputPath('chinese-font-search-rotated.png') });
  const saved = await exportPDF(page); await writeFile(test.info().outputPath('custom-font.pdf'), saved);
  const reopened = await page.context().newPage(); await reopened.goto('./');
  await reopened.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'reopened.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(reopened.locator('canvas.page-canvas')).toBeVisible();
  await reopened.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  const expectedPDF = new mupdf.PDFDocument(saved), expectedPage = expectedPDF.loadPage(0);
  const expectedPixels = expectedPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  let expectedInk = 0;
  try { const pixels = expectedPixels.getPixels(); for (let index = 0; index < pixels.length; index += 3) if (pixels[index] < 200) expectedInk++; }
  finally { expectedPixels.destroy(); expectedPage.destroy(); expectedPDF.destroy(); }
  await expect.poll(async () => reopened.locator('canvas.page-canvas').evaluate(canvas => {
    const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0;
    for (let index = 0; index < image.length; index += 4) if (image[index] < 200 && image[index + 3] > 0) ink++;
    return ink;
  })).toBeGreaterThan(expectedInk * .8);
  await replace(reopened, '中文字体编辑 ABC\n搜索替换，第二行。');
  await expect(await query(reopened, '替换')).toHaveText('1 of 1 matches');
  const editedAgain = inspect(await exportPDF(reopened));
  expect(editedAgain.text).toContain('搜索替换，第二行。'); expect(editedAgain.names).toEqual(['PDFEditorTestCJK']);
  await reopened.close();
});

test('font import errors are localized and do not change the selected font', async ({ page }) => {
  await open(page); const panel = await properties(page);
  await panel.getByRole('button', { name: 'Manage fonts…' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage fonts…' });
  expect(await manager.evaluate(element => {
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(true);
  await manager.locator('input[type=file]').setInputFiles({ name: 'broken.ttf', mimeType: 'font/ttf', buffer: Buffer.from('broken') });
  await expect(manager.getByRole('alert')).toContainText('Choose a valid TTF or OTF');
  await manager.getByRole('button', { name: 'Close (Esc)' }).click();
  await expect(panel.getByRole('combobox', { name: 'Text font' })).toHaveValue('original');
  await page.getByRole('button', { name: 'Use Chinese', exact: true }).click();
  await panel.getByRole('button', { name: '管理字体…' }).click();
  const chinese = page.getByRole('dialog', { name: '管理字体…' });
  await chinese.locator('input[type=file]').setInputFiles({ name: 'broken.ttf', mimeType: 'font/ttf', buffer: Buffer.from('broken') });
  await expect(chinese.getByRole('alert')).toContainText('请选择有效的 TTF 或 OTF');
  await page.setViewportSize({ width: 390, height: 650 });
  const bounds = (await chinese.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(chinese.getByRole('button', { name: '关闭 (Esc)' })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('font-manager-mobile-zh.png') });
});

test('TTF selection inside the text-layout dialog survives draft save and export', async ({ page }) => {
  await open(page); const panel = await properties(page);
  await panel.getByRole('button', { name: 'Text layout…', exact: true }).click();
  const layout = page.getByRole('dialog', { name: 'Text layout', exact: true });
  await layout.getByRole('button', { name: 'Manage fonts…' }).click();
  const manager = page.getByRole('dialog', { name: 'Manage fonts…' });
  await manager.locator('input[type=file]').setInputFiles(fileURLToPath(new URL('../fixtures/fonts/TestCJK.ttf', import.meta.url)));
  await expect(manager.getByText('PDFEditorTestTTF', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Use font', exact: true }).click();
  await layout.getByRole('textbox', { name: 'Text', exact: true }).fill('中文编辑 ABC');
  await expect(layout.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  await layout.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(layout).toHaveCount(0);
  await expect(await query(page, '中文')).toHaveText('1 of 1 matches');
  const output = inspect(await exportPDF(page)); expect(output.text).toContain('中文编辑 ABC'); expect(output.names).toEqual(['PDFEditorTestTTF']);
});
