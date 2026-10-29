import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createScannedPDF } from '../fixtures/ocrPDF';

const original = 'Existing original text on page two';
const replacement = 'Pending content remains';

async function fixture() {
  const document = await PDFDocument.load(await createScannedPDF());
  const second = document.addPage([400, 600]);
  second.drawText(original, { x: 30, y: 520, size: 16 });
  const field = document.getForm().createTextField('OCR preserved field');
  field.setText('Original field'); field.addToPage(second, { x: 30, y: 440, width: 200, height: 25 });
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
  try {
    const data = pixels.getPixels();
    for (let index = 0; index < data.length; index += 3) data.set([255, 0, 0], index);
    second.drawImage(await document.embedPng(pixels.asPNG()), { x: 280, y: 250, width: 35, height: 35 });
  } finally { pixels.destroy(); }
  return Buffer.from(await document.save());
}

async function openOCR(page: Page) {
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: 'Scan OCR…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Scan OCR', exact: true });
}

async function exportPDF(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await pending).createReadStream())!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function extracted(bytes: Buffer) {
  const document = new mupdf.PDFDocument(bytes);
  try {
    return Array.from({ length: document.countPages() }, (_, index) => {
      const page = document.loadPage(index), text = page.toStructuredText('preserve-images');
      try {
        let images = 0;
        text.walk({ onImageBlock() { images++; } });
        const pixels = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
        try {
          let bluePixels = 0;
          const data = pixels.getPixels();
          for (let offset = 0; offset < data.length; offset += 3) {
            if (data[offset + 2] > data[offset] + 60 && data[offset + 2] > data[offset + 1] + 60) bluePixels++;
          }
          return { text: text.asText(), images, bluePixels, pixels: Buffer.from(pixels.getPixels()) };
        } finally { pixels.destroy(); }
      } finally { text.destroy(); page.destroy(); }
    });
  } finally { document.destroy(); }
}

test('OCR commits searchable scans with pending content edits, preserves overlays, skips existing text and survives history and refresh', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const input = await fixture();
  const before = extracted(input);
  expect(before[0].text.trim()).toBe('');
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'scanned-workspace.pdf', mimeType: 'application/pdf', buffer: input });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  const navigation = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  await navigation.fill('2'); await navigation.press('Enter');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.getByRole('textbox', { name: 'OCR preserved field', exact: true }).fill('Unsaved form value');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: original }).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit text on page 2', exact: true });
  await editor.fill(replacement); await editor.press('Enter');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '🖼 Edit Images', exact: true }).click();
  await page.getByRole('button', { name: 'Select original image 1', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByTitle('Rectangle', { exact: true }).click();
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 40, bounds.y + 360); await page.mouse.down();
  await page.mouse.move(bounds.x + 150, bounds.y + 420, { steps: 5 }); await page.mouse.up();
  await page.getByTitle('Select (V)', { exact: true }).click();

  const dialog = await openOCR(page);
  await expect(dialog.getByLabel('Pages', { exact: true })).toHaveValue('1-2');
  await expect(dialog.getByRole('checkbox', { name: 'Skip pages that already contain text' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Start OCR', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Searchable text added to 1 page.', { timeout: 90_000 });
  await expect(dialog.locator('tbody tr').nth(0)).toContainText('Text added');
  await expect(dialog.locator('tbody tr').nth(1)).toContainText('Skipped: existing text');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo Scan OCR', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);

  // Hidden OCR glyphs support search/copy, but changing them would leave the
  // original scanned pixels underneath. The editor must refuse that operation.
  await navigation.fill('1'); await navigation.press('Enter');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await expect(page.locator('.text-edit-readonly')).toContainText('invisible OCR text layer');
  await page.locator('.text-block').first().dblclick();
  await expect(page.getByRole('textbox', { name: 'Edit text on page 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo Scan OCR', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Exit text editing', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Invoice number 739251');

  const output = await exportPDF(page), after = extracted(output);
  expect(after[0].text).toContain('Invoice number 739251');
  expect(after[0].pixels.equals(before[0].pixels)).toBe(true);
  expect(after[1].text).toContain(replacement);
  expect(after[1].text).not.toContain(original);
  expect(after[1].images).toBe(0);
  expect(after[1].bluePixels).toBeGreaterThan(100);
  expect((await PDFDocument.load(output)).getForm().getTextField('OCR preserved field').getText()).toBe('Unsaved form value');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  expect(extracted(await exportPDF(page)).map(result => result.text)).toEqual(after.map(result => result.text));

  // Running again with the default skip option must not create a no-op history step.
  const repeated = await openOCR(page);
  await repeated.getByRole('button', { name: 'Start OCR', exact: true }).click();
  await expect(repeated.getByRole('status')).toContainText('No text was added.', { timeout: 30_000 });
  await repeated.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Undo Scan OCR', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toBeVisible();
  const undone = extracted(await exportPDF(page));
  expect(undone[0].text.trim()).toBe('');
  expect(undone[1].text).toContain(replacement);
  await page.getByRole('button', { name: 'Redo Scan OCR', exact: true }).click();
  expect(extracted(await exportPDF(page)).map(result => result.text)).toEqual(after.map(result => result.text));
});
