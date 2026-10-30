import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

const paragraph = 'Move this paragraph safely';
function bitmapPNG(color = [255, 0, 0]) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  try {
    const pixels = pixmap.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
    return new Uint8Array(pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
async function fixture(rotation = 0, title = paragraph) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([600, 760]);
  if (rotation) {
    sheet.setCropBox(50, 60, 500, 650); sheet.setRotation(degrees(rotation));
    sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  sheet.drawRectangle({ x: 0, y: 0, width: 600, height: 760, color: rgb(0, 1, 1) });
  sheet.drawText(title, { x: 80, y: 620, size: 16 });
  sheet.drawRectangle({ x: 450, y: 650, width: 50, height: 25, color: rgb(0, 1, 0) });
  sheet.drawText('REVEALED CONTENT', { x: 85, y: 450, size: 8 });
  const image = await pdf.embedPng(bitmapPNG());
  sheet.drawImage(image, { x: 80, y: 430, width: 80, height: 60 });
  sheet.drawImage(image, { x: 360, y: 430, width: 80, height: 60 });
  return Buffer.from(await pdf.save());
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), sheet = pdf.loadPage(0), content = sheet.toStructuredText('preserve-images');
  try {
    const images: number[][] = [], characters: { char: string; x: number; y: number }[] = [];
    content.walk({
      onImageBlock(bounds) { images.push([...bounds]); },
      onChar(char, point) { characters.push({ char, x: point[0], y: point[1] }); },
    });
    const full = characters.map(item => item.char).join(''), index = full.indexOf(paragraph);
    const pixmap = sheet.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    let green = 0;
    try {
      const pixels = pixmap.getPixels(), channels = pixmap.getNumberOfComponents();
      for (let offset = 0; offset < pixels.length; offset += channels) {
        if (pixels[offset] < 5 && pixels[offset + 1] > 250 && pixels[offset + 2] < 5) green++;
      }
    } finally { pixmap.destroy(); }
    return { images, text: content.asText(), paragraph: index < 0 ? null : characters[index], green };
  } finally { content.destroy(); sheet.destroy(); pdf.destroy(); }
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download');
  await page.locator('.main-toolbar .toolbar-btn-primary').click();
  return readFile((await (await pending).path())!);
}
const images = (page: Page) => page.locator('.object-edit-layer [data-object-kind="image"]');
const texts = (page: Page) => page.locator('.object-edit-layer [data-object-kind="text"]');
async function open(page: Page, rotation = 0) {
  await page.goto('./');
  const bytes = await fixture(rotation);
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'objects.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption(rotation ? '0.5' : '1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click();
  await expect(images(page)).toHaveCount(2);
  await expect(texts(page)).toHaveCount(2);
  return { bytes, original: inspect(bytes) };
}
async function startDrag(page: Page, object: Locator, dx: number, dy: number) {
  const bounds = (await object.boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 });
}
async function drag(page: Page, object: Locator, dx: number, dy: number) {
  await startDrag(page, object, dx, dy); await page.mouse.up();
}
function closeBounds(actual: number[], expected: number[], precision = 1) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], precision));
}
async function previewPixels(page: Page, points: number[][]) {
  const preview = page.locator('.text-edit-preview');
  await expect(preview).toBeVisible();
  return preview.evaluate((element: HTMLImageElement, samples) => {
    if (!element.complete || !element.naturalWidth) return [];
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0);
    return samples.map(([x, y]) => [...context.getImageData(Math.round(x / 600 * canvas.width), Math.round(y / 760 * canvas.height), 1, 1).data].slice(0, 3));
  }, points);
}

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('dragging an original image updates actual preview pixels and only its selected drawing occurrence', async ({ page }) => {
  const { original } = await open(page);
  await startDrag(page, images(page).first(), 80, 90);
  // Inspect the rendered PDF while the pointer is still down. A moved border
  // over the unchanged PDF would leave the old sample red and the new one cyan.
  await expect.poll(() => previewPixels(page, [[120, 300], [200, 390], [400, 300]]), { timeout: 15_000 }).toEqual([[0, 255, 255], [255, 0, 0], [255, 0, 0]]);
  await page.mouse.up();
  const output = inspect(await exported(page));
  closeBounds(output.images[0], [160, 360, 240, 420]);
  closeBounds(output.images[1], original.images[1]);
  expect(output.text).toContain(paragraph); expect(output.text).toContain('REVEALED CONTENT');
  expect(output.green).toBe(original.green);
  await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  await expect(page.locator('.object-edit-layer')).toHaveCount(0);
  await expect.poll(() => previewPixels(page, [[120, 300], [200, 390]])).toEqual([[0, 255, 255], [255, 0, 0]]);
  expect(inspect(await exported(page)).images).toEqual(output.images);
});

test('corner handles preserve image proportions, Shift permits free sizing, and one undo reverses one gesture', async ({ page }) => {
  const { original } = await open(page);
  await images(page).first().click();
  const corner = page.locator('.object-edit-layer .selected [data-resize-handle="se"]');
  await drag(page, corner, 40, 30);
  const proportional = inspect(await exported(page));
  closeBounds(proportional.images[0], [80, 270, 200, 360]);
  closeBounds(proportional.images[1], original.images[1]);
  await page.keyboard.down('Shift'); await drag(page, corner, 30, 5); await page.keyboard.up('Shift');
  const free = inspect(await exported(page));
  closeBounds(free.images[0], [80, 270, 230, 365]);
  await page.locator('.workspace-history > button').nth(0).click();
  expect(inspect(await exported(page)).images).toEqual(proportional.images);
  await page.locator('.workspace-history > button').nth(1).click();
  expect(inspect(await exported(page)).images).toEqual(free.images);
});

test('Escape cancels an in-progress object gesture without creating an undo step', async ({ page }) => {
  const { original } = await open(page);
  await startDrag(page, images(page).first(), 70, 80);
  await expect.poll(() => previewPixels(page, [[120, 300], [190, 380]]), { timeout: 15_000 }).toEqual([[0, 255, 255], [255, 0, 0]]);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(inspect(await exported(page)).images).toEqual(original.images);
  await expect(page.locator('.workspace-history > button').nth(0)).toBeDisabled();
  await expect(page.locator('.text-edit-preview')).toHaveCount(0);
});

test('original text can be moved with content, neighboring drawings, undo and redo preserved', async ({ page }) => {
  const { original } = await open(page);
  await drag(page, texts(page).first(), 55, 65);
  const output = inspect(await exported(page));
  expect(output.text.match(new RegExp(paragraph, 'g'))).toHaveLength(1);
  expect(output.paragraph!.x - original.paragraph!.x).toBeCloseTo(55, 1);
  expect(output.paragraph!.y - original.paragraph!.y).toBeCloseTo(65, 0);
  expect(output.images).toEqual(original.images); expect(output.green).toBe(original.green);
  await page.locator('.workspace-history > button').nth(0).click();
  const undone = inspect(await exported(page));
  expect(undone.paragraph).toEqual(original.paragraph);
  await page.locator('.workspace-history > button').nth(1).click();
  expect(inspect(await exported(page)).paragraph).toEqual(output.paragraph);
  await texts(page).first().dblclick();
  await expect(page.locator('.pdf-text-input')).toBeFocused();
  await page.locator('.pdf-text-input').fill('Moved paragraph remains editable');
  const edited = inspect(await exported(page));
  expect(edited.text.replace(/\s+/g, ' ')).toContain('Moved paragraph remains editable'); expect(edited.text).not.toContain(paragraph);
  expect(edited.images).toEqual(original.images);
  await page.locator('.text-block').filter({ hasText: 'Moved paragraph remains editable' }).click();
  await page.locator('.pdf-text-input').fill(paragraph);
  const restored = inspect(await exported(page));
  expect(restored.paragraph).toEqual(output.paragraph);
  expect(restored.images).toEqual(original.images);
});

for (const rotation of [90, 270]) test(`original image movement follows screen coordinates on Rotate${rotation}, CropBox and UserUnit2`, async ({ page }) => {
  const { original } = await open(page, rotation);
  // Rotation 270 places this image near the lower edge. Move upward there so
  // the expected delta tests coordinate mapping rather than page clamping.
  const dy = rotation === 270 ? -45 : 45;
  await page.keyboard.down('Alt');
  await drag(page, images(page).first(), 35, dy);
  await page.keyboard.up('Alt');
  const output = inspect(await exported(page));
  closeBounds(output.images[0], original.images[0].map((value, index) => value + (index % 2 ? dy * 2 : 70)));
  closeBounds(output.images[1], original.images[1]);
  expect(output.text).toContain(paragraph); expect(output.green).toBe(original.green);
});

test('narrow-screen bilingual controls preserve selection, allow keyboard movement and undo deletion', async ({ page }) => {
  const { original } = await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('0.5');
  await images(page).first().click();
  const selected = page.locator('.object-edit-layer [data-object-kind="image"].selected');
  const handles = selected.locator('[data-resize-handle]');
  await expect(handles).toHaveCount(8);
  const actions = (await page.locator('.object-edit-actions').boundingBox())!;
  for (const handle of await handles.all()) {
    const box = (await handle.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.x < actions.x + actions.width && box.x + box.width > actions.x
      && box.y < actions.y + actions.height && box.y + box.height > actions.y).toBe(false);
  }
  await page.locator('.main-toolbar .language-switcher button[lang="zh-CN"]').click();
  await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toContainText('编辑对象');
  await expect(selected).toHaveCount(1);
  await selected.focus(); await selected.press('Shift+ArrowRight');
  const moved = inspect(await exported(page));
  closeBounds(moved.images[0], original.images[0].map((value, index) => value + (index % 2 ? 0 : 10)));
  await page.locator('.main-toolbar .language-switcher button[lang="en"]').click();
  await expect(page.locator('.workspace-ribbon [data-command="edit-objects"]')).toContainText('Edit objects');
  await selected.focus(); await selected.press('Delete');
  expect(inspect(await exported(page)).images).toHaveLength(1);
  await page.locator('.workspace-history > button').nth(0).click();
  expect(inspect(await exported(page)).images).toEqual(moved.images);
});

test('opening another PDF cancels an in-progress object transform', async ({ page }) => {
  await open(page);
  await startDrag(page, images(page).first(), 60, 60);
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'new-document.pdf', mimeType: 'application/pdf', buffer: await fixture(0, 'Different document') });
  await expect(page.locator('.document-title')).toHaveText('new-document.pdf');
  await page.mouse.up();
  const output = inspect(await exported(page)), expected = inspect(await fixture(0, 'Different document'));
  expect(output.images).toEqual(expected.images);
  expect(output.text).toContain('Different document'); expect(output.text).not.toContain(paragraph);
  await expect(page.locator('.workspace-history > button').nth(0)).toBeDisabled();
});

test('a full-page background image does not intercept selection and movement of text above it', async ({ page }) => {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 650]);
  const background = await pdf.embedPng(bitmapPNG([240, 245, 255]));
  sheet.drawImage(background, { x: 0, y: 0, width: 500, height: 650 });
  sheet.drawText(paragraph, { x: 50, y: 540, size: 18 });
  const bytes = await pdf.save(), original = inspect(bytes);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'background-and-text.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.workspace-ribbon [data-command="edit-objects"]').click();
  await expect(texts(page)).toHaveCount(1); await expect(images(page)).toHaveCount(1);
  await drag(page, texts(page).first(), 35, 40);
  await expect(page.locator('.object-edit-layer [data-object-kind="text"].selected')).toHaveCount(1);
  const output = inspect(await exported(page));
  expect(output.paragraph!.x - original.paragraph!.x).toBeCloseTo(35, 1);
  expect(output.paragraph!.y - original.paragraph!.y).toBeCloseTo(40, 1);
  expect(output.images).toEqual(original.images);
  expect(output.text).toContain(paragraph);
});
