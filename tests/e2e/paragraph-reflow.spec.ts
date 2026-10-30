import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function openTightParagraph(page: Page) {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Courier);
  const pdfPage = document.addPage([400, 500]);
  pdfPage.drawText('alpha beta', { x: 40, y: 420, size: 11, font });
  pdfPage.drawText('gamma delta', { x: 40, y: 411, size: 11, font });
  pdfPage.drawRectangle({ x: 35, y: 380, width: 200, height: 28, color: rgb(.8, .15, .1) });
  pdfPage.drawText('NEIGHBOR MUST STAY', { x: 40, y: 320, size: 11, font });
  const source = Buffer.from(await document.save());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'tight-paragraph.pdf', mimeType: 'application/pdf', buffer: source });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const block = page.locator('.text-block').filter({ hasText: 'alpha beta' });
  await expect(block).toContainText('gamma delta'); await block.click({ position: { x: 10, y: 5 } });
  return { source, input: page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }) };
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function inspect(bytes: Uint8Array) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), content = page.toStructuredText('');
  const rows: { text: string; baseline: number }[] = []; let row = { text: '', baseline: 0 };
  try {
    content.walk({ beginLine() { row = { text: '', baseline: 0 }; }, onChar(character, origin, font) { try { row.text += character; row.baseline = origin[1]; } finally { font.destroy(); } }, endLine() { rows.push(row); } });
    const pixels = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const image = pixels.getPixels(), bar: number[] = [];
      for (let y = 93; y < 119; y++) for (let x = 36; x < 234; x++) {
        const index = y * pixels.getStride() + x * 3; bar.push(image[index], image[index + 1], image[index + 2]);
      }
      return { text: content.asText(), rows, bar };
    } finally { pixels.destroy(); }
  } finally { content.destroy(); page.destroy(); document.destroy(); }
}

test('Done stays available after blur and a tight 20pt paragraph applies without a false 22pt overflow', async ({ page }) => {
  const { input, source } = await openTightParagraph(page);
  await expect(input).toHaveValue('alpha beta gamma delta');
  await input.fill('omega beta gamma delta');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'omega beta gamma delta');
  await page.getByRole('spinbutton', { name: 'Page number', exact: true }).focus();
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply Content Changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const output = inspect(await exported(page));
  expect(output.rows.filter(row => /omega|gamma/.test(row.text)).map(row => Math.round(row.baseline))).toEqual([80, 89]);
  expect(output.text).not.toContain('alpha'); expect(output.text).toContain('NEIGHBOR MUST STAY');
  expect(output.bar).toEqual(inspect(source).bar);
});

test('deleting from the first PDF row pulls following words up, while Enter remains an explicit break', async ({ page }) => {
  const { input, source } = await openTightParagraph(page);
  await input.press('Control+Home');
  for (let index = 0; index < 6; index++) await input.press('Delete');
  await expect(input).toHaveValue('beta gamma delta');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'beta gamma delta');
  let output = inspect(await exported(page));
  expect(output.rows.find(row => row.text.includes('gamma'))).toMatchObject({ text: 'beta gamma', baseline: expect.closeTo(80, 2) });
  expect(output.bar).toEqual(inspect(source).bar);
  // Export ends only the active typing session; Done still exits text editing.
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.text-block')).toHaveCount(0);
  await page.getByRole('button', { name: /^Undo/ }).click();
  expect(inspect(await exported(page)).text).toContain('alpha beta');
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(inspect(await exported(page)).rows.find(row => row.text.includes('gamma'))?.text).toBe('beta gamma');
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'beta gamma delta' }).click();
  await input.press('Control+Home'); for (let index = 0; index < 5; index++) await input.press('ArrowRight');
  await input.press('Enter');
  await expect(input).toHaveValue('beta \ngamma delta');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  output = inspect(await exported(page));
  expect(output.rows.find(row => row.text.includes('gamma'))?.baseline).toBeCloseTo(89, 2);
  expect(output.bar).toEqual(inspect(source).bar);
});
