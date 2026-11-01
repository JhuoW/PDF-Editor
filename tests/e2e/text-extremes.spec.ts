import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

test.setTimeout(60_000);
const body = ['alpha beta gamma delta', 'epsilon zeta eta theta', 'iota kappa lambda'];
const compact = (text: string) => text.replace(/\s/gu, '');
type Glyph = { character: string; x: number; y: number; size: number; font: string; color: number[] };
async function artifact(testInfo: TestInfo, name: string, bytes: Buffer) {
  const path = testInfo.outputPath(name);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  await testInfo.attach(name, { path, contentType: 'application/pdf' });
}
async function fixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier);
  const sheet = pdf.addPage([550, 650]);
  body.forEach((text, row) => sheet.drawText(text, { x: 40, y: 580 - row * 16, size: 14, font, color: rgb(.7, .1, .2) }));
  for (const [text, x, y] of [['Following paragraph', 40, 490], ['Another following row', 40, 474],
    ['Right column first', 310, 580], ['Right column second', 310, 564]] as const) {
    sheet.drawText(text, { x, y, size: 12, font });
  }
  const second = pdf.addPage([550, 650]);
  second.drawText('UNTOUCHED SECOND PAGE', { x: 70, y: 500, size: 18, font });
  second.drawRectangle({ x: 70, y: 280, width: 200, height: 100, color: rgb(.2, .6, .8) });
  return Buffer.from(await pdf.save());
}
function inspect(bytes: Buffer) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), text = page.toStructuredText('');
  const glyphs: Glyph[] = [], rows: { text: string; y: number }[] = [];
  let row = { text: '', y: 0 };
  try {
    text.walk({ beginLine() { row = { text: '', y: 0 }; }, onChar(character, origin, font, size, _quad, color) {
      try { row.text += character; row.y = origin[1]; glyphs.push({ character, x: origin[0], y: origin[1], size, font: font.getName(), color }); }
      finally { font.destroy(); }
    }, endLine() { rows.push(row); } });
    const hashes: string[] = [];
    for (let number = 0; number < document.countPages(); number++) {
      const sheet = document.loadPage(number), pixels = sheet.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      try { hashes.push(createHash('sha256').update(pixels.getPixels()).digest('hex')); }
      finally { pixels.destroy(); sheet.destroy(); }
    }
    return { glyphs, rows, hashes };
  } finally { text.destroy(); page.destroy(); document.destroy(); }
}
const input = (page: Page) => page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
const mode = (page: Page, name: 'text' | 'objects') => page.locator(`.workspace-ribbon [data-command="edit-${name}"]`).click();
const paragraph = (page: Page) => page.locator('.text-block').filter({ hasText: 'alpha' }).first();
const bodyGlyphs = (glyphs: Glyph[]) => glyphs.filter(glyph => glyph.size > 13 && glyph.x < 300);
async function open(page: Page, bytes: Buffer, name = 'extreme-text.pdf') {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.page-wrapper[data-page="1"] canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
}
async function save(page: Page, action: 'Save' | 'Export' = 'Save') {
  const pending = page.waitForEvent('download');
  if (action === 'Save') await page.keyboard.press('ControlOrMeta+s');
  else await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return bytes;
}

for (const editingMode of ['text', 'objects'] as const) {
  test(`${editingMode} select-all deletion preserves other content and undo restores original PDF pixels`, async ({ page }, testInfo) => {
    const bytes = await fixture(), original = inspect(bytes);
    await open(page, bytes); await mode(page, editingMode);
    if (editingMode === 'text') await paragraph(page).click({ position: { x: 8, y: 5 } });
    else await page.getByRole('button', { name: 'Select text object 1', exact: true }).dblclick({ position: { x: 8, y: 5 } });
    await input(page).press('ControlOrMeta+a'); await input(page).press('Backspace');
    await expect(input(page)).toHaveValue('');
    const deleted = await save(page), output = inspect(deleted);
    expect(output.hashes[1]).toBe(original.hashes[1]);
    expect(output.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
    if (editingMode === 'text') {
      expect(bodyGlyphs(output.glyphs)).toEqual([]);
      expect(output.rows.find(row => row.text === 'Following paragraph')?.y).toBeCloseTo(114, 2);
    } else {
      expect(bodyGlyphs(output.glyphs)).toEqual(bodyGlyphs(original.glyphs).filter(glyph => glyph.y > 70.01));
      expect(output.glyphs.filter(glyph => glyph.size === 12)).toEqual(original.glyphs.filter(glyph => glyph.size === 12));
    }
    await artifact(testInfo, 'original.pdf', bytes);
    await artifact(testInfo, `${editingMode}-deleted.pdf`, deleted);
    await page.locator('.workspace-history > button').first().click();
    expect(inspect(await save(page, 'Export')).hashes).toEqual(original.hashes);
    await page.locator('.workspace-history > button').nth(1).click();
    expect(inspect(await save(page, 'Export')).hashes).toEqual(output.hashes);
  });
}

test('manual line breaks and blank lines survive reopening and later edits without collapsing', async ({ page }, testInfo) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text'); await paragraph(page).click({ position: { x: 8, y: 5 } });
  const replacement = 'alpha one\n\nbeta two\nomega three';
  await input(page).fill(replacement);
  const saved = await save(page), output = inspect(saved);
  expect(output.rows.find(row => row.text === 'alpha one')?.y).toBeCloseTo(70, 2);
  expect(output.rows.find(row => row.text === 'beta two')?.y).toBeCloseTo(102, 2);
  expect(output.rows.find(row => row.text === 'omega three')?.y).toBeCloseTo(118, 2);
  await artifact(testInfo, 'original.pdf', bytes);
  await artifact(testInfo, 'manual-breaks-saved.pdf', saved);
  await open(page, saved, 'manual-breaks-reopened.pdf'); await mode(page, 'text');
  // Enter creates a new paragraph; blank lines stay as the physical gap between
  // separately editable paragraphs when the saved document is opened again.
  await page.locator('.text-block').filter({ hasText: 'beta two' }).click({ position: { x: 8, y: 5 } });
  await expect(input(page)).toHaveValue('beta two');
  await input(page).press('ControlOrMeta+End'); await input(page).pressSequentially(' revised');
  const revised = await save(page, 'Export'), result = inspect(revised);
  expect(result.rows.find(row => row.text === 'alpha one')?.y).toBeCloseTo(70, 2);
  expect(result.rows.find(row => row.text === 'beta two revised')?.y).toBeCloseTo(102, 2);
  expect(result.rows.find(row => row.text === 'omega three')?.y).toBeCloseTo(118, 2);
  expect(result.hashes[1]).toBe(original.hashes[1]);
  expect(result.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
  await artifact(testInfo, 'manual-breaks-edited-again.pdf', revised);
});

test('a long unbroken token wraps without text loss or inserted spaces after reopening', async ({ page }, testInfo) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text'); await paragraph(page).click({ position: { x: 8, y: 5 } });
  const replacement = 'abcdefghij'.repeat(24);
  await input(page).fill(replacement);
  const saved = await save(page), output = inspect(saved), changed = bodyGlyphs(output.glyphs);
  expect(compact(changed.map(glyph => glyph.character).join(''))).toBe(replacement);
  expect(changed.every(glyph => Math.abs(glyph.size - 14) < .01)).toBe(true);
  expect(new Set(changed.map(glyph => glyph.y)).size).toBeGreaterThan(8);
  expect(output.rows.find(row => row.text === 'Following paragraph')!.y).toBeGreaterThan(Math.max(...changed.map(glyph => glyph.y)));
  expect(output.hashes[1]).toBe(original.hashes[1]);
  await artifact(testInfo, 'original.pdf', bytes);
  await artifact(testInfo, 'long-token.pdf', saved);
  await open(page, saved, 'long-token-reopened.pdf'); await mode(page, 'text');
  await page.locator('.text-block').filter({ hasText: 'abcdefghij' }).first().click({ position: { x: 8, y: 5 } });
  await expect(input(page)).toHaveValue(replacement);
  await input(page).press('ControlOrMeta+End'); await input(page).pressSequentially('XYZ');
  const edited = inspect(await save(page));
  expect(compact(bodyGlyphs(edited.glyphs).map(glyph => glyph.character).join(''))).toBe(replacement + 'XYZ');
  expect(edited.hashes[1]).toBe(original.hashes[1]);
});

test('page overflow keeps the full draft and shortening it recovers a savable paragraph', async ({ page }) => {
  const bytes = await fixture(), original = inspect(bytes);
  await open(page, bytes); await mode(page, 'text'); await paragraph(page).click({ position: { x: 8, y: 5 } });
  const replacement = Array.from({ length: 100 }, (_, row) => `alpha overflow row ${row}`).join('\n');
  await input(page).fill(replacement);
  await expect(page.locator('.text-edit-notice')).toContainText(/page|bottom/i);
  await expect(input(page)).toHaveValue(replacement);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.text-edit-notice')).toBeVisible();
  await mode(page, 'text');
  await paragraph(page).click({ position: { x: 8, y: 5 } });
  await expect(input(page)).toHaveValue(replacement);
  await input(page).fill('alpha recovered paragraph');
  const saved = inspect(await save(page));
  expect(compact(bodyGlyphs(saved.glyphs).map(glyph => glyph.character).join(''))).toBe('alpharecoveredparagraph');
  expect(saved.hashes[1]).toBe(original.hashes[1]);
  await expect(page.locator('.text-edit-notice')).toHaveCount(0);
  await page.locator('.workspace-history > button').first().click();
  await expect(page.locator('.text-edit-notice')).toBeVisible();
  await page.locator('.workspace-history > button').first().click();
  expect(inspect(await save(page, 'Export')).hashes).toEqual(original.hashes);
});

for (const scenario of [
  { name: 'unsupported script', text: 'alpha العربية', message: /complex-script or bidirectional layout/i },
  { name: '20,000-character limit', text: 'alpha' + 'A'.repeat(19_996), message: /limited to 20,000 characters/i },
]) {
  test(`${scenario.name} rejection preserves the entire draft and can recover without losing the document`, async ({ page }) => {
    const bytes = await fixture(), original = inspect(bytes);
    await open(page, bytes); await mode(page, 'text'); await paragraph(page).click({ position: { x: 8, y: 5 } });
    await input(page).fill(scenario.text);
    await expect(page.locator('.text-edit-notice')).toContainText(scenario.message);
    await expect(input(page)).toHaveValue(scenario.text);
    const downloads: string[] = [];
    const capture = (download: import('@playwright/test').Download) => { downloads.push(download.suggestedFilename()); };
    page.on('download', capture);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('.error-state')).toContainText(scenario.message);
    expect(downloads).toEqual([]);
    page.off('download', capture);
    await page.locator('.error-state').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await paragraph(page).click({ position: { x: 8, y: 5 } });
    await expect(input(page)).toHaveValue(scenario.text);
    await input(page).fill('alpha recovered');
    const saved = inspect(await save(page));
    expect(compact(bodyGlyphs(saved.glyphs).map(glyph => glyph.character).join(''))).toBe('alpharecovered');
    expect(saved.hashes[1]).toBe(original.hashes[1]);
    expect(saved.glyphs.filter(glyph => glyph.x >= 300)).toEqual(original.glyphs.filter(glyph => glyph.x >= 300));
    await expect(page.locator('.text-edit-notice')).toHaveCount(0);
  });
}
