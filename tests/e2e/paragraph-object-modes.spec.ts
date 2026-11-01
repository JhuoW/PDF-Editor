import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

test.setTimeout(60_000);
async function open(page: Page) {
  const document = await PDFDocument.create(), sheet = document.addPage([500, 600]);
  const regular = await document.embedFont(StandardFonts.Courier), bold = await document.embedFont(StandardFonts.CourierBold);
  for (const [text, x, y] of [['alpha ', 40, 526], ['gamma', 132.4, 526], ['delta epsilon', 40, 508],
    ['Following paragraph', 40, 486], ['keeps its own style', 40, 468], ['Final paragraph', 40, 436],
    ['Right column stays', 290, 486], ['exactly where it was', 290, 468]] as const) {
    sheet.drawText(text, { x, y, size: 14, font: regular, color: rgb(.1, .2, .6) });
  }
  sheet.drawText('beta ', { x: 90.4, y: 526, size: 14, font: bold, color: rgb(.7, .1, .2) });
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'paragraph-flow.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
}
async function save(page: Page) {
  const download = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  return readFile((await (await download).path())!);
}
function inspect(data: Uint8Array) {
  const document = new mupdf.PDFDocument(data), sheet = document.loadPage(0), text = sheet.toStructuredText('');
  const rows: { text: string; y: number }[] = [], glyphs: { character: string; x: number; y: number; font: string; size: number; color: number[] }[] = [];
  let row = { text: '', y: 0 };
  try {
    text.walk({ beginLine() { row = { text: '', y: 0 }; }, onChar(character, origin, font, size, _quad, color) {
      try { row.text += character; row.y = origin[1]; glyphs.push({ character, x: origin[0], y: origin[1], font: font.getName(), size, color }); } finally { font.destroy(); }
    }, endLine() { rows.push(row); } });
    return { rows, glyphs, text: text.asText() };
  } finally { text.destroy(); sheet.destroy(); document.destroy(); }
}
const paragraph = (page: Page) => page.locator('.text-block').filter({ hasText: 'alpha' }).first();
const input = (page: Page) => page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
const mode = (page: Page, name: 'text' | 'objects') => page.locator(`.workspace-ribbon [data-command="edit-${name}"]`).click();
const replacement = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';

test('text mode selects the complete mixed-font paragraph and reflows following paragraphs when saving', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page); await mode(page, 'text');
  await expect(paragraph(page)).toContainText('delta epsilon');
  const before = (await page.locator('.text-block').filter({ hasText: 'Following paragraph' }).boundingBox())!;
  await paragraph(page).click({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue('alpha beta gamma delta epsilon');
  // Continuous typing crosses several automatic line boundaries.
  await input(page).press('Control+End'); await input(page).pressSequentially(' zeta eta theta iota kappa lambda', { delay: 10 });
  await expect(input(page)).toHaveValue(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
  const after = (await page.locator('.text-block').filter({ hasText: 'Following paragraph' }).boundingBox())!;
  expect(after.y).toBeGreaterThan(before.y + 30);
  const result = inspect(await save(page));
  expect(result.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  const following = result.rows.find(row => row.text === 'Following paragraph')!;
  expect(following.y).toBeCloseTo(114 + after.y - before.y, 1);
  const edited = result.glyphs.filter(glyph => glyph.x < 200 && glyph.y < following.y);
  expect(edited.every(glyph => Math.abs(glyph.size - 14) < .01)).toBe(true);
  expect(edited.some(glyph => glyph.font.includes('Bold') && glyph.color[0] > .6)).toBe(true);
  expect(result.rows.find(row => row.text === 'Right column stays')?.y).toBeCloseTo(114, 2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.workspace-history > button').first().click();
  expect(inspect(await save(page)).rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(114, 2);
  await page.locator('.workspace-history > button').nth(1).click();
  expect(inspect(await save(page)).rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(following.y, 2);
});

test('deleting text closes paragraph gaps and the saved PDF can be reopened and edited', async ({ page }) => {
  await open(page); await mode(page, 'text'); await paragraph(page).click({ position: { x: 10, y: 5 } });
  await input(page).fill('alpha beta');
  const bytes = await save(page), result = inspect(bytes);
  expect(result.rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(96, 2);
  expect(result.rows.find(row => row.text === 'Final paragraph')?.y).toBeCloseTo(146, 2);
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'saved-flow.pdf', mimeType: 'application/pdf', buffer: bytes });
  await mode(page, 'text'); await paragraph(page).click();
  await expect(input(page)).toHaveValue('alpha beta');
  expect(inspect(await save(page)).text).not.toContain('delta epsilon');
});

test('object mode edits one physical row, wraps and saves without moving the next row', async ({ page }) => {
  await open(page); await mode(page, 'objects');
  await expect(page.locator('.object-edit-box[data-object-kind="text"]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Select text object 1', exact: true }).dblclick({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue('alpha beta gamma');
  await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toHaveAttribute('aria-pressed', 'true');
  await input(page).fill('alpha beta gamma\nobject line two');
  const result = inspect(await save(page));
  expect(result.rows.find(row => row.text === 'delta epsilon')?.y).toBeCloseTo(92, 2);
  expect(result.rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(114, 2);
  expect(result.text).toContain('object line two');
  await expect(page.locator('.object-edit-layer')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('switching between paragraph and row objects retains current layout and undo history', async ({ page }) => {
  await open(page); await mode(page, 'text'); await paragraph(page).click({ position: { x: 10, y: 5 } });
  await input(page).fill(replacement);
  const before = inspect(await save(page));
  await mode(page, 'objects');
  await expect(page.locator('.object-edit-layer')).toBeVisible();
  await expect(page.locator('.object-edit-box[data-object-kind="text"]')).toHaveCount(before.rows.length);
  const after = inspect(await save(page));
  expect(after.rows).toEqual(before.rows);
  await mode(page, 'text');
  await paragraph(page).click({ position: { x: 10, y: 5 } });
  await expect(input(page)).toHaveValue(replacement);
  await input(page).fill('alpha beta');
  const shortened = inspect(await save(page));
  expect(shortened.rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(96, 2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('every individual row can enter and leave object typing without changing modes or creating an undo step', async ({ page }) => {
  await open(page); await mode(page, 'objects');
  const rows = ['alpha beta gamma', 'delta epsilon', 'Following paragraph', 'Right column stays', 'keeps its own style', 'exactly where it was', 'Final paragraph'];
  for (const [index, text] of rows.entries()) {
    await page.getByRole('button', { name: `Select text object ${index + 1}`, exact: true }).dblclick({ position: { x: 10, y: 5 } });
    await expect(input(page)).toHaveValue(text);
    await input(page).press('Control+Enter');
    await expect(input(page)).toHaveCount(0);
    await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.locator('.workspace-history > button').first()).toBeDisabled();
});

test('advanced text layout uses space released by an earlier paragraph instead of reporting stale page overflow', async ({ page }) => {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 600]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  for (let row = 0; row < 10; row++) sheet.drawText(`Upper paragraph row ${row}`, { x: 40, y: 526 - row * 18, size: 14, font });
  sheet.drawText('Lower paragraph', { x: 40, y: 50, size: 14, font });
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'released-space.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible(); await mode(page, 'text');
  await page.locator('.text-block').filter({ hasText: 'Upper paragraph' }).click({ position: { x: 5, y: 5 } });
  await input(page).fill('Upper paragraph'); await input(page).press('Control+Enter');
  await page.locator('.text-block').filter({ hasText: 'Lower paragraph' }).click({ position: { x: 5, y: 5 } });
  const lower = Array.from({ length: 6 }, (_, row) => `Lower paragraph row ${row}`).join('\n');
  await input(page).fill(lower);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', lower);
  await expect(page.locator('.text-edit-notice')).toHaveCount(0);
  await page.locator('#pdf-text-edit-controls').getByRole('button', { name: 'Text layout…', exact: true }).click();
  const dialog = page.locator('.text-layout-dialog');
  await expect(dialog.getByText('Preview ready', { exact: true })).toBeVisible();
  expect(Number(await dialog.getByRole('spinbutton', { name: 'Y', exact: true }).inputValue())).toBeLessThan(400);
  await dialog.getByRole('textbox', { name: 'Text', exact: true }).fill(lower + ' updated');
  await expect(dialog.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const result = inspect(await save(page));
  expect(result.text.replace(/\s/g, '')).toContain((lower + ' updated').replace(/\s/g, ''));
  expect(result.glyphs.every(glyph => glyph.size === 14)).toBe(true);
  await expect(page.locator('.error-state')).toHaveCount(0);
});
