import { Buffer } from 'node:buffer';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page, rotation = 0) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 650]);
  if (rotation) { sheet.setRotation(degrees(rotation)); sheet.setCropBox(20, 30, 450, 590); sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); }
  sheet.drawText('Original body', { x: 40, y: 550, size: 20 });
  const text = pdf.getForm().createTextField('Clear text'); text.setText('OLD FORM VALUE');
  text.addToPage(sheet, { x: 40, y: 380, width: 320, height: 45, borderWidth: 2, backgroundColor: rgb(.95, .8, .6), borderColor: rgb(.2, .4, .6) }); text.setFontSize(24); text.updateAppearances(await pdf.embedFont('Helvetica'));
  const checkbox = pdf.getForm().createCheckBox('Clear checkbox'); checkbox.check();
  checkbox.addToPage(sheet, { x: 40, y: 300, width: 36, height: 36, borderWidth: 0 });
  const passive = pdf.getForm().createTextField('Read-only field'); passive.setText('PRESERVE'); passive.enableReadOnly(); passive.addToPage(sheet, { x: 250, y: 300, width: 100, height: 36 });
  const passiveAP = pdf.context.register(pdf.context.flateStream('0 0 1 rg 0 0 100 36 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 36], Resources: {} })); passive.acroField.getWidgets()[0].dict.set(PDFName.of('AP'), pdf.context.obj({ N: passiveAP }));
  const signatureAP = pdf.context.register(pdf.context.flateStream('1 0 0 rg 0 0 100 36 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 36], Resources: {} }));
  const signature = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature artwork'), Rect: [250, 240, 350, 276], AP: { N: signatureAP }, F: 4 }));
  pdf.getForm().acroForm.addField(signature);
  const appearance = pdf.context.register(pdf.context.flateStream('0 1 0 rg 0 0 40 40 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40], Resources: {} }));
  const square = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [390, 300, 430, 340], AP: { N: appearance }, F: 4 }));
  sheet.node.set(PDFName.of('Annots'), pdf.context.obj([...(sheet.node.Annots()?.asArray() ?? []), square, signature]));
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'forms-preview.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save({ updateFieldAppearances: false })) });
  await expect(page.getByRole('textbox', { name: 'Clear text', exact: true })).toHaveValue('OLD FORM VALUE');
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption(rotation ? '0.5' : '1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function inkCount(field: Locator) {
  const bytes = await field.screenshot(), image = new mupdf.Image(bytes), pixmap = image.toPixmap();
  try {
    const pixels = pixmap.getPixels(), width = pixmap.getWidth(), height = pixmap.getHeight(), channels = pixmap.getNumberOfComponents();
    let ink = 0; const corner = (6 * width + 6) * channels, background = [...pixels.slice(corner, corner + 3)];
    for (let y = 6; y < height - 6; y++) for (let x = 6; x < width - 6; x++) {
      const offset = (y * width + x) * channels;
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(pixels[offset + channel] - background[channel]))) > 8) ink++;
    }
    return ink;
  } finally { pixmap.destroy(); image.destroy(); }
}
async function clear(page: Page) {
  await page.getByRole('textbox', { name: 'Clear text', exact: true }).fill('');
  await page.getByRole('checkbox', { name: 'Clear checkbox', exact: true }).uncheck();
  await page.locator('.document-title').click();
}
async function passiveArtwork(page: Page) {
  for (const [name, channel] of [['Read-only field', 2], ['Signature artwork', 0]] as const) {
    const image = new mupdf.Image(await page.getByLabel(name, { exact: true }).screenshot()), pixmap = image.toPixmap();
    try {
      const pixels = pixmap.getPixels(), channels = pixmap.getNumberOfComponents();
      let colored = 0;
      for (let index = 0; index < pixels.length; index += channels) {
        if ([0, 1, 2].every(component => component === channel ? pixels[index + component] > 250 : pixels[index + component] < 5)) colored++;
      }
      expect(colored, `${name} remains visible through its HTML overlay`).toBeGreaterThan(500);
    } finally { pixmap.destroy(); image.destroy(); }
  }
}
async function artwork(page: Page, preview = false) {
  return page.locator(preview ? '.text-edit-preview' : 'canvas.page-canvas').evaluate(element => {
    let canvas: HTMLCanvasElement;
    if (element instanceof HTMLImageElement) {
      canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
      canvas.getContext('2d')!.drawImage(element, 0, 0);
    } else canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, colors = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 5 && data[index + 1] > 250 && data[index + 2] < 5) colors[0]++;
      if (data[index] < 5 && data[index + 1] < 5 && data[index + 2] > 250) colors[1]++;
      if (data[index] > 250 && data[index + 1] < 5 && data[index + 2] < 5) colors[2]++;
    }
    return colors;
  });
}

test('clearing PDF controls removes old text and check marks from the reading canvas', async ({ page }) => {
  await open(page); await clear(page);
  expect((await artwork(page)).every(count => count > 500)).toBe(true);
  await passiveArtwork(page);
  await expect(page.getByRole('textbox', { name: 'Clear text', exact: true })).toHaveCSS('background-color', 'rgb(242, 204, 153)');
  expect(await inkCount(page.getByRole('textbox', { name: 'Clear text', exact: true }))).toBe(0);
  expect(await inkCount(page.locator('.form-field-checkbox'))).toBe(0);
});

test('original-text previews keep cleared controls blank and retain native annotation artwork', async ({ page }) => {
  await open(page); await clear(page);
  await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  await page.locator('.text-block').filter({ hasText: 'Original body' }).click();
  const input = page.locator('.pdf-text-input'); await input.fill('Updated body'); await input.press('Control+Enter');
  await expect(page.locator('.text-edit-preview')).toBeVisible();
  expect(await inkCount(page.getByRole('textbox', { name: 'Clear text', exact: true }))).toBe(0);
  expect(await inkCount(page.locator('.form-field-checkbox'))).toBe(0);
  const colors = await artwork(page, true); expect(Math.min(...colors), JSON.stringify(colors)).toBeGreaterThan(500);
  await passiveArtwork(page);
});

for (const rotation of [90, 270]) test(`cleared controls and native artwork stay aligned at Rotate${rotation} with CropBox and UserUnit2`, async ({ page }) => {
  await open(page, rotation); await clear(page);
  expect((await artwork(page)).every(count => count > 500)).toBe(true);
  await passiveArtwork(page);
  expect(await inkCount(page.getByRole('textbox', { name: 'Clear text', exact: true }))).toBe(0);
  expect(await inkCount(page.locator('.form-field-checkbox'))).toBe(0);
  await page.locator('.workspace-ribbon [data-command="edit-text"]').click();
  await page.locator('.text-block').filter({ hasText: 'Original body' }).click();
  await page.locator('.pdf-text-input').fill('Updated body'); await page.locator('.pdf-text-input').press('Control+Enter');
  await expect.poll(() => page.locator('.text-edit-preview').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const colors = await artwork(page, true); expect(Math.min(...colors), JSON.stringify(colors)).toBeGreaterThan(500);
  await passiveArtwork(page);
  expect(await inkCount(page.getByRole('textbox', { name: 'Clear text', exact: true }))).toBe(0);
});
