import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function fixture() {
  const document = await PDFDocument.create(), first = document.addPage([400, 600]);
  first.drawText('ORIGINAL CONTENT', { x: 30, y: 520, size: 14 });
  first.drawText('PAGE ONE', { x: 30, y: 80, size: 12 });
  const field = document.getForm().createTextField('Name');
  field.setText('Original'); field.addToPage(first, { x: 30, y: 440, width: 200, height: 25 });
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
  try {
    const samples = pixels.getPixels();
    for (let index = 0; index < samples.length; index += 3) samples.set([255, 0, 0], index);
    first.drawImage(await document.embedPng(pixels.asPNG()), { x: 280, y: 250, width: 35, height: 35 });
  } finally { pixels.destroy(); }
  document.addPage([400, 600]).drawText('PAGE TWO', { x: 30, y: 520, size: 14 });
  return Buffer.from(await document.save());
}

async function open(page: Page) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'unified-history.pdf', mimeType: 'application/pdf', buffer: await fixture() });
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Original');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

async function fillName(page: Page, value: string) {
  const field = page.getByRole('textbox', { name: 'Name', exact: true });
  await field.fill('');
  await field.pressSequentially(value);
  await field.press('Tab');
}

async function drawRectangle(page: Page) {
  await page.getByTitle('Rectangle', { exact: true }).click();
  const bounds = await page.locator('.drawing-annotation-layer').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.1, bounds!.y + bounds!.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.35, bounds!.y + bounds!.height * 0.5, { steps: 5 });
  await page.mouse.up();
}

async function editOriginalText(page: Page) {
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'ORIGINAL CONTENT' }).dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await editor.fill('');
  await editor.pressSequentially('UPDATED CONTENT');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
}

async function deleteOriginalImage(page: Page) {
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '🖼 Edit Images', exact: true }).click();
  await page.getByRole('button', { name: 'Select original image 1', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
}

interface ExpectedState { name: string; annotation: boolean; editedText: boolean; image: boolean; rotated: boolean; reordered: boolean }
const original: ExpectedState = { name: 'Original', annotation: false, editedText: false, image: true, rotated: false, reordered: false };

async function expectExport(page: Page, state: ExpectedState) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getForm().getTextField('Name').getText()).toBe(state.name);
  const contentPage = state.reordered ? 1 : 0;
  expect(pdf.getPage(contentPage).getRotation().angle).toBe(state.rotated ? 90 : 0);
  const rendered = new mupdf.PDFDocument(bytes);
  try {
    for (let index = 0; index < 2; index++) {
      const outputPage = rendered.loadPage(index), text = outputPage.toStructuredText('preserve-images');
      try {
        if (index !== contentPage) { expect(text.asText()).toContain('PAGE TWO'); continue; }
        expect(text.asText()).toContain('PAGE ONE');
        expect(text.asText()).toContain(state.editedText ? 'UPDATED CONTENT' : 'ORIGINAL CONTENT');
        expect(text.asText()).not.toContain(state.editedText ? 'ORIGINAL CONTENT' : 'UPDATED CONTENT');
        let images = 0;
        text.walk({ onImageBlock() { images++; } });
        expect(images).toBe(state.image ? 1 : 0);
        const pixmap = outputPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
        try {
          let bluePixels = 0;
          const pixels = pixmap.getPixels();
          for (let offset = 0; offset < pixels.length; offset += 3) {
            if (pixels[offset + 2] > pixels[offset] + 60 && pixels[offset + 2] > pixels[offset + 1] + 60) bluePixels++;
          }
          expect(bluePixels > 50).toBe(state.annotation);
        } finally { pixmap.destroy(); }
      } finally { text.destroy(); outputPage.destroy(); }
    }
  } finally { rendered.destroy(); }
}

async function historyStep(page: Page, direction: 'Undo' | 'Redo', name: string, documentOperation = false) {
  const previousCanvas = documentOperation ? await page.locator('canvas.page-canvas').elementHandle() : null;
  const button = page.getByTitle(`${direction} ${name} (${direction === 'Undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z'})`, { exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  if (previousCanvas) {
    await previousCanvas.waitForElementState('hidden');
    await expect(page.locator('canvas.page-canvas')).toBeVisible();
  }
  await expect(page.locator('.loading-state')).toHaveCount(0);
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('mixed edits undo and redo in exact order across page operations and refreshed sessions', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await fillName(page, 'Filled value');
  await drawRectangle(page);
  await editOriginalText(page);
  await deleteOriginalImage(page);
  await page.getByTitle('Rotate page 1 90° CW', { exact: true }).click();
  await expect(page.getByTitle('Undo Rotate page 1 90° (Ctrl+Z)', { exact: true })).toBeEnabled();
  await expect(page.locator('.loading-state')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move page 1 later', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number' })).toHaveValue('2');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();

  const states = [
    original,
    { ...original, name: 'Filled value' },
    { ...original, name: 'Filled value', annotation: true },
    { ...original, name: 'Filled value', annotation: true, editedText: true },
    { ...original, name: 'Filled value', annotation: true, editedText: true, image: false },
    { ...original, name: 'Filled value', annotation: true, editedText: true, image: false, rotated: true },
    { ...original, name: 'Filled value', annotation: true, editedText: true, image: false, rotated: true, reordered: true },
  ];
  const actions = ['Fill Name', 'Add annotation', 'Edit original text', 'Edit original image', 'Rotate page 1 90°', 'Reorder pages'];
  await expectExport(page, states[6]);
  for (let index = actions.length - 1; index >= 0; index--) {
    await historyStep(page, 'Undo', actions[index], index >= 4);
    await expectExport(page, states[index]);
  }
  await expect(page.locator('.combined-toolbar button[title^="Undo"]')).toBeDisabled();
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload();
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  for (let index = 0; index < actions.length; index++) {
    await historyStep(page, 'Redo', actions[index], index >= 4);
    await expectExport(page, states[index + 1]);
  }
  await expect(page.locator('.combined-toolbar button[title^="Redo"]')).toBeDisabled();
});

test('a new form edit after undo truncates annotation redo and survives refresh as one typing action', async ({ page }) => {
  await open(page);
  await fillName(page, 'First edit');
  await drawRectangle(page);
  await historyStep(page, 'Undo', 'Add annotation');
  await expect(page.getByTitle('Redo Add annotation (Ctrl+Shift+Z)', { exact: true })).toBeEnabled();
  await fillName(page, 'New branch');
  await expect(page.locator('.combined-toolbar button[title^="Redo"]')).toBeDisabled();
  await expectExport(page, { ...original, name: 'New branch' });
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('New branch');
  await expect(page.locator('.combined-toolbar button[title^="Redo"]')).toBeDisabled();
  await historyStep(page, 'Undo', 'Fill Name');
  await expectExport(page, { ...original, name: 'First edit' });
  await historyStep(page, 'Undo', 'Fill Name');
  await expectExport(page, original);
  await expect(page.locator('.combined-toolbar button[title^="Undo"]')).toBeDisabled();
});
