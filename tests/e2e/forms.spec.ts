import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function formFixture() {
  const document = await PDFDocument.create();
  const first = document.addPage([600, 500]);
  const second = document.addPage([600, 500]);
  first.setCropBox(50, 50, 300, 350);
  first.setRotation(degrees(90));
  first.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  const name = document.getForm().createTextField('Customer name');
  name.setText('Original');
  name.addToPage(first, { x: 80, y: 260, width: 150, height: 30, borderWidth: 0 });
  name.addToPage(second, { x: 30, y: 350, width: 300, height: 30, borderWidth: 0 });
  name.setFontSize(12);
  const accepted = document.getForm().createCheckBox('Accepted');
  accepted.addToPage(first, { x: 270, y: 260, width: 20, height: 20, borderWidth: 0 });
  return Buffer.from(await document.save());
}

async function exportPDF(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await ready).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function widgetText(bytes: Buffer): string[] {
  const document = new mupdf.PDFDocument(bytes);
  const values: string[] = [];
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index);
      for (const widget of page.getWidgets()) {
        if (widget.isText()) {
          const display = widget.toDisplayList();
          const text = display.toStructuredText('');
          values.push(text.asText().replace(/\s/g, ''));
          text.destroy(); display.destroy();
        }
        widget.destroy();
      }
      page.destroy();
    }
    return values;
  } finally { document.destroy(); }
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('fills the actual rotated cropped UserUnit widget and exports editable Unicode appearances', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'rotated-cropped-form.pdf', mimeType: 'application/pdf', buffer: await formFixture(),
  });
  const input = page.getByRole('textbox', { name: 'Customer name' });
  try { await expect(input).toHaveValue('Original'); }
  catch (error) { throw errors.length ? new Error(errors.join('\n')) : error; }
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  const canvas = await page.locator('canvas.page-canvas').boundingBox();
  const field = await input.boundingBox();
  expect(canvas).not.toBeNull();
  expect(field).not.toBeNull();
  const scale = canvas!.width / 700;
  // Native coordinates [80,260,230,290] through CropBox + Rotate90 + UserUnit2.
  expect(field!.x - canvas!.x).toBeCloseTo(420 * scale, 0);
  expect(field!.y - canvas!.y).toBeCloseTo(60 * scale, 0);
  expect(field!.width).toBeCloseTo(60 * scale, 0);
  expect(field!.height).toBeCloseTo(300 * scale, 0);
  await page.mouse.click(canvas!.x + 450 * scale, canvas!.y + 200 * scale);
  await expect(input).toBeFocused();
  const value = '你好，世界 café Ελληνικά';
  await input.fill(value);
  const checkbox = page.getByRole('checkbox', { name: 'Accepted' });
  await checkbox.check();
  const exported = await exportPDF(page);
  const document = await PDFDocument.load(exported);
  expect(document.getForm().getTextField('Customer name').getText()).toBe(value);
  expect(document.getForm().getTextField('Customer name').isReadOnly()).toBe(false);
  expect(document.getForm().getCheckBox('Accepted').isChecked()).toBe(true);
  expect(widgetText(exported)).toEqual([value.replace(/\s/g, ''), value.replace(/\s/g, '')]);

  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'filled-form.pdf', mimeType: 'application/pdf', buffer: exported,
  });
  await expect(input).toHaveValue(value);
  const revised = '重新填写后的中文';
  await input.fill(revised);
  const secondExport = await exportPDF(page);
  expect(widgetText(secondExport)).toEqual([revised, revised]);
  expect((await PDFDocument.load(secondExport)).getForm().getTextField('Customer name').getText()).toBe(revised);
  expect(errors).toEqual([]);
});

test('keeps a Chinese single-select list empty until chosen and exports its native selection', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([400, 400]);
  const list = pdf.getForm().createOptionList('City');
  list.addToPage(sheet, { x: 50, y: 200, width: 220, height: 120 });
  list.setFontSize(12);
  list.acroField.setOptions([
    { value: PDFHexString.fromText('BJ'), display: PDFHexString.fromText('北京') },
    { value: PDFHexString.fromText('SH'), display: PDFHexString.fromText('上海') },
  ]);
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'single-city.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ updateFieldAppearances: false })),
  });
  const selection = page.getByRole('listbox', { name: 'City', exact: true });
  await expect(selection).toBeVisible();
  expect(await selection.evaluate((element: HTMLSelectElement) => ({ multiple: element.multiple, index: element.selectedIndex })))
    .toEqual({ multiple: false, index: -1 });
  await selection.selectOption('SH');
  const exported = await exportPDF(page);
  const saved = (await PDFDocument.load(exported)).getForm().getOptionList('City');
  expect(saved.getSelected()).toEqual(['SH']);
  expect(saved.isMultiselect()).toBe(false);
  const rendered = new mupdf.PDFDocument(exported);
  const renderedPage = rendered.loadPage(0);
  const widget = renderedPage.getWidgets()[0];
  const display = widget.toDisplayList();
  const text = display.toStructuredText('');
  try { expect(text.asText().replace(/\s/g, '')).toBe('北京上海'); }
  finally { text.destroy(); display.destroy(); widget.destroy(); renderedPage.destroy(); rendered.destroy(); }
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Reset Form Values' }).click();
  expect(await selection.evaluate((element: HTMLSelectElement) => element.selectedIndex)).toBe(-1);
  expect((await PDFDocument.load(await exportPDF(page))).getForm().getOptionList('City').getSelected()).toEqual([]);
});
