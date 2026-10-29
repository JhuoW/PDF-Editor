import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { exportToFDF } from '../../src/forms/FormDataIO';

test('imports Unicode FDF, native radio states, and explicit clearing values from the interface', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  page.on('dialog', dialog => dialog.accept());
  const source = await PDFDocument.create();
  const pdfPage = source.addPage([400, 600]);
  const form = source.getForm();
  const name = form.createTextField('Name');
  name.setText('Original');
  name.addToPage(pdfPage, { x: 40, y: 500, width: 220, height: 30 });
  const checked = form.createCheckBox('Agree');
  checked.addToPage(pdfPage, { x: 40, y: 440, width: 20, height: 20 });
  checked.check();
  const radio = form.createRadioGroup('Choice');
  radio.addOptionToPage('First', pdfPage, { x: 40, y: 380, width: 20, height: 20 });
  radio.addOptionToPage('Second', pdfPage, { x: 80, y: 380, width: 20, height: 20 });
  radio.select('First');
  const data = new Uint8Array(await source.save());
  const fields = await extractFormFields(data.buffer);
  fields.forEach(field => { field.value = field.name === 'Name' ? '导入 中文' : field.name === 'Agree' ? false : 'Second'; });
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: Buffer.from(data) });
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Original');

  const importFile = async (name: string, content: string) => {
    await page.getByRole('button', { name: /^Form .*▾$/ }).click();
    const chooserReady = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Form Data...', exact: true }).click();
    await (await chooserReady).setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) });
  };
  await importFile('values.FDF', exportToFDF(fields));
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('导入 中文');
  await expect(page.getByRole('checkbox', { name: 'Agree', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Choice: Second', exact: true })).toBeChecked();

  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await ready).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = await PDFDocument.load(Buffer.concat(chunks));
  expect(exported.getForm().getTextField('Name').getText()).toBe('导入 中文');
  expect(exported.getForm().getCheckBox('Agree').isChecked()).toBe(false);
  expect(exported.getForm().getRadioGroup('Choice').getSelected()).toBe('Second');

  await importFile('clear.json', JSON.stringify({ fields: { Name: '', Agree: false, Choice: '' } }));
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
  await expect(page.getByRole('radio', { name: 'Choice: Second', exact: true })).not.toBeChecked();
});
