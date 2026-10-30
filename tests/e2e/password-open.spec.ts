import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

const password = '中文,"reader"\\=😀';

async function fixture(encrypted = true, openingPassword = password) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  page.drawText('ENCRYPTED SOURCE CONTENT', { x: 60, y: 680, size: 18 });
  const field = document.getForm().createTextField('Customer name');
  field.setText('Original value');
  field.addToPage(page, { x: 60, y: 500, width: 280, height: 35 });
  const original = await document.save();
  if (!encrypted) return Buffer.from(original);
  const pdf = new mupdf.PDFDocument(original);
  try {
    const result = pdf.saveToBuffer({ encrypt: 'aes-256', 'user-password': openingPassword,
      'owner-password': 'owner-secret', permissions: -1, compress: true });
    try { return Buffer.from(result.asUint8Array()); }
    finally { result.destroy(); }
  } finally { pdf.destroy(); }
}

async function openFile(page: Page, name: string, buffer: Buffer) {
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

async function download(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const result = await ready;
  return readFile((await result.path())!);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('/');
});

test('unlocks with retry, edits forms, restores without storing passwords, and resets from the encrypted original', async ({ page }) => {
  const original = await fixture();
  await openFile(page, 'protected.pdf', original);
  const dialog = page.getByRole('dialog', { name: 'Unlock PDF', exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(dialog).toContainText('saved in this browser for recovery');
  await expect(dialog).toContainText('Ordinary exports are unencrypted');
  await expect(page.getByLabel('PDF password', { exact: true })).toBeFocused();
  await page.getByLabel('PDF password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Unlock PDF', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Incorrect password. Please try again.');
  await expect(page.getByLabel('PDF password', { exact: true })).toHaveValue('');
  await page.getByLabel('PDF password', { exact: true }).fill(password);
  await page.getByLabel('PDF password', { exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Original value');
  await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Edited after unlock');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);

  const exported = await download(page);
  const pdf = await PDFDocument.load(exported);
  expect(pdf.isEncrypted).toBe(false);
  expect(pdf.getForm().getTextField('Customer name').getText()).toBe('Edited after unlock');

  const cached = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pdf-editor-storage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ original: number[]; values: string }>((resolve, reject) => {
        const transaction = database.transaction('pdfs', 'readonly');
        const request = transaction.objectStore('pdfs').getAll();
        transaction.oncomplete = () => {
          const original = request.result.find(record => record.id === 'current-history').originalDocument;
          const data = original.pdfRevision ? request.result.find(record => record.id === original.pdfRevision)?.data : original.data;
          if (!(data instanceof ArrayBuffer)) { reject(new Error('Original PDF revision is missing')); return; }
          resolve({ original: Array.from(new Uint8Array(data)), values: JSON.stringify(request.result) });
        };
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  });
  expect(Buffer.from(cached.original)).toEqual(original);
  expect(cached.values).not.toContain(password);
  expect(cached.values).not.toContain('wrong-password');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Edited after unlock');
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Reset to Original', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.getByLabel('PDF password', { exact: true }).fill(password);
  await page.getByLabel('PDF password', { exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Original value');
});

test('cancel and Escape preserve the prior editable session without a corruption error', async ({ page }) => {
  await openFile(page, 'current.pdf', await fixture(false));
  await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Keep unsaved edit');
  const dialog = page.getByRole('dialog', { name: 'Unlock PDF', exact: true });
  await openFile(page, 'locked-cancel.pdf', await fixture());
  await page.getByRole('dialog', { name: 'Save changes?', exact: true }).getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Keep unsaved edit');
  await expect(page.locator('.error-state')).toHaveCount(0);
  await openFile(page, 'locked-escape.pdf', await fixture());
  await page.getByRole('dialog', { name: 'Save changes?', exact: true }).getByRole('button', { name: 'Don’t save', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.getByLabel('PDF password', { exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Keep unsaved edit');
  const exported = await PDFDocument.load(await download(page));
  expect(exported.getForm().getTextField('Customer name').getText()).toBe('Keep unsaved edit');
});

test('opens an owner-protected PDF with no opening password as an editable working copy', async ({ page }) => {
  await openFile(page, 'owner-protected.pdf', await fixture(true, ''));
  await expect(page.getByRole('textbox', { name: 'Customer name', exact: true })).toHaveValue('Original value');
  await expect(page.getByRole('dialog', { name: 'Unlock PDF', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Filled without a prompt');
  const exported = await PDFDocument.load(await download(page));
  expect(exported.isEncrypted).toBe(false);
  expect(exported.getForm().getTextField('Customer name').getText()).toBe('Filled without a prompt');
});
