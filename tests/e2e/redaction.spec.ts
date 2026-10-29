import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

const secret = 'PRIVATE_PDF_SECRET_91827';
const publicText = 'PUBLIC_PDF_CONTENT_REMAINS';

test.beforeEach(async ({ page }) => {
  // Exercise the actual browser download path; native OS save dialogs cannot be
  // controlled by Playwright.
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

async function fixture(croppedRotated = false, forms = false) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  if (croppedRotated) {
    page.setCropBox(50, 100, 400, 500);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  }
  const secretY = croppedRotated ? 530 : 700;
  page.drawText(secret, { x: 80, y: secretY, size: 14 });
  page.drawText(publicText, { x: 80, y: 350, size: 14 });
  if (forms) {
    const secretField = document.getForm().createTextField('private field');
    secretField.setText('INITIAL_PRIVATE_FIELD');
    secretField.addToPage(page, { x: 80, y: 620, width: 300, height: 35, borderWidth: 0 });
    const publicField = document.getForm().createTextField('public field');
    publicField.setText('INITIAL_PUBLIC_FIELD');
    publicField.addToPage(page, { x: 80, y: 250, width: 300, height: 35, borderWidth: 0 });
  }
  const bytes = Buffer.from(await document.save());
  const native = new mupdf.PDFDocument(bytes);
  const nativePage = native.loadPage(0);
  try {
    const pdfRect: mupdf.Rect = forms ? [65, 600, 430, 730] : [65, secretY - 10, 430, secretY + 25];
    return { bytes, bounds: nativePage.getBounds(), region: mupdf.Rect.transform(pdfRect, nativePage.getTransform()) };
  } finally { nativePage.destroy(); native.destroy(); }
}

async function open(page: Page, bytes: Buffer) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'content-removal.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

async function markRegion(page: Page, source: Awaited<ReturnType<typeof fixture>>) {
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '■ Mark Content Areas', exact: true }).click();
  const layer = page.locator('.redaction-layer');
  await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;
  const [left, top, right, bottom] = source.region;
  const scaleX = box.width / (source.bounds[2] - source.bounds[0]);
  const scaleY = box.height / (source.bounds[3] - source.bounds[1]);
  await page.mouse.move(box.x + left * scaleX, box.y + top * scaleY);
  await page.mouse.down();
  await page.mouse.move(box.x + right * scaleX, box.y + bottom * scaleY, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.redaction-box.pending')).toHaveCount(1);
}

async function removeContent(page: Page) {
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  const confirmation = page.waitForEvent('dialog');
  const click = page.getByRole('button', { name: 'Remove Selected Page Content', exact: true }).click();
  const dialog = await confirmation;
  expect(dialog.message()).toContain('Metadata and attachments are not cleaned');
  expect(dialog.message()).toContain('Local undo history retains the original');
  await dialog.accept();
  await click;
  await expect(page.getByTitle('Undo Remove selected page content (Ctrl+Z)', { exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.error-state')).toHaveCount(0);
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}

async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const downloaded = await pending;
  return readFile((await downloaded.path())!);
}

function textOf(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes);
  const page = document.loadPage(0);
  try {
    const text = page.toStructuredText('');
    try { return text.asText(); } finally { text.destroy(); }
  } finally { page.destroy(); document.destroy(); }
}

for (const croppedRotated of [false, true]) {
  test(`removes selected PDF text through the UI on a ${croppedRotated ? 'rotated cropped UserUnit=2' : 'normal'} page`, async ({ page }) => {
    const source = await fixture(croppedRotated);
    await open(page, source.bytes);
    await markRegion(page, source);
    await removeContent(page);
    const removed = await download(page);
    expect(textOf(removed)).not.toContain(secret);
    expect(textOf(removed)).toContain(publicText);

    await page.getByTitle('Undo Remove selected page content (Ctrl+Z)', { exact: true }).click();
    await expect(page.getByTitle('Redo Remove selected page content (Ctrl+Shift+Z)', { exact: true })).toBeEnabled();
    expect(textOf(await download(page))).toContain(secret);
    await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
    await page.getByRole('button', { name: '■ Mark Content Areas', exact: true }).click();
    await expect(page.locator('.redaction-box.pending')).toHaveCount(1);
  });
}

test('removal includes live form values, makes remaining fields static, and undo restores the workspace', async ({ page }) => {
  const source = await fixture(false, true);
  await open(page, source.bytes);
  await page.getByRole('textbox', { name: 'private field', exact: true }).fill('UI_FORM_SECRET_715');
  await page.getByRole('textbox', { name: 'public field', exact: true }).fill('UI_PUBLIC_FIELD_164');
  await markRegion(page, source);
  await removeContent(page);
  await expect(page.locator('.form-field')).toHaveCount(0);
  const removed = await download(page);
  const text = textOf(removed);
  expect(text).not.toContain(secret);
  expect(text).not.toContain('UI_FORM_SECRET_715');
  expect(text).toContain(publicText);
  expect(text).toContain('UI_PUBLIC_FIELD_164');
  expect((await PDFDocument.load(removed)).getForm().getFields()).toHaveLength(0);

  await page.getByTitle('Undo Remove selected page content (Ctrl+Z)', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'private field', exact: true })).toHaveValue('UI_FORM_SECRET_715');
  await expect(page.getByRole('textbox', { name: 'public field', exact: true })).toHaveValue('UI_PUBLIC_FIELD_164');
  const restored = await PDFDocument.load(await download(page));
  expect(restored.getForm().getTextField('private field').getText()).toBe('UI_FORM_SECRET_715');
  expect(restored.getForm().getTextField('public field').getText()).toBe('UI_PUBLIC_FIELD_164');
});
