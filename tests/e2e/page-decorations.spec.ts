import { Buffer } from 'node:buffer';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectPageDecorations } from '../../src/core/PageDecorations';

async function openPDF(page: Page, bytes: Uint8Array) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'decorations.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible(); await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function openDecorations(page: Page) {
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: 'Watermarks, Headers & Backgrounds…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Watermarks, Headers & Backgrounds', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Decorations', exact: true })).toBeVisible(); return dialog;
}
async function previewReady(dialog: Locator) {
  await expect(dialog.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.decoration-pdf-preview')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.locator('canvas')).toBeVisible();
}
async function numeric(dialog: Locator, name: string, value: number) { const input = dialog.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Enter'); }
async function apply(dialog: Locator) { await dialog.getByRole('button', { name: 'Apply decorations', exact: true }).click(); await expect(dialog).toHaveCount(0, { timeout: 30_000 }); }
async function download(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click(); const chunks: Buffer[] = [];
  for await (const chunk of (await (await pending).createReadStream())!) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
function pageContents(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes);
  try { return Array.from({ length: pdf.countPages() }, (_, index) => {
    const page = pdf.loadPage(index), text = page.toStructuredText(''); let images = 0;
    const device = new mupdf.Device({ fillImage() { images++; } });
    try { page.runPageContents(device, mupdf.Matrix.identity); device.close(); return { text: text.asText(), images }; } finally { device.destroy(); text.destroy(); page.destroy(); }
  }); } finally { pdf.destroy(); }
}
function solidPNG(rgb: [number, number, number]) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  try { const pixels = pixmap.getPixels(); for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(rgb, offset); return Buffer.from(pixmap.asPNG()); } finally { pixmap.destroy(); }
}
function bluePixels(png: Buffer) {
  const image = new mupdf.Image(png), pixmap = image.toPixmap();
  try { const pixels = pixmap.getPixels(), channels = pixmap.getNumberOfComponents(); let count = 0;
    for (let offset = 0; offset < pixels.length; offset += channels) if (pixels[offset] < 100 && pixels[offset + 1] < 160 && pixels[offset + 2] > 140) count++;
    return count;
  } finally { pixmap.destroy(); image.destroy(); }
}
async function canvasPNG(canvas: Locator) {
  return Buffer.from((await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL('image/png'))).split(',')[1], 'base64');
}
test.beforeEach(async ({ page }) => { page.on('dialog', dialog => dialog.accept()); await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('previews and applies Unicode watermarks, page/Bates headers, and backgrounds while preserving pending content/forms and full history', async ({ page }) => {
  test.setTimeout(120_000);
  const source = await PDFDocument.create();
  for (let index = 0; index < 3; index++) {
    const item = source.addPage([500, 600]); item.drawText(`Original on page ${index + 1}`, { x: 80, y: 400, size: 14 });
    if (!index) { item.setCropBox(50, 100, 300, 400); item.setRotation(degrees(90)); item.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  }
  const field = source.getForm().createTextField('Preserved value'); field.setText('Original'); field.addToPage(source.getPage(0), { x: 80, y: 320, width: 180, height: 24 });
  await openPDF(page, await source.save());
  await page.getByRole('textbox', { name: 'Preserved value', exact: true }).fill('Pending 中文 value');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click(); await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original on page 1' }).dblclick();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ }); await editor.fill('Edited body'); await editor.press('Enter');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await page.getByTitle('Rectangle', { exact: true }).click(); const canvas = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 50, canvas.y + 50); await page.mouse.down(); await page.mouse.move(canvas.x + 120, canvas.y + 95, { steps: 5 }); await page.mouse.up();
  await page.getByTitle('Select (V)', { exact: true }).click(); await page.keyboard.press('Escape');
  let dialog = await openDecorations(page);
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Confidential mark');
  await dialog.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('机密 CONFIDENTIAL');
  await numeric(dialog, 'Font size', 24); await numeric(dialog, 'Rotation (clockwise degrees)', 20);
  await dialog.getByRole('combobox', { name: 'Page filter', exact: true }).selectOption('odd');
  await previewReady(dialog);
  expect(bluePixels(await dialog.locator('canvas').screenshot())).toBeGreaterThan(10);
  await dialog.getByRole('combobox', { name: 'Preview page', exact: true }).selectOption('2'); await previewReady(dialog);
  await dialog.getByRole('button', { name: 'Add headers & footers', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Case numbers');
  await dialog.getByRole('textbox', { name: 'Header left', exact: true }).fill('{bates}');
  await dialog.getByRole('textbox', { name: 'Footer center', exact: true }).fill('{page} / {pages}');
  await numeric(dialog, 'Starting page number', 10); await numeric(dialog, 'Bates starting number', 42); await numeric(dialog, 'Bates digits', 4);
  await dialog.getByRole('textbox', { name: 'Bates prefix', exact: true }).fill('CN-'); await dialog.getByRole('textbox', { name: 'Bates suffix', exact: true }).fill('-S');
  await dialog.getByRole('button', { name: 'Add background', exact: true }).click();
  await dialog.getByLabel('Background color', { exact: true }).evaluate(element => {
    const input = element as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#ddeeff'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }); await numeric(dialog, 'Opacity (%)', 30);
  await previewReady(dialog); await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: test.info().outputPath('decorations-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Apply decorations', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('decorations-narrow-preview.png') });
  await dialog.getByLabel('Background color', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('decorations-narrow-settings.png') });
  await page.setViewportSize({ width: 1280, height: 900 }); await apply(dialog);
  await expect(page.getByRole('textbox', { name: 'Preserved value', exact: true })).toHaveValue('Pending 中文 value');
  expect(bluePixels(await canvasPNG(page.locator('canvas.annotation-canvas')))).toBeGreaterThan(10);
  expect(bluePixels(await canvasPNG(page.locator('canvas.page-canvas')))).toBe(0);
  let bytes = await download(page), contents = pageContents(bytes);
  expect(contents[0].text).toContain('Edited body'); expect(contents[0].text).not.toContain('Original on page 1');
  for (const index of [0, 2]) expect(contents[index].text.replace(/\s/g, '')).toContain('机密CONFIDENTIAL');
  expect(contents[1].text).not.toContain('CONFIDENTIAL');
  for (let index = 0; index < 3; index++) { expect(contents[index].text).toContain(`CN-00${42 + index}-S`); expect(contents[index].text).toContain(`${10 + index} / 3`); }
  expect((await PDFDocument.load(bytes)).getForm().getTextField('Preserved value').getText()).toBe('Pending 中文 value');
  expect((await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations).toHaveLength(3);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/); await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Undo Update page decorations', exact: true }).click();
  expect(pageContents(await download(page))[0].text).not.toContain('CONFIDENTIAL');
  await page.getByRole('button', { name: 'Redo Update page decorations', exact: true }).click();
  dialog = await openDecorations(page); await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: 'Confidential mark' });
  await dialog.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('REVISED'); await previewReady(dialog); await apply(dialog);
  bytes = await download(page); contents = pageContents(bytes); expect(contents[0].text).toContain('REVISED'); expect(contents[0].text).not.toContain('CONFIDENTIAL');
  dialog = await openDecorations(page); await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: 'Confidential mark' }); await dialog.getByRole('button', { name: 'Remove decoration', exact: true }).click(); await previewReady(dialog); await apply(dialog);
  bytes = await download(page); expect(pageContents(bytes)[0].text).not.toContain('REVISED'); expect((await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations).toHaveLength(2);
});

test('creates editable image watermarks/backgrounds and canceling a draft leaves the PDF unchanged', async ({ page }) => {
  test.setTimeout(60_000);
  const red = solidPNG([255, 0, 0]), blue = solidPNG([0, 0, 255]), source = await PDFDocument.create();
  const first = source.addPage([400, 600]); first.drawText('Original page content', { x: 30, y: 540, size: 16 }); first.drawImage(await source.embedPng(red), { x: 20, y: 40, width: 20, height: 20 });
  await openPDF(page, await source.save()); let dialog = await openDecorations(page);
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click(); await dialog.getByRole('combobox', { name: 'Watermark type', exact: true }).selectOption('image');
  await dialog.getByLabel('Watermark image', { exact: true }).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: red });
  await numeric(dialog, 'Image width', 100); await numeric(dialog, 'Image height', 60); await numeric(dialog, 'Opacity (%)', 80);
  await dialog.getByRole('button', { name: 'Add background', exact: true }).click(); await dialog.getByRole('combobox', { name: 'Background type', exact: true }).selectOption('image');
  await dialog.getByLabel('Background image', { exact: true }).setInputFiles({ name: 'paper.png', mimeType: 'image/png', buffer: blue });
  await dialog.getByRole('combobox', { name: 'Image fit', exact: true }).selectOption('cover'); await numeric(dialog, 'Opacity (%)', 15); await previewReady(dialog); await apply(dialog);
  let bytes = await download(page); expect(pageContents(bytes)[0].images).toBe(3);
  const inspection = await inspectPageDecorations(new Uint8Array(bytes).buffer); expect(inspection.decorations).toHaveLength(2);
  const watermark = inspection.decorations.find(item => item.definition.kind === 'watermark')!.definition;
  expect(watermark).toMatchObject({ kind: 'watermark', content: { type: 'image', name: 'logo.png' } });
  if (watermark.kind !== 'watermark' || watermark.content.type !== 'image') throw new Error('Expected an editable image watermark');
  const image = new mupdf.Image(watermark.content.data), pixels = image.toPixmap();
  try { expect(pixels.getWidth()).toBe(8); expect(pixels.getHeight()).toBe(8); expect([...pixels.getPixels().subarray(0, 3)]).toEqual([255, 0, 0]); } finally { pixels.destroy(); image.destroy(); }
  dialog = await openDecorations(page); await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: 'Watermark' }); await dialog.getByRole('button', { name: 'Remove decoration', exact: true }).click(); await previewReady(dialog);
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click(); await expect(dialog).toHaveCount(0); bytes = await download(page);
  expect(pageContents(bytes)[0].images).toBe(3); expect((await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations).toHaveLength(2);
  dialog = await openDecorations(page); await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: 'Watermark' }); await dialog.getByRole('button', { name: 'Remove decoration', exact: true }).click(); await apply(dialog);
  expect(pageContents(await download(page))[0].images).toBe(2);
});

test('keeps owned text and image decorations separate from body editing and preserves ownership when original image occurrences change', async ({ page }) => {
  test.setTimeout(90_000);
  const source = await PDFDocument.create(), first = source.addPage([400, 600]);
  first.drawText('Original body text', { x: 40, y: 480, size: 16 });
  first.drawImage(await source.embedPng(solidPNG([255, 0, 0])), { x: 40, y: 300, width: 80, height: 60 });
  await openPDF(page, await source.save()); let dialog = await openDecorations(page);
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Owned text');
  await dialog.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('OWNED WATERMARK');
  await numeric(dialog, 'Font size', 18); await numeric(dialog, 'Rotation (clockwise degrees)', 0);
  await dialog.getByRole('combobox', { name: 'Position', exact: true }).selectOption('top-center'); await numeric(dialog, 'Vertical offset', 20);
  await dialog.getByRole('button', { name: 'Add background', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Owned background');
  await dialog.getByRole('combobox', { name: 'Background type', exact: true }).selectOption('image');
  await dialog.getByLabel('Background image', { exact: true }).setInputFiles({ name: 'blue-background.png', mimeType: 'image/png', buffer: solidPNG([0, 0, 255]) });
  await dialog.getByRole('combobox', { name: 'Image fit', exact: true }).selectOption('stretch'); await numeric(dialog, 'Opacity (%)', 5);
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Owned logo');
  await dialog.getByRole('combobox', { name: 'Watermark type', exact: true }).selectOption('image');
  await dialog.getByLabel('Watermark image', { exact: true }).setInputFiles({ name: 'yellow-logo.png', mimeType: 'image/png', buffer: solidPNG([255, 255, 0]) });
  await numeric(dialog, 'Image width', 60); await numeric(dialog, 'Image height', 40); await numeric(dialog, 'Rotation (clockwise degrees)', 0); await numeric(dialog, 'Opacity (%)', 100);
  await dialog.getByRole('combobox', { name: 'Position', exact: true }).selectOption('bottom-right'); await numeric(dialog, 'Horizontal offset', -20); await numeric(dialog, 'Vertical offset', -20);
  await previewReady(dialog); await apply(dialog);
  const originalMarks = (await inspectPageDecorations(new Uint8Array(await download(page)).buffer)).decorations;
  expect(originalMarks).toHaveLength(3); expect(originalMarks.every(mark => mark.managed)).toBe(true);

  // This uses real PDF.js marked-content records; no store injection or detector mocks.
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click(); await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await expect(page.locator('.text-block').filter({ hasText: 'Original body text' })).toHaveCount(1);
  await expect(page.locator('.text-block').filter({ hasText: 'OWNED WATERMARK' })).toHaveCount(0);
  await page.locator('.text-block').filter({ hasText: 'Original body text' }).dblclick();
  const editor = page.getByRole('textbox', { name: /^Edit text on page/ }); await editor.fill('Updated body'); await editor.press('Enter');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click(); await page.getByRole('button', { name: '🖼 Edit Images', exact: true }).click();
  await expect(page.locator('.image-box')).toHaveCount(3);
  // Background image precedes the body image; foreground logo follows it. Detaching
  // both owned images must remap the original occurrence from index 1 to index 0.
  for (const number of [1, 3]) {
    await page.getByRole('button', { name: `Select original image ${number}`, exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(page.getByText('Edit this image in Document → Watermarks, Headers & Backgrounds…', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Select original image 2', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeEnabled();
  await page.getByLabel('Replacement image', { exact: true }).setInputFiles({ name: 'green-original.png', mimeType: 'image/png', buffer: solidPNG([0, 255, 0]) });
  await expect(page.getByRole('button', { name: 'Select original image 2', exact: true })).toHaveClass(/pending/);
  let bytes = await download(page), contents = pageContents(bytes);
  expect(contents[0].text).toContain('Updated body'); expect(contents[0].text).not.toContain('Original body text'); expect(contents[0].text).toContain('OWNED WATERMARK'); expect(contents[0].images).toBe(3);
  const changedMarks = (await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations;
  expect(changedMarks.map(mark => mark.id).sort()).toEqual(originalMarks.map(mark => mark.id).sort()); expect(changedMarks.every(mark => mark.managed)).toBe(true);
  const pdf = new mupdf.PDFDocument(bytes), paintedPage = pdf.loadPage(0), pixels = paintedPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    const samples = pixels.getPixels(), width = pixels.getWidth(), channels = pixels.getNumberOfComponents();
    const color = (x: number, y: number) => [...samples.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
    expect(color(80, 270)).toEqual([0, 255, 0]); // original red image was replaced
    expect(color(340, 560)).toEqual([255, 255, 0]); // foreground decoration is intact
    expect(color(200, 400)[2]).toBeGreaterThan(color(200, 400)[0]); // background stays blue
  } finally { pixels.destroy(); paintedPage.destroy(); pdf.destroy(); }

  await page.getByTitle('Select (V)', { exact: true }).click(); dialog = await openDecorations(page);
  await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: 'Owned text' });
  await dialog.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('UPDATED OWNED MARK'); await previewReady(dialog); await apply(dialog);
  bytes = await download(page); expect(pageContents(bytes)[0].text).toContain('UPDATED OWNED MARK'); expect(pageContents(bytes)[0].text).toContain('Updated body');
  expect((await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations.every(mark => mark.managed)).toBe(true);
  dialog = await openDecorations(page);
  for (const name of ['Owned text', 'Owned background', 'Owned logo']) {
    await dialog.getByRole('combobox', { name: 'Decorations', exact: true }).selectOption({ label: name }); await dialog.getByRole('button', { name: 'Remove decoration', exact: true }).click();
  }
  await previewReady(dialog); await apply(dialog); bytes = await download(page); contents = pageContents(bytes);
  expect(contents[0].images).toBe(1); expect(contents[0].text).toContain('Updated body'); expect(contents[0].text).not.toContain('OWNED');
  expect((await inspectPageDecorations(new Uint8Array(bytes).buffer)).decorations).toHaveLength(0);
});
