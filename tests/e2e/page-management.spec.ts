import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFString, StandardFonts, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function fixture(rotation = 0) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier);
  const first = pdf.addPage([400, 600]);
  first.drawText('ORIGINAL PAGE ONE', { x: 40, y: 500, size: 16, font });
  if (rotation) first.setRotation(degrees(rotation));
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original value');
  field.addToPage(first, { x: 40, y: 350, width: 250, height: 30 });
  const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [40, 250, 60, 270], Contents: PDFString.of('Editable original note'), NM: PDFString.of('original-note'), Name: 'Comment' }));
  first.node.Annots()!.push(note);
  pdf.addPage([300, 500]).drawText('ORIGINAL PAGE TWO', { x: 40, y: 400, size: 14 });
  return Buffer.from(await pdf.save());
}
async function open(page: Page, rotation = 0) {
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'pages.pdf', mimeType: 'application/pdf', buffer: await fixture(rotation) });
  await expect(page.locator('canvas.page-canvas').first()).toBeVisible();
  await expect(page.locator('.page-total')).toHaveText('2');
}
async function action(page: Page, name: string) {
  await page.locator('#workspace-organize').click();
  await page.locator(`.workspace-ribbon [data-command="${name}-pages"]`).click();
  if (name === 'crop') await page.locator('.page-crop-controls [data-crop-action="options"]').click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
  return dialog;
}
async function download(page: Page, name = 'Export') {
  const pending = page.waitForEvent('download');
  const scope = name === 'Export' ? page.locator('.main-toolbar') : page.getByRole('dialog');
  await scope.getByRole('button', { name, exact: true }).click();
  const file = await pending;
  return { bytes: await readFile((await file.path())!), name: file.suggestedFilename() };
}
function texts(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes);
  try { return Array.from({ length: pdf.countPages() }, (_, index) => {
    const sheet = pdf.loadPage(index), text = sheet.toStructuredText('');
    try { return text.asText(); } finally { text.destroy(); sheet.destroy(); }
  }); } finally { pdf.destroy(); }
}
async function edit(page: Page) {
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Pending form value');
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.locator('.workspace-all-tools [data-command="edit-text"]').click();
  await page.locator('.text-block').filter({ hasText: 'ORIGINAL PAGE ONE' }).dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('EDITED PAGE ONE');
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); localStorage.setItem('pdf-editor.locale', 'en'); });
});

test('duplicates pending content, filled forms and editable notes, then supports undo and redo', async ({ page }) => {
  await open(page); await edit(page);
  const dialog = await action(page, 'duplicate');
  await dialog.getByLabel('Insert copies', { exact: true }).selectOption('end');
  await dialog.getByRole('button', { name: 'Duplicate pages', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('.page-total')).toHaveText('3');
  const result = await download(page), content = texts(result.bytes);
  expect(content[0]).toContain('EDITED PAGE ONE'); expect(content[2]).toContain('EDITED PAGE ONE');
  expect(content[1]).toContain('ORIGINAL PAGE TWO');
  const pdf = await PDFDocument.load(result.bytes);
  expect(pdf.getForm().getFields().map(field => field.getName()).sort()).toEqual(['Contact', 'Contact_2']);
  expect(pdf.getForm().getTextField('Contact_2').getText()).toBe('Pending form value');
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(page.locator('.page-total')).toHaveText('3');
  await page.locator('.combined-toolbar button[title^="Undo"]').click();
  await expect(page.locator('.page-total')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Pending form value');
  await page.locator('.combined-toolbar button[title^="Redo"]').click();
  await expect(page.locator('.page-total')).toHaveText('3');
  const number = page.getByRole('spinbutton', { name: 'Page number', exact: true }); await number.fill('3'); await number.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Contact_2', exact: true })).toHaveValue('Pending form value');
  await page.getByTitle('Select (V)', { exact: true }).click();
  const canvas = page.locator('canvas.page-canvas'); await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.click(bounds.x + 50 * bounds.width / 400, bounds.y + 340 * bounds.height / 600);
  await expect(page.getByRole('textbox', { name: 'Note content', exact: true })).toHaveValue('Editable original note');
  await page.getByRole('textbox', { name: 'Note content', exact: true }).fill('Independent copied note');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  const withNotes = new mupdf.PDFDocument((await download(page)).bytes);
  try {
    const notes = [0, 2].map(index => {
      const sheet = withNotes.loadPage(index), annotations = sheet.getAnnotations();
      try { return annotations.filter(item => item.getType() === 'Text').map(item => item.getContents()); }
      finally { annotations.forEach(item => item.destroy()); sheet.destroy(); }
    });
    expect(notes).toEqual([['Editable original note'], ['Independent copied note']]);
  } finally { withNotes.destroy(); }
});

test('extracts requested pages in order with current edits while retaining the open document', async ({ page }) => {
  await open(page); await edit(page);
  const dialog = await action(page, 'extract');
  await dialog.getByLabel('Page range', { exact: true }).fill('2，1');
  const result = await download(page, 'Extract pages');
  expect(result.name).toBe('pages-extracted.pdf');
  const content = texts(result.bytes);
  expect(content).toHaveLength(2); expect(content[0]).toContain('ORIGINAL PAGE TWO'); expect(content[1]).toContain('EDITED PAGE ONE');
  const pdf = await PDFDocument.load(result.bytes); expect(pdf.getForm().getTextField('Contact').getText()).toBe('Pending form value');
  await expect(page.locator('.page-total')).toHaveText('2');
  expect(texts((await download(page)).bytes)[0]).toContain('EDITED PAGE ONE');
});

test('replaces pages with another PDF and restores the original page and draft values on undo', async ({ page }) => {
  await open(page); await edit(page);
  const donor = await PDFDocument.create(), sheet = donor.addPage([250, 350]); sheet.drawText('REPLACEMENT PAGE', { x: 20, y: 250, size: 12 });
  const field = donor.getForm().createTextField('Contact'); field.setText('Donor value'); field.addToPage(sheet, { x: 20, y: 150, width: 180, height: 25 });
  const dialog = await action(page, 'replace');
  await dialog.getByLabel('Replacement PDF', { exact: true }).setInputFiles({ name: 'donor.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await donor.save()) });
  await dialog.getByLabel('Replacement page range', { exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Replace pages', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('.page-total')).toHaveText('2');
  const result = await download(page), content = texts(result.bytes);
  expect(content[0]).toContain('REPLACEMENT PAGE'); expect(content[0]).not.toContain('EDITED PAGE ONE'); expect(content[1]).toContain('ORIGINAL PAGE TWO');
  const pdf = await PDFDocument.load(result.bytes); expect(pdf.getPage(0).getSize()).toEqual({ width: 250, height: 350 });
  expect(pdf.getForm().getFields()).toHaveLength(1);
  expect(pdf.getForm().getTextField('Contact').getText()).toBe('Donor value');
  await page.locator('.combined-toolbar button[title^="Undo"]').click(); await expect(page.locator('.page-total')).toHaveText('2');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Pending form value');
  expect(texts((await download(page)).bytes)[0]).toContain('EDITED PAGE ONE');
});

test('crops rotated pages with physical margins, rejects excessive margins, and restores full boundaries', async ({ page }) => {
  await open(page, 90);
  let dialog = await action(page, 'crop');
  await dialog.getByLabel('Top margin (mm)', { exact: true }).fill('1000');
  await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); await expect(page.locator('.page-total')).toHaveText('2');
  await dialog.getByLabel('Top margin (mm)', { exact: true }).fill('10');
  await dialog.getByLabel('Left margin (mm)', { exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click(); await expect(dialog).toHaveCount(0);
  let pdf = await PDFDocument.load((await download(page)).bytes), box = pdf.getPage(0).getCropBox();
  expect(box.width).toBeCloseTo(400 - 10 * 72 / 25.4); expect(box.height).toBeCloseTo(600 - 5 * 72 / 25.4);
  expect(pdf.getPage(1).getCropBox()).toEqual({ x: 0, y: 0, width: 300, height: 500 });
  dialog = await action(page, 'crop'); await dialog.getByRole('checkbox', { name: 'Restore full page', exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click(); await expect(dialog).toHaveCount(0);
  pdf = await PDFDocument.load((await download(page)).bytes); box = pdf.getPage(0).getCropBox();
  expect(box).toEqual({ x: 0, y: 0, width: 400, height: 600 }); expect(pdf.getPage(0).getRotation().angle).toBe(90);
});

test('phone page tools switch language without losing drafts and reject a malformed replacement safely', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await open(page);
  const dialog = await action(page, 'replace');
  await dialog.getByLabel('Page range', { exact: true }).fill('2');
  await dialog.getByLabel('Replacement PDF', { exact: true }).setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invalid') });
  await expect(dialog.getByRole('alert')).toContainText('Could not read');
  await dialog.locator('.language-switcher button[lang="zh-CN"]').click();
  await expect(dialog).toHaveAccessibleName('替换页面');
  await expect(dialog.getByRole('alert')).not.toContainText('Could not');
  await expect(dialog.getByLabel('页面范围', { exact: true })).toHaveValue('2');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(dialog.getByRole('button', { name: '替换页面', exact: true })).toBeInViewport();
  await page.screenshot({ path: '/tmp/pdf-page-management-mobile.png' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.locator('.page-total')).toHaveText('2');
});
