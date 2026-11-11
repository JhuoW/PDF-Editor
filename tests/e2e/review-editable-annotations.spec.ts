import { revealPDFRegion } from './pdf-region';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page, bytes?: Uint8Array) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pdf = await PDFDocument.create(); pdf.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'editable-annotations.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes ?? await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function output(page: Page, action: 'Save' | 'Export' = 'Export') {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  return readFile((await (await ready).path())!);
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), display = page.toDisplayList(true), text = display.toStructuredText('');
  const glyphs: Array<{ character: string; font: string; size: number; color: number[]; quad: number[] }> = [];
  try {
    text.walk({ onChar(character, _origin, font, size, quad, color) { glyphs.push({ character, font: font.getName(), size, color: [...color], quad: [...quad] }); } });
    return { text: text.asText(), glyphs };
  } finally { text.destroy(); display.destroy(); page.destroy(); pdf.destroy(); }
}
async function createBox(page: Page) {
  await page.locator('.quick-tools').getByTitle('Text Box', { exact: true }).click();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 80); await page.mouse.down(); await page.mouse.move(box.x + 290, box.y + 110, { steps: 5 }); await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable=true]'); await expect(editor).toBeVisible(); return editor;
}

test('Chinese mixed-format text expands, saves as a native editable annotation and reopens without duplicates', async ({ page, context }, testInfo) => {
  await open(page);
  const editor = await createBox(page);
  await editor.evaluate(element => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>中文 English <strong><span style="font-size:22px;color:#ff0000">BOLD</span></strong></p><p>第二行：自动换行以及中英文混排，保留全部文字，不缩小字体。</p>');
    data.setData('text/plain', '中文 English BOLD\n第二行：自动换行以及中英文混排，保留全部文字，不缩小字体。');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(editor).toContainText('第二行');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.drawing-annotation-layer')).toHaveAttribute('data-text-preview-ready', '1');
  await page.keyboard.press('Escape');
  await testInfo.attach('Chinese rich text preview', { body: await page.locator('canvas.annotation-canvas').screenshot(), contentType: 'image/png' });
  const saved = await output(page, 'Save');
  await testInfo.attach('Saved native Chinese rich text', { body: saved, contentType: 'application/pdf' });
  const document = await PDFDocument.load(saved), annotations = document.getPage(0).node.Annots()!;
  expect(annotations.size()).toBe(1);
  expect(annotations.lookup(0, PDFDict).lookup(PDFName.of('Subtype'))).toBe(PDFName.of('FreeText'));
  const contents = annotations.lookup(0, PDFDict).lookup(PDFName.of('Contents'), PDFHexString).decodeText();
  expect(contents).toContain('保留全部文字，不缩小字体。');
  const first = inspect(saved);
  expect(first.text.replace(/\s/g, '')).toBe(contents.replace(/\s/g, ''));
  const bold = first.glyphs.filter(glyph => 'BOLD'.includes(glyph.character) && glyph.size > 20);
  expect(bold).toHaveLength(4);
  for (const glyph of bold) { expect(glyph.font).toMatch(/Bold/); expect(glyph.size).toBeCloseTo(22); expect(glyph.color).toEqual([1, 0, 0]); }
  expect(Math.max(...first.glyphs.flatMap(glyph => [glyph.quad[5], glyph.quad[7]]))).toBeGreaterThan(110);

  await page.keyboard.press('Control+f');
  const search = page.getByRole('search', { name: 'Document search' });
  await search.getByRole('textbox', { name: 'Search document text' }).fill('第二行');
  await expect(search.getByRole('status')).toHaveText('1 of 1 matches');
  await page.keyboard.press('Escape');
  const reopened = await context.newPage(); await open(reopened, saved);
  await expect(reopened.locator('.annotation-hit-regions rect')).toHaveCount(1);
  await expect(reopened.locator('.drawing-annotation-layer')).toHaveAttribute('data-text-preview-ready', '1');
  const beforeEdit = inspect(await output(reopened)); expect(beforeEdit.text).toBe(first.text);
  const box = (await reopened.locator('canvas.page-canvas').boundingBox())!;
  await reopened.mouse.dblclick(box.x + 70, box.y + 100);
  const active = reopened.locator('.tiptap-editor-content[contenteditable=true]'); await expect(active).toContainText('BOLD');
  await active.fill('再次编辑 Reopened');
  await reopened.getByTitle('Select (V)', { exact: true }).click();
  const second = await output(reopened);
  await testInfo.attach('Reopened and edited Chinese text', { body: second, contentType: 'application/pdf' });
  const result = inspect(second);
  expect(result.text.trim()).toBe('再次编辑 Reopened'); expect(result.text).not.toContain('BOLD');
  expect((await PDFDocument.load(second)).getPage(0).node.Annots()!.size()).toBe(1);
  await reopened.close();
});

test('an expanding box reports a page boundary during editing and recovers when excess lines are deleted', async ({ page }) => {
  await open(page);
  const editor = await createBox(page);
  await editor.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n'));
  await expect(page.locator('.freetext-preview-notice')).toContainText('Text exceeds the page height');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const error = page.locator('.error-state');
  await expect(error).toContainText('Text exceeds the page height');
  await expect(error.getByRole('button', { name: 'Check text', exact: true })).toHaveCount(0);
  await error.getByRole('button', { name: 'Locate annotation', exact: true }).click();
  await expect(error).toHaveCount(0);
  // Keep every line, correct the cause by reducing content as an explicit user edit.
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.dblclick(box.x + 70, box.y + 100);
  const active = page.locator('.tiptap-editor-content[contenteditable=true]'); await expect(active).toBeVisible();
  await active.fill('Corrected 中文'); await expect(active).toHaveText('Corrected 中文'); await page.getByTitle('Select (V)', { exact: true }).click();
  // A previously expanded box may retain its height; resizing via the property
  // controls is tested elsewhere. Export must use the actual content extent.
  const bytes = await output(page);
  expect(inspect(bytes).text.trim()).toBe('Corrected 中文');
});

for (const rotation of [90, 270]) test(`selected highlight keeps its location through CropBox, UserUnit and rotation ${rotation}`, async ({ page, context }) => {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([600, 500]);
  sheet.setCropBox(50, 50, 300, 350); sheet.setRotation(degrees(rotation));
  sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  sheet.drawText('Rotated highlight', { x: 90, y: 250, size: 14 });
  await open(page, await pdf.save());
  await page.locator('.quick-tools').getByTitle('Highlight', { exact: true }).click();
  const span = page.locator('.textLayer span').filter({ hasText: 'Rotated highlight' }); await expect(span).toBeVisible();
  const beforeScroll = (await span.boundingBox())!, sheetBounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  // Rotation 270 places this vertical line near the bottom. The production
  // suite's 720 px viewport otherwise sends mouseup outside the browser.
  await revealPDFRegion(page, beforeScroll.y - sheetBounds.y, beforeScroll.y + beforeScroll.height - sheetBounds.y);
  const words = (await span.boundingBox())!, viewer = (await page.locator('.pdf-viewer-container').boundingBox())!;
  expect(words.y).toBeGreaterThanOrEqual(viewer.y);
  expect(words.y + words.height).toBeLessThan(Math.min(viewer.y + viewer.height, page.viewportSize()!.height));
  await page.mouse.move(words.x + words.width / 2, words.y + 1); await page.mouse.down();
  await page.mouse.move(words.x + words.width / 2, words.y + words.height - 1, { steps: 8 });
  const selected = await page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect(), canvas = document.querySelector('canvas.page-canvas')!.getBoundingClientRect();
    return { x: rect.x - canvas.x, y: rect.y - canvas.y, width: rect.width, height: rect.height };
  });
  await page.mouse.up();
  await page.getByTitle('Select (V)', { exact: true }).click();
  const polygon = page.locator('.annotation-hit-regions polygon'); await expect(polygon).toHaveCount(1);
  const marked = await polygon.evaluate((element: SVGPolygonElement) => {
    const points = Array.from(element.points, point => new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM()!));
    const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
    return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
  });
  const currentCanvas = (await page.locator('canvas.page-canvas').boundingBox())!;
  const actual = { ...marked, x: marked.x - currentCanvas.x, y: marked.y - currentCanvas.y };
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual[key] - selected[key])).toBeLessThan(1);
  const saved = await output(page), native = new mupdf.PDFDocument(saved), nativePage = native.loadPage(0);
  const pixmap = nativePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const painted: Array<[number, number]> = [], data = pixmap.getPixels(), width = pixmap.getWidth();
    for (let y = 0; y < pixmap.getHeight(); y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (data[offset] > 230 && data[offset + 1] > 230 && data[offset + 2] < 245) painted.push([x, y]);
    }
    expect(painted.length).toBeGreaterThan(100);
    expect(Math.abs(Math.min(...painted.map(point => point[0])) - selected.x)).toBeLessThan(3);
    expect(Math.abs(Math.min(...painted.map(point => point[1])) - selected.y)).toBeLessThan(3);
    expect(Math.abs(Math.max(...painted.map(point => point[0])) - (selected.x + selected.width))).toBeLessThan(3);
    expect(Math.abs(Math.max(...painted.map(point => point[1])) - (selected.y + selected.height))).toBeLessThan(3);
  } finally { pixmap.destroy(); nativePage.destroy(); native.destroy(); }
  const reopened = await context.newPage(); await open(reopened, saved);
  const again = reopened.locator('.annotation-hit-regions polygon'); await expect(again).toHaveCount(1);
  const relocated = (await again.boundingBox())!, nextCanvas = (await reopened.locator('canvas.page-canvas').boundingBox())!;
  expect(Math.abs(relocated.x - nextCanvas.x - actual.x)).toBeLessThan(3); expect(Math.abs(relocated.y - nextCanvas.y - actual.y)).toBeLessThan(3);
  await reopened.close();
});
