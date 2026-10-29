import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

async function openFormDocument(page: Page) {
  const document = await PDFDocument.create();
  const firstPage = document.addPage([400, 600]);
  document.addPage([400, 600]);
  const field = document.getForm().createTextField('Customer name');
  field.setText('Original value');
  field.addToPage(firstPage, { x: 30, y: 500, width: 240, height: 25 });
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'session-form.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()),
  });
  await expect(page.getByRole('textbox', { name: 'Customer name' })).toHaveValue('Original value');
  await expect(page.locator('.page-wrapper[data-page="1"] .page-loading-overlay')).toHaveCount(0);
}

async function hasDrawing(page: Page) {
  return page.locator('.annotation-canvas').first().evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 0) return true;
    }
    return false;
  });
}

async function drawRectangle(page: Page) {
  await page.getByTitle('Rectangle', { exact: true }).click();
  const bounds = await page.locator('.drawing-annotation-layer').first().boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 60, bounds!.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 180, bounds!.y + 260, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => hasDrawing(page)).toBe(true);
}

async function waitForSaved(page: Page) {
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
}

async function insertBlankPage(page: Page) {
  await page.getByRole('button', { name: '+ Insert ▾', exact: true }).click();
  // The first section inserts a blank page; the second inserts pages from a file.
  await page.getByRole('button', { name: 'After current', exact: true }).first().click();
  await expect(page.locator('.page-total')).toHaveText('3');
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
});

test('refresh restores annotations and form edits, and Reset keeps the initial original PDF', async ({ page }) => {
  await openFormDocument(page);
  await page.getByRole('textbox', { name: 'Customer name' }).fill('Saved customer');
  await drawRectangle(page);
  await insertBlankPage(page);
  await waitForSaved(page);

  await page.reload();
  await expect(page.locator('.page-total')).toHaveText('3');
  await expect(page.getByRole('textbox', { name: 'Customer name' })).toHaveValue('Saved customer');
  await expect.poll(() => hasDrawing(page)).toBe(true);

  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: '⟲ Reset to Original', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('.page-total')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: 'Customer name' })).toHaveValue('Original value');
  await expect.poll(() => hasDrawing(page)).toBe(false);
});

test('document history survives refresh and restores the editable workspace on undo', async ({ page }) => {
  await openFormDocument(page);
  await page.getByRole('textbox', { name: 'Customer name' }).fill('Keep this edit');
  await drawRectangle(page);
  await insertBlankPage(page);
  await waitForSaved(page);
  await page.reload();
  await expect(page.locator('.page-total')).toHaveText('3');

  await page.locator('.combined-toolbar button[title^="Undo"]').click();
  await expect(page.locator('.page-total')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: 'Customer name' })).toHaveValue('Keep this edit');
  await expect.poll(() => hasDrawing(page)).toBe(true);
});

test('closing a saved editing session prevents it from returning on refresh', async ({ page }) => {
  await openFormDocument(page);
  await page.getByRole('textbox', { name: 'Customer name' }).fill('Do not restore after close');
  await waitForSaved(page);
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: '✕ Close Document', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close Without Saving', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Open a PDF' })).toBeVisible();
  await expect(page.locator('.page-wrapper')).toHaveCount(0);
});
