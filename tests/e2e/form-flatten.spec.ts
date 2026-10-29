import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import * as mupdf from 'mupdf';

const linkURL = 'https://example.org/retained-form-link';
const englishValue = 'Updated customer';
const chineseValue = '中文填写后的姓名';

function solidPNG(color: [number, number, number]) {
  const image = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  try {
    const pixels = image.getPixels();
    for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);
    return Buffer.from(image.asPNG());
  } finally { image.destroy(); }
}

async function fixture(contentImage = false) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  const form = document.getForm();
  const english = form.createTextField('English name');
  english.setText('Original customer');
  english.addToPage(page, { x: 50, y: 650, width: 300, height: 32 });
  english.setFontSize(14);
  const chinese = form.createTextField('中文姓名');
  chinese.addToPage(page, { x: 50, y: 580, width: 300, height: 32 });
  chinese.setFontSize(14);
  const checkbox = form.createCheckBox('Accepted');
  checkbox.addToPage(page, { x: 50, y: 500, width: 20, height: 20, borderWidth: 0 });
  checkbox.check();
  if (contentImage) {
    page.drawImage(await document.embedPng(solidPNG([255, 0, 0])), { x: 400, y: 400, width: 60, height: 40 });
  } else {
    const button = form.createButton('Image appearance');
    button.addToPage('', page, { x: 400, y: 650, width: 60, height: 60, borderWidth: 0 });
    button.setImage(await document.embedPng(solidPNG([0, 255, 0])));
  }
  const link = document.context.register(document.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [50, 400, 300, 430], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of(linkURL) },
  }));
  page.node.addAnnot(link);
  return Buffer.from(await document.save());
}

async function openAndFill(page: Page, contentImage = false) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'flatten-form.pdf', mimeType: 'application/pdf', buffer: await fixture(contentImage),
  });
  await expect(page.getByRole('textbox', { name: 'English name', exact: true })).toHaveValue('Original customer');
  await page.getByRole('textbox', { name: 'English name', exact: true }).fill(englishValue);
  await page.getByRole('textbox', { name: '中文姓名', exact: true }).fill(chineseValue);
  await expect(page.getByRole('checkbox', { name: 'Accepted', exact: true })).toBeChecked();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

async function flatten(page: Page) {
  await page.getByRole('button', { name: /^Form .*▾$/ }).click();
  await page.getByRole('button', { name: 'Flatten Form (Make Static)', exact: true }).click();
  await expect(page.locator('.form-field')).toHaveCount(0);
  // Design Form remains available on a static PDF after the filling controls disappear.
  await expect(page.getByRole('button', { name: /^Form .*▾$/ })).toBeVisible();
  await expect(page.locator('.error-state')).toHaveCount(0);
}

async function download(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await ready).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function inspect(bytes: Buffer) {
  const document = await PDFDocument.load(bytes);
  const annotations = document.getPage(0).node.Annots();
  const links = (annotations?.asArray() ?? []).flatMap(reference => {
    const annotation = document.context.lookup(reference, PDFDict);
    if (annotation.lookup(PDFName.of('Subtype'), PDFName).asString() !== '/Link') return [];
    const action = annotation.lookup(PDFName.of('A'), PDFDict);
    return [{ uri: action.lookup(PDFName.of('URI'), PDFString, PDFHexString).decodeText(), rectangle: annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString())) }];
  });
  const engineDocument = new mupdf.PDFDocument(bytes);
  const page = engineDocument.loadPage(0);
  const text = page.toStructuredText('preserve-images');
  const images: number[][] = [];
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  try {
    text.walk({ onImageBlock(_bounds, _matrix, image) {
      const pixels = image.toPixmap();
      try { images.push(Array.from(pixels.getPixels().slice(0, 3))); }
      finally { pixels.destroy(); }
    } });
    let checkboxInk = 0;
    const samples = pixmap.getPixels();
    for (let y = 282; y < 298; y++) for (let x = 52; x < 68; x++) {
      const offset = (y * pixmap.getWidth() + x) * pixmap.getNumberOfComponents();
      if (samples[offset] < 80 && samples[offset + 1] < 80 && samples[offset + 2] < 80) checkboxInk++;
    }
    return { fields: document.getForm().getFields(), links, text: text.asText(), images, checkboxInk };
  } finally { pixmap.destroy(); text.destroy(); page.destroy(); engineDocument.destroy(); }
}

function assertStatic(result: Awaited<ReturnType<typeof inspect>>, hasImage: boolean) {
  expect(result.fields).toHaveLength(0);
  expect(result.text).toContain(englishValue);
  expect(result.text).toContain(chineseValue);
  expect(result.checkboxInk).toBeGreaterThan(10);
  expect(result.links).toEqual([{ uri: linkURL, rectangle: [50, 400, 300, 430] }]);
  expect(result.images).toEqual(hasImage ? [[0, 255, 0]] : []);
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('flattening preserves Unicode text, checkbox and image appearances, links, and undo/redo values', async ({ page }) => {
  await openAndFill(page);
  await flatten(page);
  assertStatic(await inspect(await download(page)), true);
  await page.getByTitle('Undo Flatten form (Ctrl+Z)', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'English name', exact: true })).toHaveValue(englishValue);
  await expect(page.getByRole('textbox', { name: '中文姓名', exact: true })).toHaveValue(chineseValue);
  await expect(page.getByRole('checkbox', { name: 'Accepted', exact: true })).toBeChecked();
  await page.getByTitle('Redo Flatten form (Ctrl+Shift+Z)', { exact: true }).click();
  await expect(page.locator('.form-field')).toHaveCount(0);
  assertStatic(await inspect(await download(page)), true);
});

test('flattening also applies a pending original-image deletion and restores it as a pending edit on undo', async ({ page }) => {
  await openAndFill(page, true);
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '🖼 Edit Images', exact: true }).click();
  await expect(page.locator('.image-box')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select original image 1', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeVisible();
  await flatten(page);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
  assertStatic(await inspect(await download(page)), false);

  await page.getByTitle('Undo Flatten form (Ctrl+Z)', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '中文姓名', exact: true })).toHaveValue(chineseValue);
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeVisible();
  const restored = await inspect(await download(page));
  expect(restored.fields).toHaveLength(3);
  expect(restored.images).toEqual([]);
  await page.getByTitle('Redo Flatten form (Ctrl+Shift+Z)', { exact: true }).click();
  await expect(page.locator('.form-field')).toHaveCount(0);
  assertStatic(await inspect(await download(page)), false);
});
