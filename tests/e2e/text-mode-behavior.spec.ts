import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

test.setTimeout(60_000);
const sourceRows = ['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda'];
const sourceText = sourceRows.join(' ');
const compact = (value: string) => value.replace(/\s/gu, '');
type Glyph = { text: string; x: number; y: number; size: number; font: string; color: number[] };

async function fixture(bodyRows = sourceRows) {
  const document = await PDFDocument.create(), sheet = document.addPage([550, 650]);
  const font = await document.embedFont(StandardFonts.Courier), other = await document.embedFont(StandardFonts.TimesRoman);
  bodyRows.forEach((text, row) => sheet.drawText(text, { x: 40, y: 580 - row * 16, size: 14, font, color: rgb(.6, .1, .2) }));
  for (const [text, x, y] of [
    ['Following paragraph', 40, 520], ['with a second row', 40, 504], ['Final paragraph', 40, 466],
    ['Right column first', 310, 580], ['Right column second', 310, 564], ['Right column third', 310, 548],
  ] as const) sheet.drawText(text, { x, y, size: 12, font: other });
  return Buffer.from(await document.save());
}
function inspect(bytes: Buffer) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), text = page.toStructuredText('');
  const rows: { text: string; baseline: number }[] = [], glyphs: Glyph[] = [];
  let row = { text: '', baseline: 0 };
  try {
    text.walk({ beginLine() { row = { text: '', baseline: 0 }; }, onChar(character, origin, font, size, _quad, color) {
      try { row.text += character; row.baseline = origin[1]; glyphs.push({ text: character, x: origin[0], y: origin[1], size, font: font.getName(), color }); }
      finally { font.destroy(); }
    }, endLine() { rows.push(row); } });
    return { rows, glyphs, text: text.asText() };
  } finally { text.destroy(); page.destroy(); document.destroy(); }
}
const originalGlyphs = (glyphs: Glyph[]) => glyphs.filter(glyph => glyph.size < 13);
const editedGlyphs = (glyphs: Glyph[]) => glyphs.filter(glyph => glyph.size > 13 && glyph.x < 300);
const input = (page: Page) => page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
const paragraph = (page: Page) => page.locator('.text-block').filter({ hasText: 'alpha' }).first();
const mode = (page: Page, value: 'text' | 'objects') => page.locator(`.workspace-ribbon [data-command="edit-${value}"]`).click();
async function open(page: Page, bytes: Buffer, name = 'mode-behavior.pdf') {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
}
async function download(page: Page, action: 'Save' | 'Export') {
  const pending = page.waitForEvent('download');
  if (action === 'Save') await page.keyboard.press('ControlOrMeta+s');
  else await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return bytes;
}
function contentAndSize(bytes: Buffer, expected: string) {
  const result = inspect(bytes), changed = editedGlyphs(result.glyphs);
  expect(compact(changed.map(glyph => glyph.text).join(''))).toBe(compact(expected));
  expect(changed.every(glyph => Math.abs(glyph.size - 14) < .01)).toBe(true);
  return result;
}

test('middle-row typing reflows the complete paragraph and immediately saving keeps every character', async ({ page }, testInfo) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text');
  const block = paragraph(page);
  await expect(block).toContainText(sourceRows[2]);
  const before = (await page.locator('.text-block').filter({ hasText: 'Following paragraph' }).boundingBox())!;
  // Click the middle physical row: its caret is inside the one full paragraph.
  await block.click({ position: { x: 22, y: 22 } });
  await expect(input(page)).toHaveValue(sourceText);
  const selection = await input(page).evaluate(node => (node as HTMLTextAreaElement).selectionStart);
  expect(selection).toBeGreaterThan(sourceRows[0].length);
  expect(selection).toBeLessThan(sourceRows[0].length + sourceRows[1].length + 2);
  await input(page).press('ControlOrMeta+End');
  await input(page).pressSequentially(' mu nu xi omicron pi rho sigma tau upsilon', { delay: 2 });
  const replacement = `${sourceText} mu nu xi omicron pi rho sigma tau upsilon`;
  // No wait for asynchronous preview: Ctrl+S must resolve the latest draft itself.
  const saved = await download(page, 'Save'), output = contentAndSize(saved, replacement);
  const following = output.rows.find(row => row.text === 'Following paragraph')!;
  const lastBodyBaseline = Math.max(...editedGlyphs(output.glyphs).map(glyph => glyph.y));
  expect(following.baseline).toBeGreaterThan(130);
  expect(following.baseline - lastBodyBaseline).toBeCloseTo(28, 2);
  expect(output.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
  await expect.poll(async () => (await page.locator('.text-block').filter({ hasText: 'Following paragraph' }).boundingBox())!.y)
    .toBeCloseTo(before.y + following.baseline - 130, 1);
  await expect(page.locator('.text-block.overflow')).toHaveCount(0);
  await testInfo.attach('paragraph-immediate-save.pdf', { body: saved, contentType: 'application/pdf' });

  // Reopen the physical PDF and delete enough text to collapse several rows.
  await open(page, saved, 'paragraph-saved.pdf'); await mode(page, 'text'); await paragraph(page).click({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue(replacement);
  await input(page).fill('alpha beta gamma');
  const shortened = await download(page, 'Export'), collapsed = contentAndSize(shortened, 'alpha beta gamma');
  expect(collapsed.rows.find(row => row.text === 'Following paragraph')?.baseline).toBeCloseTo(98, 2);
  expect(collapsed.rows.find(row => row.text === 'Final paragraph')?.baseline).toBeCloseTo(152, 2);
  expect(collapsed.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
  await testInfo.attach('paragraph-deleted-export.pdf', { body: shortened, contentType: 'application/pdf' });
});

test('object automatic wrapping changes one row while every other text object stays fixed', async ({ page }, testInfo) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'objects');
  const box = page.getByRole('button', { name: 'Select text object 1', exact: true });
  await box.dblclick({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue(sourceRows[0]);
  await input(page).press('ControlOrMeta+End');
  const suffix = ' object row adds many words until automatic wrapping makes more rows';
  await input(page).pressSequentially(suffix, { delay: 2 });
  const saved = await download(page, 'Save'), output = inspect(saved);
  expect(originalGlyphs(output.glyphs)).toEqual(originalGlyphs(original.glyphs));
  // The two untouched red source rows remain exactly at their original coordinates.
  for (const baseline of [86, 102]) {
    const from = original.glyphs.filter(glyph => glyph.size === 14 && Math.abs(glyph.y - baseline) < .01);
    for (const glyph of from) expect(output.glyphs).toContainEqual(glyph);
  }
  const redText = compact(editedGlyphs(output.glyphs).map(glyph => glyph.text).join(''));
  expect(redText).toContain(compact(sourceRows[0] + suffix));
  expect(new Set(editedGlyphs(output.glyphs).map(glyph => Math.round(glyph.y))).size).toBeGreaterThan(3);
  expect(editedGlyphs(output.glyphs).every(glyph => Math.abs(glyph.size - 14) < .01)).toBe(true);
  await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toHaveAttribute('aria-pressed', 'true');
  await testInfo.attach('object-automatic-wrap.pdf', { body: saved, contentType: 'application/pdf' });
  await page.locator('.workspace-history > button').first().click();
  expect(inspect(await download(page, 'Export')).glyphs).toEqual(original.glyphs);
  await page.locator('.workspace-history > button').nth(1).click();
  expect(inspect(await download(page, 'Export')).glyphs).toEqual(output.glyphs);
});

test('mixed Chinese and Latin paragraph growth survives switching to objects and back', async ({ page }, testInfo) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text'); await paragraph(page).click({ position: { x: 10, y: 5 } });
  const replacement = `${sourceText} 中文新增文字用于检查自动换行与段落联动 ABC 123`;
  await input(page).fill(replacement);
  const mixed = await download(page, 'Save');
  await testInfo.attach('mixed-paragraph.pdf', { body: mixed, contentType: 'application/pdf' });
  const output = contentAndSize(mixed, replacement);
  const following = output.rows.find(row => row.text === 'Following paragraph')!;
  expect(following.baseline).toBeGreaterThan(130);
  expect(output.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
  await mode(page, 'objects');
  await expect(page.locator('.object-edit-layer')).toBeVisible();
  expect(inspect(await download(page, 'Export')).glyphs).toEqual(output.glyphs);
  await mode(page, 'text'); await paragraph(page).click({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue(replacement);
  await input(page).fill(sourceText);
  const shortened = await download(page, 'Save');
  await testInfo.attach('restored-paragraph.pdf', { body: shortened, contentType: 'application/pdf' });
  const restored = contentAndSize(shortened, sourceText);
  expect(restored.rows.find(row => row.text === 'Following paragraph')?.baseline).toBeCloseTo(130, 2);
  expect(restored.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
});

test('a standalone 14-point paragraph grows beyond one row and saves without shrinking its text', async ({ page }) => {
  const originalText = 'alpha standalone paragraph', bytes = await fixture([originalText]), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text');
  const block = paragraph(page);
  expect(await block.evaluate(element => parseFloat((element as HTMLElement).style.height))).toBeCloseTo(14, 2);
  await block.click({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue(originalText);
  await input(page).press('ControlOrMeta+End');
  const suffix = ' adding enough words to wrap into several complete new lines while preserving the original font size';
  await input(page).pressSequentially(suffix, { delay: 2 });
  const output = contentAndSize(await download(page, 'Save'), originalText + suffix);
  const baselines = [...new Set(editedGlyphs(output.glyphs).map(glyph => Math.round(glyph.y * 1000) / 1000))].sort((a, b) => a - b);
  expect(baselines.length).toBeGreaterThan(1);
  const addedHeight = baselines.at(-1)! - baselines[0];
  expect(output.rows.find(row => row.text === 'Following paragraph')?.baseline).toBeCloseTo(130 + addedHeight, 2);
  expect(output.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
  await expect(page.locator('.text-block.overflow')).toHaveCount(0);
});

for (const startingMode of ['text', 'objects'] as const) {
  test(`redo after switching away from ${startingMode} restores its editing unit and saved layout`, async ({ page }) => {
    await open(page, await fixture()); await mode(page, startingMode);
    if (startingMode === 'text') await paragraph(page).click({ position: { x: 10, y: 5 } });
    else await page.getByRole('button', { name: 'Select text object 1', exact: true }).dblclick({ position: { x: 10, y: 5 } });
    const replacement = startingMode === 'text' ? `${sourceText} extra words to reflow this complete paragraph` : 'alpha revised object row';
    await input(page).fill(replacement); await input(page).press('ControlOrMeta+Enter');
    const before = inspect(await download(page, 'Save'));
    await page.locator('.workspace-history > button').first().click();
    await mode(page, startingMode === 'text' ? 'objects' : 'text');
    await page.locator('.workspace-history > button').nth(1).click();
    // A redo restores a draft's own unit, not a paragraph disguised as a row object.
    await expect(page.locator(`.workspace-ribbon [data-command="edit-${startingMode}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(inspect(await download(page, 'Save')).glyphs).toEqual(before.glyphs);
    if (startingMode === 'text') {
      await paragraph(page).click({ position: { x: 10, y: 5 } });
      await expect(input(page)).toHaveValue(replacement);
      await expect(paragraph(page)).toContainText(sourceRows[2]);
    } else {
      await page.getByRole('button', { name: 'Select text object 1', exact: true }).dblclick({ position: { x: 10, y: 5 } });
      await expect(input(page)).toHaveValue(replacement);
      await expect(input(page)).not.toHaveValue(new RegExp(sourceRows[1]));
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
