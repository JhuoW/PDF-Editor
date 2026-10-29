import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function fixture() {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  page.drawText('ORIGINAL TEXT TO CHANGE', { x: 60, y: 680, size: 16 });
  page.drawText('PUBLIC TEXT REMAINS', { x: 60, y: 400, size: 16 });
  const field = document.getForm().createTextField('Customer name');
  field.setText('Original customer');
  field.addToPage(page, { x: 60, y: 500, width: 280, height: 35, borderWidth: 0 });
  return Buffer.from(await document.save());
}
async function openEncryption(page: Page) {
  await page.getByRole('button', { name: 'Document ▾', exact: true }).click();
  await page.getByRole('button', { name: 'Encrypt and Export…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Encrypt and Export', exact: true });
}
async function download(page: Page, button: string) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const result = await ready;
  return { bytes: await readFile((await result.path())!), fileName: result.suggestedFilename() };
}
function contents(document: mupdf.PDFDocument) {
  const page = document.loadPage(0), structured = page.toStructuredText('');
  try {
    const fields: string[] = [];
    for (const widget of page.getWidgets()) {
      try { if (widget.isText()) fields.push(widget.getValue()); } finally { widget.destroy(); }
    }
    return { text: structured.asText(), fields };
  } finally { structured.destroy(); page.destroy(); }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('encrypts current text and form edits with AES-256 and independent owner permissions', async ({ page }) => {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'edited-source.PDF', mimeType: 'application/pdf', buffer: await fixture() });
  await page.getByRole('textbox', { name: 'Customer name', exact: true }).fill('Live form value');
  await page.getByRole('button', { name: /^Edit .*▾$/ }).click();
  await page.getByRole('button', { name: '✎ Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'ORIGINAL TEXT TO CHANGE' }).dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('EDITED TEXT');
  // Opening the menu blurs and commits the pending text edit into the workspace.
  const dialog = await openEncryption(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  await expect(page.getByLabel('Password to open', { exact: true })).toBeFocused();
  await page.getByLabel('Password to open', { exact: true }).press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close encryption dialog', exact: true })).toBeFocused();
  expect(await dialog.evaluate(element => {
    document.querySelector<HTMLButtonElement>('.main-toolbar button')!.focus();
    return element.contains(document.activeElement);
  })).toBe(true);
  await page.getByRole('button', { name: 'Encrypt and download', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a password');
  await page.getByLabel('Password to open', { exact: true }).fill('open-password,=123');
  await page.getByLabel('Confirm opening password', { exact: true }).fill('different');
  await page.getByRole('button', { name: 'Encrypt and download', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('does not match');
  await page.getByLabel('Confirm opening password', { exact: true }).fill('open-password,=123');
  await page.getByRole('checkbox', { name: 'Copy text and images', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Print', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Print in high quality', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Print in high quality', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Encrypt and download', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('separate owner password');
  await page.getByLabel('Owner password', { exact: true }).fill('open-password,=123');
  await page.getByRole('button', { name: 'Encrypt and download', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('separate owner password');
  await page.getByLabel('Owner password', { exact: true }).fill('owner-password=456');
  const output = await download(page, 'Encrypt and download');
  expect(output.fileName).toBe('edited-source-encrypted.pdf');
  await expect(dialog).toHaveCount(0);

  const document = new mupdf.PDFDocument(output.bytes);
  try {
    expect(document.needsPassword()).toBe(true);
    expect(document.authenticatePassword('wrong')).toBe(0);
    expect(document.authenticatePassword('open-password,=123') & 2).toBe(2);
    expect(document.getMetaData('encryption')).toContain('256-bit AES');
    expect(document.hasPermission('copy')).toBe(false);
    expect(document.hasPermission('print')).toBe(false);
    expect(document.hasPermission('print-hq')).toBe(false);
    expect(document.hasPermission('edit')).toBe(true);
    expect(document.hasPermission('annotate')).toBe(true);
    expect(document.hasPermission('form')).toBe(true);
    const value = contents(document);
    expect(value.text).toContain('EDITED TEXT');
    expect(value.text).not.toContain('ORIGINAL TEXT TO CHANGE');
    expect(value.text).toContain('PUBLIC TEXT REMAINS');
    expect(value.fields).toContain('Live form value');
  } finally { document.destroy(); }
  const owner = new mupdf.PDFDocument(output.bytes);
  try { expect(owner.authenticatePassword('owner-password=456') & 4).toBe(4); } finally { owner.destroy(); }

  const plainOutput = await download(page, 'Export');
  const plain = new mupdf.PDFDocument(plainOutput.bytes);
  try {
    expect(plain.needsPassword()).toBe(false);
    const trailer = plain.getTrailer(), encryption = trailer.get('Encrypt');
    try { expect(encryption.isNull()).toBe(true); } finally { encryption.destroy(); trailer.destroy(); }
    expect(contents(plain).text).toContain('EDITED TEXT');
    expect(contents(plain).fields).toContain('Live form value');
  } finally { plain.destroy(); }
  await openEncryption(page);
  await expect(page.getByLabel('Password to open', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Owner password', { exact: true })).toHaveValue('');
  await page.getByLabel('Password to open', { exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0);
});
