import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

const original = 'The original PDF text.';
async function open(page: Page, rotation = 0, interactive = false) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier);
  const sheet = pdf.addPage([500, 600]);
  sheet.drawRectangle({ x: 25, y: 430, width: 450, height: 100, color: rgb(.92, .96, 1) });
  sheet.drawText(original, { x: 40, y: 500, size: 20, font, color: rgb(.1, .25, .6) });
  sheet.drawText('NEIGHBOR STAYS', { x: 40, y: 330, size: 12 });
  sheet.drawRectangle({ x: 40, y: 370, width: 100, height: 25, color: rgb(.8, .15, .1) });
  if (interactive) {
    const destination = pdf.addPage([500, 600]);
    const field = pdf.getForm().createTextField('Contact'); field.addToPage(sheet, { x: 40, y: 200, width: 200, height: 25 });
    sheet.node.set(PDFName.of('Annots'), pdf.context.obj([...(sheet.node.Annots()?.asArray() ?? []), pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [300, 200, 450, 225], Dest: [destination.ref, 'Fit'], Border: [0, 0, 0] }))]));
  }
  if (rotation) sheet.setRotation(degrees(rotation));
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'direct-edit.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  return page.locator('.text-block').filter({ hasText: original });
}
async function bytes(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function inspect(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  const styles: { font: string; color: number[]; size: number }[] = [];
  try {
    text.walk({ onChar(character, origin, font, size, _quad, color) { try { if (character === 'T' && origin[1] < 200) styles.push({ font: font.getName(), color, size }); } finally { font.destroy(); } } });
    return { text: text.asText(), annotations: page.getAnnotations().map(annotation => { try { return annotation.getType(); } finally { annotation.destroy(); } }), styles };
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}

test('places a caret in the original word, edits PDF glyphs without a visible text box, and previews the export immediately', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const block = await open(page);
  const originalPageTop = (await page.locator('canvas.page-canvas').boundingBox())!.y;
  await block.click({ position: { x: 4 * 12 + 1, y: 10 } });
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await expect(page.locator('.text-edit-preview')).toBeVisible();
  await expect.poll(() => input.evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([4, 4]);
  await expect(input).toHaveCSS('opacity', '0');
  await expect(page.locator('.text-block.editing')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await input.press('Delete'); await input.pressSequentially('O');
  const replacement = 'The Original PDF text.';
  await expect(input).toHaveValue(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
  expect((await page.locator('canvas.page-canvas').boundingBox())!.y).toBe(originalPageTop);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('direct-caret.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const result = inspect(await bytes(page));
  expect(result.text).toContain(replacement); expect(result.text).not.toContain(original);
  expect(result.text).toContain('NEIGHBOR STAYS'); expect(result.annotations).toEqual([]);
  expect(result.styles[0].font).toMatch(/Courier|NimbusMono/i);
  expect(result.styles[0].color).toEqual([expect.closeTo(.1, 2), expect.closeTo(.25, 2), expect.closeTo(.6, 2)]);
  expect(result.styles[0].size).toBeCloseTo(20);
  // The reading page also shows and copies current text before Apply is pressed.
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(page.locator('.text-edit-preview-selection .textLayer')).toContainText(replacement);
  expect(errors).toEqual([]);
});

test('supports word selection, real Enter line breaks, vertical navigation, and Chinese composition', async ({ page }) => {
  const block = await open(page); await block.click({ position: { x: 100, y: 10 } });
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await expect(page.locator('.text-edit-preview')).toBeVisible();
  await block.dblclick({ position: { x: 100, y: 10 } });
  await expect.poll(() => input.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('original');
  await input.pressSequentially('edited');
  await input.press('Control+End'); await input.press('Enter'); await input.pressSequentially('Second line');
  await expect(input).toHaveValue('The edited PDF text.\nSecond line');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'The edited PDF text.\nSecond line');
  await input.press('Home'); await input.press('ArrowUp');
  await expect.poll(() => input.evaluate(element => element.selectionStart)).toBe(0);
  await input.press('Control+End');
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true }));
  });
  await expect(input).toBeFocused();
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  await input.fill('The edited PDF text.\n中文编辑');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'The edited PDF text.\n中文编辑');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Control+Enter');
  expect(inspect(await bytes(page)).text).toContain('中文编辑');
});

test('grows a short original line into available space while respecting a nearby figure', async ({ page }) => {
  const block = await open(page); await block.click();
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  // Type before the first worker result as well: the layout must still catch up.
  const replacement = 'A longer direct edit that wraps onto another line while the colored figure below stays clear.';
  await input.fill(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.press('Control+Enter');
  const result = inspect(await bytes(page));
  expect(result.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  expect(result.text).toContain('NEIGHBOR STAYS');
  await page.getByRole('button', { name: /^Undo/ }).click();
  expect(inspect(await bytes(page)).text).toContain(original);
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(inspect(await bytes(page)).text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  await page.locator('.text-block').filter({ hasText: replacement }).click({ position: { x: 10, y: 34 } });
  await expect.poll(() => input.evaluate(element => element.selectionStart)).toBeGreaterThan(30);
  const offset = await input.evaluate(element => element.selectionStart);
  await input.pressSequentially('X');
  await expect(input).toHaveValue(replacement.slice(0, offset) + 'X' + replacement.slice(offset));
  await input.press('Control+Enter');
});

test('maps the original caret position through native page rotation', async ({ page }) => {
  for (const rotation of [90, 270]) {
    const block = await open(page, rotation), bounds = (await block.boundingBox())!;
    await block.click({ position: rotation === 90 ? { x: 10, y: 49 } : { x: 10, y: bounds.height - 49 } });
    const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
    await expect(page.locator('.text-edit-preview')).toBeVisible();
    await expect.poll(() => input.evaluate(element => element.selectionStart)).toBe(4);
    await input.press('Delete'); await input.pressSequentially('O');
    await expect(input).toHaveValue('The Original PDF text.');
    await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'The Original PDF text.');
    await input.press('Control+Enter');
    expect(inspect(await bytes(page)).text).toContain('The Original PDF text.');
  }
});

test('drags a selection on the first click and replaces only those original characters', async ({ page }) => {
  const block = await open(page), bounds = (await block.boundingBox())!;
  await page.mouse.move(bounds.x + 4 * 12 + 1, bounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 12 * 12 + 1, bounds.y + 10, { steps: 8 });
  await page.mouse.up();
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await expect.poll(() => input.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('original');
  await input.pressSequentially('edited');
  await expect(input).toHaveValue('The edited PDF text.');
  await input.press('Control+Enter');
  expect(inspect(await bytes(page)).text).toContain('The edited PDF text.');
});

test('keeps native PDF links and form fields usable above the edited reading preview', async ({ page }) => {
  const block = await open(page, 0, true); await block.click();
  const input = page.getByRole('textbox', { name: 'Edit text on page 1', exact: true });
  await input.fill('The edited PDF text.');
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', 'The edited PDF text.');
  await input.press('Control+Enter');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(page.locator('.text-edit-preview-selection .textLayer')).toContainText('The edited PDF text.');
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Updated contact');
  const result = await bytes(page), document = await PDFDocument.load(result);
  expect(document.getForm().getTextField('Contact').getText()).toBe('Updated contact');
  expect(inspect(result).text).toContain('The edited PDF text.');
  await page.getByRole('link', { name: 'Go to destination', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('2');
});
