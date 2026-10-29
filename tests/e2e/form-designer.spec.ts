import { Buffer } from 'node:buffer';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';

async function openPDF(page: Page, buffer: Uint8Array) {
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'form-design.pdf', mimeType: 'application/pdf', buffer: Buffer.from(buffer) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function openDesigner(page: Page) {
  await page.getByRole('button', { name: /^Form .*▾$/ }).click();
  await page.getByRole('button', { name: 'Design Form…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design Form', exact: true });
  await expect(dialog.getByRole('combobox', { name: 'Preview page', exact: true })).toBeVisible();
  await expect(dialog.locator('.form-designer-page canvas')).toBeVisible();
  return dialog;
}
async function numeric(dialog: Locator, label: string, value: number) {
  const input = dialog.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value)); await input.press('Enter');
}
async function addAt(dialog: Locator, type: string, name: string, x: number, y: number) {
  await dialog.getByRole('button', { name: type, exact: true }).click();
  await dialog.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Field name', exact: true }).fill(name);
  await numeric(dialog, 'Left', x); await numeric(dialog, 'Top', y);
}
async function save(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Save form design', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await pending).createReadStream())!) chunks.push(Buffer.from(chunk));
  return PDFDocument.load(Buffer.concat(chunks));
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

test('designs all five native field types, fills them, exports Unicode choices, and restores schema and values through refresh and history', async ({ page }) => {
  test.setTimeout(90_000);
  const source = await PDFDocument.create();
  source.addPage([400, 600]).drawText('Create a fillable form', { x: 30, y: 560, size: 16 });
  await openPDF(page, await source.save());
  const dialog = await openDesigner(page);

  // The first field is drawn with the real pointer; others use the keyboard-friendly placement action.
  await dialog.getByRole('button', { name: 'Text field', exact: true }).click();
  const preview = (await dialog.locator('.form-designer-page canvas').boundingBox())!, scale = preview.width / 400;
  await page.mouse.move(preview.x + 30 * scale, preview.y + 90 * scale); await page.mouse.down();
  await page.mouse.move(preview.x + 250 * scale, preview.y + 122 * scale, { steps: 5 }); await page.mouse.up();
  await dialog.getByRole('textbox', { name: 'Field name', exact: true }).fill('Name');
  await dialog.getByRole('textbox', { name: 'Current value', exact: true }).fill('设计草稿');
  await dialog.getByRole('textbox', { name: 'Default value', exact: true }).fill('默认姓名');
  await dialog.getByRole('checkbox', { name: 'Required', exact: true }).check();

  await addAt(dialog, 'Checkbox', 'Agree', 30, 155);
  await dialog.getByRole('checkbox', { name: 'Current value: checked', exact: true }).check();
  await addAt(dialog, 'Radio group', 'Choice', 30, 200);
  await dialog.getByRole('button', { name: 'Add radio choice', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Current value', exact: true }).selectOption('Option2');
  await addAt(dialog, 'Dropdown', 'Country', 30, 290);
  await dialog.getByRole('textbox', { name: 'Label 1', exact: true }).fill('中国');
  await dialog.getByRole('textbox', { name: 'Value 1', exact: true }).fill('cn');
  await dialog.getByRole('textbox', { name: 'Label 2', exact: true }).fill('新加坡');
  await dialog.getByRole('textbox', { name: 'Value 2', exact: true }).fill('sg');
  await dialog.getByRole('combobox', { name: 'Current value', exact: true }).selectOption('cn');
  await addAt(dialog, 'List box', 'Category', 30, 345);
  await dialog.getByRole('textbox', { name: 'Label 1', exact: true }).fill('项目甲');
  await dialog.getByRole('textbox', { name: 'Value 1', exact: true }).fill('a');
  await dialog.getByRole('textbox', { name: 'Label 2', exact: true }).fill('项目乙');
  await dialog.getByRole('textbox', { name: 'Value 2', exact: true }).fill('b');
  await expect(dialog.getByRole('checkbox', { name: 'Allow multiple selections', exact: true })).not.toBeChecked();
  await dialog.getByRole('combobox', { name: 'Current value', exact: true }).selectOption('b');
  await save(dialog);

  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('设计草稿');
  await expect(page.getByRole('checkbox', { name: 'Agree', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Choice: Option2', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Country', exact: true })).toHaveValue('cn');
  const category = page.getByRole('listbox', { name: 'Category', exact: true });
  await expect(category).toHaveValue('b');
  expect(await category.evaluate(element => (element as HTMLSelectElement).multiple)).toBe(false);
  await name.fill('Filled after design 中文'); await name.press('Tab');
  const pdf = await exported(page), form = pdf.getForm();
  expect(form.getFields()).toHaveLength(5);
  expect(form.getTextField('Name').getText()).toBe('Filled after design 中文');
  expect(form.getTextField('Name').isRequired()).toBe(true);
  expect(form.getCheckBox('Agree').isChecked()).toBe(true);
  expect(form.getRadioGroup('Choice').getSelected()).toBe('Option2');
  expect(form.getRadioGroup('Choice').acroField.getWidgets()).toHaveLength(2);
  expect(form.getDropdown('Country').acroField.getOptions().map(option => ({ value: option.value.decodeText(), label: option.display?.decodeText() }))).toEqual([{ value: 'cn', label: '中国' }, { value: 'sg', label: '新加坡' }]);
  expect(form.getOptionList('Category').isMultiselect()).toBe(false);
  expect(form.getOptionList('Category').getSelected()).toEqual(['b']);

  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(name).toHaveValue('Filled after design 中文');
  await page.getByRole('button', { name: 'Undo Fill Name', exact: true }).click();
  await expect(name).toHaveValue('设计草稿');
  await page.getByRole('button', { name: 'Undo Design form', exact: true }).click();
  await expect(page.locator('.form-field')).toHaveCount(0);
  expect((await exported(page)).getForm().getFields()).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo Design form', exact: true }).click();
  await expect(name).toHaveValue('设计草稿');
  await page.getByRole('button', { name: 'Redo Fill Name', exact: true }).click();
  expect((await exported(page)).getForm().getTextField('Name').getText()).toBe('Filled after design 中文');
});

test('moves and resizes a shared field on a rotated CropBox/UserUnit page, deletes a field, and preserves pending values', async ({ page }) => {
  test.setTimeout(60_000);
  const source = await PDFDocument.create(), first = source.addPage([500, 600]), second = source.addPage([400, 600]);
  first.setCropBox(50, 100, 300, 400); first.setRotation(degrees(90)); first.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  first.drawText('Shared form field', { x: 80, y: 460, size: 14 });
  const shared = source.getForm().createTextField('Shared'); shared.setText('Original');
  shared.addToPage(first, { x: 80, y: 390, width: 130, height: 24 }); shared.addToPage(second, { x: 30, y: 450, width: 160, height: 24 });
  const removed = source.getForm().createCheckBox('RemoveMe'); removed.addToPage(first, { x: 80, y: 300, width: 18, height: 18 });
  await openPDF(page, await source.save());
  await page.getByRole('textbox', { name: 'Shared', exact: true }).fill('Pending filled value');
  const dialog = await openDesigner(page);
  await dialog.getByRole('combobox', { name: 'Fields', exact: true }).selectOption({ label: 'Shared · text' });
  await expect(dialog.getByRole('textbox', { name: 'Current value', exact: true })).toHaveValue('Pending filled value');
  await numeric(dialog, 'Left', 80); await numeric(dialog, 'Top', 200); await numeric(dialog, 'Width', 240); await numeric(dialog, 'Height', 50);
  const target = dialog.getByRole('button', { name: 'Select field Shared, widget 1', exact: true });
  const targetBounds = (await target.boundingBox())!, preview = (await dialog.locator('.form-designer-page canvas').boundingBox())!;
  const scale = preview.width / 800;
  // Native Rotate90 maps a screen-right drag onto decreasing unrotated y.
  await page.mouse.move(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2); await page.mouse.down();
  await page.mouse.move(targetBounds.x + targetBounds.width / 2 + 20 * scale, targetBounds.y + targetBounds.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(dialog.getByRole('spinbutton', { name: 'Left', exact: true })).toHaveValue('80');
  await expect(dialog.getByRole('spinbutton', { name: 'Top', exact: true })).toHaveValue('180');
  const handle = (await dialog.getByRole('button', { name: 'Resize field Shared', exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 10 * scale, handle.y + handle.height / 2 + 20 * scale, { steps: 5 }); await page.mouse.up();
  await expect(dialog.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('260');
  await expect(dialog.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('60');
  await dialog.getByRole('region', { name: 'Form design page 1', exact: true }).press('ArrowRight');
  await expect(dialog.getByRole('spinbutton', { name: 'Top', exact: true })).toHaveValue('179');
  await expect(dialog.getByRole('spinbutton', { name: 'Left', exact: true })).toHaveValue('80');
  await dialog.getByRole('combobox', { name: 'Widget', exact: true }).selectOption({ index: 1 });
  await dialog.getByRole('combobox', { name: 'Widget page', exact: true }).selectOption('1');
  await numeric(dialog, 'Left', 350); await numeric(dialog, 'Top', 300);
  await dialog.getByRole('combobox', { name: 'Fields', exact: true }).selectOption({ label: 'RemoveMe · checkbox' });
  await dialog.getByRole('button', { name: 'Delete field', exact: true }).click();
  await save(dialog);
  await expect(page.getByRole('textbox', { name: 'Shared', exact: true })).toHaveCount(2);
  const form = (await exported(page)).getForm(), field = form.getTextField('Shared');
  expect(form.getFields()).toHaveLength(1);
  expect(field.getText()).toBe('Pending filled value');
  const widgets = field.acroField.getWidgets(); expect(widgets).toHaveLength(2);
  const rectangle = widgets[0].getRectangle();
  for (const [key, value] of Object.entries({ x: 90, y: 380.5, width: 130, height: 30 })) expect(rectangle[key as keyof typeof rectangle]).toBeCloseTo(value, 2);
  expect(widgets[0].P()?.toString()).toBe(widgets[1].P()?.toString());
  await page.getByRole('button', { name: 'Undo Design form', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'RemoveMe', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Shared', exact: true })).toHaveValue('Pending filled value');
  await page.getByRole('button', { name: 'Redo Design form', exact: true }).click();
  expect((await exported(page)).getForm().getFields()).toHaveLength(1);
});

test('keeps editable multiple choices as separate native values, including commas, and saves a focused numeric draft', async ({ page }) => {
  const source = await PDFDocument.create(), first = source.addPage([400, 600]);
  first.drawText('Editable multiple choices', { x: 30, y: 550, size: 16 });
  const choices = source.getForm().createDropdown('Tags'); choices.setOptions(['a', 'b']); choices.enableEditing(); choices.enableMultiselect(); choices.select(['a', 'b']);
  choices.addToPage(first, { x: 30, y: 450, width: 220, height: 30 });
  await openPDF(page, await source.save());
  const dialog = await openDesigner(page);
  await dialog.getByRole('combobox', { name: 'Fields', exact: true }).selectOption({ label: 'Tags · dropdown' });
  const current = dialog.getByRole('textbox', { name: 'Current value', exact: true });
  await expect(current).toHaveValue('a\nb');
  await current.fill('a\nb\ncustom, value\n');
  await dialog.getByRole('textbox', { name: 'Default value', exact: true }).fill('a\ndefault, value');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: test.info().outputPath('form-designer-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('textbox', { name: 'Current value', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Save form design', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('form-designer-narrow-properties.png') });
  await dialog.locator('.form-designer-body').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: test.info().outputPath('form-designer-narrow-preview.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  const width = dialog.getByRole('spinbutton', { name: 'Width', exact: true });
  await width.fill('250');
  await width.press('Control+s');
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  const dropdown = (await exported(page)).getForm().getDropdown('Tags');
  expect(dropdown.getSelected()).toEqual(['a', 'b', 'custom, value']);
  expect(dropdown.isMultiselect()).toBe(true); expect(dropdown.isEditable()).toBe(true);
  const defaults = dropdown.acroField.dict.lookup(PDFName.of('DV'), PDFArray);
  expect(defaults.asArray().map(value => (value as PDFString | PDFHexString).decodeText())).toEqual(['a', 'default, value']);
  expect(dropdown.acroField.getWidgets()[0].getRectangle().width).toBeCloseTo(250, 2);
});
