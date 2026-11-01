import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

test.setTimeout(90_000);
type Glyph = { text: string; x: number; y: number; size: number; font: string; color: number[] };
const compact = (text: string) => text.replace(/\s/gu, '');
async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('Alpha object', { x: 40, y: 530, size: 12, font, color: rgb(.8, 0, 0) });
  for (const [text, x, y] of [['Neighbor fixed', 40, 420], ['Right column fixed', 300, 530], ['Bottom fixed', 40, 80]] as const) {
    page.drawText(text, { x, y, size: 12, font });
  }
  const other = pdf.addPage([500, 600]);
  other.drawText('Untouched second page', { x: 50, y: 500, size: 14, font });
  return Buffer.from(await pdf.save());
}
function inspect(bytes: Uint8Array, pageIndex = 0) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(pageIndex), text = page.toStructuredText('');
  const glyphs: Glyph[] = [], pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    text.walk({ onChar(character, origin, font, size, _quad, color) {
      try { glyphs.push({ text: character, x: origin[0], y: origin[1], size, font: font.getName(), color }); }
      finally { font.destroy(); }
    } });
    return { glyphs, text: text.asText(), pixels: createHash('sha256').update(pixmap.getPixels()).digest('hex') };
  } finally { pixmap.destroy(); text.destroy(); page.destroy(); pdf.destroy(); }
}
const red = (glyphs: Glyph[]) => glyphs.filter(glyph => glyph.color[0] > .7);
const black = (glyphs: Glyph[]) => glyphs.filter(glyph => glyph.color.every(value => value === 0));
const firstObject = (page: Page) => page.getByRole('button', { name: 'Select text object 1', exact: true });
const input = (page: Page) => page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
async function open(page: Page, bytes: Buffer, name = 'object-extremes.pdf') {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click();
  await expect(firstObject(page)).toBeVisible();
}
async function save(page: Page) {
  const pending = page.waitForEvent('download'); await page.keyboard.press('ControlOrMeta+s');
  const bytes = await readFile((await (await pending).path())!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return bytes;
}
function unchanged(original: Buffer, saved: Buffer) {
  expect(black(inspect(saved).glyphs)).toEqual(black(inspect(original).glyphs));
  expect(inspect(saved, 1)).toEqual(inspect(original, 1));
}
async function artifact(info: TestInfo, name: string, bytes: Buffer) {
  const path = info.outputPath(name); await writeFile(path, bytes);
  await info.attach(name, { path, contentType: 'application/pdf' });
}
function translatedPixels(bytes: Uint8Array, dx: number) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const width = pixmap.getWidth(), height = pixmap.getHeight(), channels = pixmap.getNumberOfComponents();
    const pixels = pixmap.getPixels(), shifted = new Uint8Array(pixels.length).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceX = x - dx;
      if (sourceX >= 0 && sourceX < width) shifted.set(pixels.subarray((y * width + sourceX) * channels, (y * width + sourceX + 1) * channels), (y * width + x) * channels);
    }
    return createHash('sha256').update(shifted).digest('hex');
  } finally { pixmap.destroy(); page.destroy(); pdf.destroy(); }
}

test('reopening a multiline object keeps its rows independent through repeated Save and edit cycles', async ({ page }, testInfo) => {
  const original = await fixture();
  await open(page, original); await firstObject(page).dblclick({ position: { x: 8, y: 5 } });
  await input(page).fill('Alpha 中文第一行\nPreserve 第二行\nLast third row');
  let saved = await save(page);
  unchanged(original, saved);
  const first = inspect(saved), preserved = red(first.glyphs).filter(glyph => glyph.y > 75);
  expect(preserved.length).toBeGreaterThan(10);
  for (const [index, replacement] of ['Alpha 一次', 'Alpha 第二次 ABC', 'Alpha third cycle', 'Alpha 终版'].entries()) {
    await open(page, saved, `cycle-${index}.pdf`);
    await firstObject(page).dblclick({ position: { x: 8, y: 5 } });
    await expect(input(page)).not.toHaveValue(/Preserve|Last/);
    await input(page).fill(replacement);
    saved = await save(page);
    const result = inspect(saved);
    expect(compact(red(result.glyphs).filter(glyph => glyph.y < 75).map(glyph => glyph.text).join(''))).toBe(compact(replacement));
    expect(red(result.glyphs).filter(glyph => glyph.y > 75)).toEqual(preserved);
    expect(red(result.glyphs).every(glyph => Math.abs(glyph.size - 12) < .01)).toBe(true);
    unchanged(original, saved);
  }
  await artifact(testInfo, 'before.pdf', original);
  await artifact(testInfo, 'after-four-reopened-edits.pdf', saved);
});

test('moving a newly multiline object keeps every glyph, other objects and undo boundaries intact', async ({ page }, testInfo) => {
  const original = await fixture();
  await open(page, original); await firstObject(page).dblclick({ position: { x: 8, y: 5 } });
  const value = 'Alpha moved object\n中文第二行 ABC\nThird row 123';
  await input(page).fill(value); await input(page).press('ControlOrMeta+Enter');
  // Move immediately after confirming, before depending on an asynchronous
  // preview rectangle. The saved text must still use its full automatic height.
  await firstObject(page).focus(); await firstObject(page).press('Shift+ArrowRight');
  await firstObject(page).press('Shift+ArrowDown');
  const saved = await save(page), moved = inspect(saved);
  expect(compact(red(moved.glyphs).map(glyph => glyph.text).join(''))).toBe(compact(value));
  expect(red(moved.glyphs)[0].x).toBeCloseTo(50, 3);
  expect(red(moved.glyphs)[0].y).toBeCloseTo(80, 3);
  unchanged(original, saved);
  await page.locator('.workspace-history > button').first().click();
  const horizontal = inspect(await save(page));
  expect(red(horizontal.glyphs)[0].x).toBeCloseTo(50, 3);
  expect(red(horizontal.glyphs)[0].y).toBeCloseTo(70, 3);
  await page.locator('.workspace-history > button').nth(1).click();
  expect(inspect(await save(page))).toEqual(moved);
  await artifact(testInfo, 'before.pdf', original);
  await artifact(testInfo, 'after-multiline-move.pdf', saved);
});

test('selecting all text objects and moving against the page edge preserves group spacing and the other page', async ({ page }, testInfo) => {
  const original = await fixture(), before = inspect(original);
  await open(page, original); await firstObject(page).focus();
  await firstObject(page).press('ControlOrMeta+a');
  await expect(page.locator('.object-edit-box.text.selected')).toHaveCount(4);
  for (let step = 0; step < 6; step++) await firstObject(page).press('Shift+ArrowLeft');
  const saved = await save(page), result = inspect(saved);
  expect(result.glyphs.length).toBe(before.glyphs.length);
  for (const glyph of before.glyphs) {
    const match = result.glyphs.find(candidate => candidate.text === glyph.text && Math.abs(candidate.x - (glyph.x - 40)) < .01 && Math.abs(candidate.y - glyph.y) < .01);
    expect(match).toBeDefined();
    expect(match?.size).toBe(glyph.size); expect(match?.color).toEqual(glyph.color);
  }
  // The unembedded standard Courier uses the engine's equivalent Nimbus font.
  // Compare actual translated pixels, not the font's implementation-specific name.
  expect(result.pixels).toBe(translatedPixels(original, -40));
  expect(inspect(saved, 1)).toEqual(inspect(original, 1));
  // Two further arrows at the boundary are no-ops and must not consume undo.
  await page.locator('.workspace-history > button').first().click();
  const undone = inspect(await save(page));
  expect(Math.min(...undone.glyphs.map(glyph => glyph.x))).toBeCloseTo(10, 3);
  await artifact(testInfo, 'before.pdf', original);
  await artifact(testInfo, 'after-group-edge-move.pdf', saved);
});
