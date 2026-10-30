import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';

test('page deletion, undo, reorder and export keep the filled form and its annotation together', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const source = await PDFDocument.create();
  source.setTitle('Preserved title');
  source.addPage([400, 600]);
  const second = source.addPage([400, 600]);
  source.addPage([400, 600]);
  const field = source.getForm().createTextField('Client');
  field.setText('Initial');
  field.addToPage(second, { x: 30, y: 500, width: 200, height: 24 });
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'editing.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number' });
  await expect(pageNumber).toHaveValue('1');
  await pageNumber.fill('2');
  await pageNumber.press('Enter');
  await page.getByRole('textbox', { name: 'Client', exact: true }).fill('Edited client');
  await page.getByTitle('Rectangle', { exact: true }).click();
  const bounds = await page.locator('.drawing-annotation-layer').boundingBox();
  await page.mouse.move(bounds!.x + 50, bounds!.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 180, bounds!.y + 260, { steps: 5 });
  await page.mouse.up();

  await pageNumber.fill('1');
  await pageNumber.press('Enter');
  await page.getByRole('tab', { name: 'Organize', exact: true }).click();
  await page.locator('.workspace-ribbon [data-command="delete-pages"]').click();
  await expect(page.locator('.page-total')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: 'Client', exact: true })).toHaveValue('Edited client');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  const savedPages = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pdf-editor-storage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('pdfs', 'readonly');
    const request = transaction.objectStore('pdfs').get('current-session');
    return new Promise<number[]>((resolve, reject) => {
      transaction.oncomplete = () => {
        db.close();
        resolve([...request.result.workspace.annotations.values()].flat().map((annotation: { pageNumber: number }) => annotation.pageNumber));
      };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  });
  await expect.poll(savedPages).toEqual([1]);

  await page.locator('.combined-toolbar button[title^="Undo"]').click();
  await expect(page.locator('.page-total')).toHaveText('3');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await expect.poll(savedPages).toEqual([2]);
  await page.locator('.combined-toolbar button[title^="Redo"]').click();
  await expect(page.locator('.page-total')).toHaveText('2');
  await page.getByRole('button', { name: 'Move page 1 later', exact: true }).click();
  await expect(pageNumber).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Client', exact: true })).toHaveValue('Edited client');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await expect.poll(savedPages).toEqual([2]);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const output = Buffer.concat(chunks);
  const exported = await PDFDocument.load(output);
  expect(exported.getPageCount()).toBe(2);
  expect(exported.getTitle()).toBe('Preserved title');
  expect(exported.getForm().getTextField('Client').getText()).toBe('Edited client');
  expect(await extractFormFields(new Uint8Array(output).buffer)).toMatchObject([
    { name: 'Client', pageNumber: 2, value: 'Edited client' },
  ]);
});
