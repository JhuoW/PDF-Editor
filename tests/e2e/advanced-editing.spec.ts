import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function fixture(rotation = 0) {
  const bitmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  let png: Uint8Array;
  try {
    const bytes = bitmap.getPixels(), colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bytes.set(colors[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)], (y * 8 + x) * 3);
    png = new Uint8Array(bitmap.asPNG());
  } finally { bitmap.destroy(); }
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([600, 760]), image = await pdf.embedPng(png);
  if (rotation) { sheet.setCropBox(50, 60, 500, 650); sheet.setRotation(degrees(rotation)); sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  sheet.drawRectangle({ x: 0, y: 0, width: 600, height: 760, color: rgb(0, 1, 1) });
  sheet.drawText('Format this text\nSecond line', { x: 80, y: 650, size: 16, lineHeight: 22 });
  for (const [x, y] of [[80, 420], [300, 350], [450, 420]]) sheet.drawImage(image, { x, y, width: 80, height: 60 });
  return Buffer.from(await pdf.save());
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), sheet = pdf.loadPage(0), content = sheet.toStructuredText('preserve-images');
  const pixmap = sheet.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const images: number[][] = [], chars: { char: string; x: number; y: number; font: string; size: number; color: number[] }[] = [];
    content.walk({ onImageBlock(bounds) { images.push([...bounds]); }, onChar(char, point, font, size, _quad, color) { try { chars.push({ char, x: point[0], y: point[1], font: font.getName(), size, color: [...color] }); } finally { font.destroy(); } } });
    return { images, chars, text: content.asText(), pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth() };
  } finally { pixmap.destroy(); content.destroy(); sheet.destroy(); pdf.destroy(); }
}
const pixel = (result: ReturnType<typeof inspect>, x: number, y: number) => [...result.pixels.slice((y * result.width + x) * 3, (y * result.width + x) * 3 + 3)];
async function exported(page: Page) { const pending = page.waitForEvent('download'); await page.locator('.main-toolbar .toolbar-btn-primary').click(); return readFile((await (await pending).path())!); }
const images = (page: Page) => page.locator('.object-edit-box[data-object-kind="image"]');
async function open(page: Page, rotation = 0) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const bytes = await fixture(rotation);
  await page.goto('./'); await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'advanced.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption(rotation ? '0.5' : '1');
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click(); await expect(images(page)).toHaveCount(3);
  return inspect(bytes);
}
test('mixed object multi-selection moves as one undoable edit and survives export', async ({ page }) => {
  const before = await open(page);
  await images(page).first().click(); await page.locator('.object-edit-box[data-object-kind="text"]').first().click({ modifiers: ['Shift'] });
  await expect(page.locator('.object-edit-box.selected')).toHaveCount(2);
  const box = (await images(page).first().boundingBox())!;
  await page.keyboard.down('Alt'); await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 56, box.y + 40, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt');
  const after = inspect(await exported(page));
  after.images[0].forEach((value, coordinate) => expect(value - before.images[0][coordinate]).toBeCloseTo(coordinate % 2 ? 20 : 36, 2));
  expect(after.chars[0].x - before.chars[0].x).toBeCloseTo(36, 2); expect(after.chars[0].y - before.chars[0].y).toBeCloseTo(20, 2);
  expect(after.images.slice(1)).toEqual(before.images.slice(1)); expect(after.text).toBe(before.text);
  await page.locator('.workspace-history > button').nth(0).click(); expect(inspect(await exported(page)).images).toEqual(before.images);
  await page.locator('.workspace-history > button').nth(1).click(); expect(inspect(await exported(page)).images).toEqual(after.images);
});
for (const rotation of [0, 90]) test(`aligns in displayed coordinates and distributes selected objects on Rotate${rotation}`, async ({ page }) => {
  const before = await open(page, rotation);
  for (let index = 0; index < 3; index++) await images(page).nth(index).click({ modifiers: index ? ['Shift'] : [] });
  await page.getByRole('button', { name: 'Align left', exact: true }).click();
  const after = inspect(await exported(page)); expect(new Set(after.images.map(rect => Math.round(rect[0] * 1000)))).toHaveProperty('size', 1);
  await page.locator('.workspace-history > button').nth(0).click(); expect(inspect(await exported(page)).images).toEqual(before.images);
  if (!rotation) {
    for (let index = 0; index < 3; index++) await images(page).nth(index).click({ modifiers: index ? ['Shift'] : [] });
    await page.getByRole('button', { name: 'Distribute horizontally', exact: true }).click();
    const output = inspect(await exported(page)); expect(output.images[1][0]).toBeCloseTo(265, 2);
  }
});
test('marquee selection and visible snapping guides match the written PDF coordinates', async ({ page }) => {
  await open(page);
  const layer = (await page.locator('.object-edit-layer').boundingBox())!;
  await page.mouse.move(layer.x + 65, layer.y + 260); await page.mouse.down(); await page.mouse.move(layer.x + 540, layer.y + 420, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.object-edit-box.selected')).toHaveCount(3);
  await page.keyboard.press('Escape'); await images(page).first().click();
  const box = (await images(page).first().boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 235, box.y + 24, { steps: 5 });
  await expect(page.locator('.object-snap-guide.x')).toBeVisible(); await page.mouse.up();
  const after = inspect(await exported(page)); expect(after.images[0][0]).toBeCloseTo(300, 2); expect(after.images[0][1]).toBeCloseTo(280, 2);
});
test('native image mirroring and rotation update actual PDF pixels without changing shared images', async ({ page }) => {
  const before = await open(page); await images(page).first().click();
  const panel = page.locator('.native-image-properties'); await expect(panel.getByRole('button', { name: 'Flip horizontally', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Flip horizontally', exact: true }).click();
  const flipped = inspect(await exported(page)); expect(pixel(flipped, 85, 285)).toEqual([0, 255, 0]); expect(pixel(flipped, 305, 355)).toEqual([255, 0, 0]);
  await panel.getByRole('button', { name: 'Rotate right 90°', exact: true }).click();
  const rotated = inspect(await exported(page)); expect(pixel(rotated, 95, 275)).toEqual([255, 255, 0]); expect(rotated.images[1]).toEqual(before.images[1]);
  await page.screenshot({ path: test.info().outputPath('image-properties.png') });
  await page.locator('.workspace-history > button').nth(0).click(); expect(inspect(await exported(page)).images).toEqual(flipped.images);
});
test('native image cropping previews, cancels, exports immediately and restores original pixels', async ({ page }) => {
  await open(page); await images(page).first().click();
  const panel = page.locator('.native-image-properties'), left = panel.getByRole('spinbutton', { name: 'Left (%)', exact: true });
  await left.fill('50'); await expect(page.locator('.text-edit-preview')).toBeVisible();
  await left.press('Escape'); expect(pixel(inspect(await exported(page)), 85, 285)).toEqual([255, 0, 0]);
  await left.fill('50');
  // The global save path commits the crop draft without waiting for a preview.
  const pending = page.waitForEvent('download'); await left.press('ControlOrMeta+s'); const bytes = await readFile((await (await pending).path())!);
  const cropped = inspect(bytes); expect(pixel(cropped, 85, 285)).toEqual([0, 255, 255]); expect(pixel(cropped, 125, 285)).toEqual([0, 255, 0]);
  await panel.getByRole('button', { name: 'Restore full image', exact: true }).click(); expect(pixel(inspect(await exported(page)), 85, 285)).toEqual([255, 0, 0]);
});
for (const [rotation, color] of [[90, [255, 0, 0]], [270, [255, 255, 0]]] as const) test(`horizontal mirroring follows the displayed page at Rotate${rotation}`, async ({ page }) => {
  const before = await open(page, rotation); await images(page).first().click();
  const panel = page.locator('.native-image-properties');
  await panel.getByRole('button', { name: 'Flip horizontally', exact: true }).click();
  const output = inspect(await exported(page)), bounds = before.images[0];
  expect(pixel(output, Math.round(bounds[0] + 10), Math.round(bounds[1] + 10))).toEqual(color);
  expect(output.images[1]).toEqual(before.images[1]);
});
test('quick text properties preserve original content while writing font, size, color and spacing', async ({ page }) => {
  const before = await open(page); await page.locator('.object-edit-box[data-object-kind="text"]').first().click();
  const panel = page.locator('.native-text-properties'); await expect(panel.getByRole('combobox', { name: 'Text font', exact: true })).toBeEnabled();
  await panel.getByRole('combobox', { name: 'Text font', exact: true }).selectOption('Courier-Bold');
  await panel.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('24'); await panel.getByRole('spinbutton', { name: 'Font size', exact: true }).press('Enter');
  await panel.getByRole('spinbutton', { name: 'Line spacing', exact: true }).fill('2'); await panel.getByRole('spinbutton', { name: 'Line spacing', exact: true }).press('Enter');
  await panel.getByLabel('Text color', { exact: true }).fill('#cc2200');
  const after = inspect(await exported(page)); expect(after.text.replace(/\s+/g, ' ')).toContain('Format this text Second line'); expect(after.images).toEqual(before.images);
  const glyph = after.chars.find(char => char.char === 'F')!; expect(glyph.font).toMatch(/Bold/i); expect(glyph.font).toMatch(/Courier|Mono/i); expect(glyph.size).toBeCloseTo(24, 3); expect(glyph.color[0]).toBeCloseTo(.8, 3); expect(glyph.color[1]).toBeCloseTo(34 / 255, 3);
  const baselines = [...new Set(after.chars.map(char => Math.round(char.y * 1000) / 1000))].sort((a, b) => a - b);
  expect(baselines.length).toBeGreaterThan(1); for (let index = 1; index < baselines.length; index++) expect(baselines[index] - baselines[index - 1]).toBeCloseTo(48, 2);
  await panel.getByRole('combobox', { name: 'Text alignment', exact: true }).selectOption('center');
  expect(inspect(await exported(page)).text.replace(/\s+/g, ' ')).toContain('Format this text Second line');
  await page.screenshot({ path: test.info().outputPath('text-properties.png') });
});
test('a cropped image remains movable and can be restored after applying content changes', async ({ page }) => {
  await open(page); await images(page).first().click();
  const panel = page.locator('.native-image-properties'); await panel.getByRole('spinbutton', { name: 'Left (%)', exact: true }).fill('50');
  await panel.getByRole('button', { name: 'Apply crop', exact: true }).click();
  await page.locator('.object-edit-box[data-object-kind="text"]').first().click();
  const textPanel = page.locator('.native-text-properties');
  await expect(textPanel.getByLabel('Text color', { exact: true })).toBeEnabled(); await textPanel.getByLabel('Text color', { exact: true }).fill('#cc2200');
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click(); await expect(images(page)).toHaveCount(3);
  // Cropping changes the visible bounds, but keeps a native, individually editable image.
  const first = images(page).filter({ has: page.locator('[data-resize-handle]') });
  const cropped = images(page).filter({ hasNot: page.locator('[data-resize-handle]') });
  const id = await cropped.evaluateAll(elements => elements.find(element => Math.abs(parseFloat((element as HTMLElement).style.left) - 120) < .1)?.getAttribute('data-object-id'));
  expect(id).toBeTruthy();
  const target = page.locator(`[data-object-id="${id}"]`); await target.click(); await expect(first).toHaveCount(1);
  const box = (await target.boundingBox())!;
  await page.keyboard.down('Alt'); await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 60, { steps: 4 }); await page.mouse.up(); await page.keyboard.up('Alt');
  const output = inspect(await exported(page)); expect(pixel(output, 125, 285)).toEqual([0, 255, 255]); expect(pixel(output, 185, 335)).toEqual([0, 255, 0]);
  await page.locator('.native-image-properties').getByRole('button', { name: 'Restore full image', exact: true }).click();
  expect(pixel(inspect(await exported(page)), 145, 335)).toEqual([255, 0, 0]);
});
test('phone multiple-selection controls and formatting panels switch language without losing edits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('0.5');
  await page.getByRole('button', { name: 'Toggle properties', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Multiple selection', exact: true }).check(); await page.locator('.workspace-inspector header button').click();
  await images(page).first().click(); await images(page).nth(1).click(); await expect(page.locator('.object-edit-box.selected')).toHaveCount(2);
  await page.getByRole('button', { name: 'Arrange objects', exact: true }).click();
  await page.locator('.main-toolbar .language-switcher button[lang="zh-CN"]').click(); await expect(page.locator('.object-arrangement h3')).toHaveText('已选择 2 个对象');
  await page.getByRole('button', { name: '左对齐', exact: true }).click();
  const after = inspect(await exported(page)); expect(after.images[0][0]).toBe(after.images[1][0]);
  await page.screenshot({ path: test.info().outputPath('phone-arrangement.png') });
  await page.locator('.main-toolbar .language-switcher button[lang="en"]').click(); await expect(page.getByRole('checkbox', { name: 'Multiple selection', exact: true })).toBeChecked();
});
