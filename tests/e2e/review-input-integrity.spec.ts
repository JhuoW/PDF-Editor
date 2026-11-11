import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type CDPSession } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

test.use({ hasTouch: true, viewport: { width: 1440, height: 1000 } });
async function open(page: Page, bytes?: Uint8Array) {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const pdf = await PDFDocument.create(); pdf.addPage([400, 500]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'input-review.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes ?? await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function touch(cdp: CDPSession, x: number, y: number, end: 'touchEnd' | 'touchCancel' = 'touchEnd') {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 6; index++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + index * 8, y: y + index * 5 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
}
async function download(page: Page) {
  const ready = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  return readFile((await (await ready).path())!);
}

test('touch draws exportable ink, cancellation discards the draft and the next gesture works', async ({ page, context }) => {
  await open(page); const cdp = await context.newCDPSession(page);
  await page.getByTitle('Freehand', { exact: true }).click();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await touch(cdp, box.x + 50, box.y + 100, 'touchCancel');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(page.locator('.annotation-hit-regions path')).toHaveCount(0);
  await page.getByTitle('Freehand', { exact: true }).click();
  await touch(cdp, box.x + 50, box.y + 100);
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(page.locator('.annotation-hit-regions path')).toHaveCount(1);
  const pdf = new mupdf.PDFDocument(await download(page)), first = pdf.loadPage(0), pixmap = first.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  try {
    const pixels = pixmap.getPixels(); let colored = 0;
    for (let y = 96; y < 138; y++) for (let x = 46; x < 104; x++) {
      const offset = (y * pixmap.getWidth() + x) * 3;
      if (pixels[offset] < 200 || pixels[offset + 1] < 200 || pixels[offset + 2] < 200) colored++;
    }
    expect(colored).toBeGreaterThan(40);
  } finally { pixmap.destroy(); first.destroy(); pdf.destroy(); }
  await page.getByRole('button', { name: /^Undo/ }).click(); await expect(page.locator('.annotation-hit-regions path')).toHaveCount(0);
});

test('losing capture or window focus cancels a drawing and touch does not hijack text box typing', async ({ page, context }) => {
  await open(page); const cdp = await context.newCDPSession(page);
  await page.evaluate(() => { window.addEventListener('pointerdown', event => { (window as unknown as { testPointer: number }).testPointer = event.pointerId; }); });
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  for (const interrupted of ['capture', 'blur', 'escape']) {
    await page.getByTitle('Freehand', { exact: true }).click();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 50, y: box.y + 100 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + 110, y: box.y + 125 }] });
    await page.evaluate(kind => {
      if (kind === 'blur') window.dispatchEvent(new Event('blur'));
      else if (kind === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      else document.querySelector('.drawing-annotation-layer')!.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: (window as unknown as { testPointer: number }).testPointer }));
    }, interrupted);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByTitle('Select (V)', { exact: true }).click(); await expect(page.locator('.annotation-hit-regions path')).toHaveCount(0);
  }
  await page.locator('.quick-tools').getByTitle('Text Box', { exact: true }).click();
  await page.mouse.move(box.x + 40, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 250, box.y + 290, { steps: 5 }); await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable=true]'); await expect(editor).toBeVisible();
  await editor.fill('Draft stays editable'); await editor.tap(); await page.keyboard.press('End'); await page.keyboard.type('!');
  await expect(editor).toHaveText('Draft stays editable!');
});

for (const format of ['webp', 'svg'] as const) test(`replaces a PNG with ${format}, rejects negative width and saves actual new pixels`, async ({ page }) => {
  await open(page);
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 70; const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 100, 70); return canvas.toDataURL().split(',')[1]; });
  await page.getByLabel('Insert images', { exact: true }).setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('.image-placement-status')).toBeVisible();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(box.x + 150, box.y + 150);
  const panel = page.locator('.image-properties-panel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Toggle properties', exact: true }).click();
  const width = panel.getByLabel('Width:', { exact: true }).first();
  await width.fill('-10'); await expect(width).toHaveAttribute('aria-invalid', 'true'); await width.press('Enter'); await expect(width).toHaveValue('100');
  await width.fill('130'); await width.press('Escape'); await expect(width).toHaveValue('100');
  let bytes: Buffer;
  if (format === 'svg') bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"><path fill="#00ff00" d="M0 0H100V70H0Z"/></svg>');
  else bytes = Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 70; const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 100, 70); return canvas.toDataURL('image/webp', 1).split(',')[1]; }), 'base64');
  await panel.locator('input[type=file]').setInputFiles({ name: `replacement.${format}`, mimeType: format === 'svg' ? 'image/svg+xml' : 'image/webp', buffer: bytes });
  await expect(panel.locator('.info-value').filter({ hasText: 'image/png' })).toBeVisible();
  await expect(panel).toContainText(`replacement.${format}`);
  const pdf = new mupdf.PDFDocument(await download(page)), sheet = pdf.loadPage(0), pixmap = sheet.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
  try { const offset = (150 * pixmap.getWidth() + 150) * 3, sample = Array.from(pixmap.getPixels().slice(offset, offset + 3)); expect(sample[1]).toBeGreaterThan(240); expect(sample[0]).toBeLessThan(15); }
  finally { pixmap.destroy(); sheet.destroy(); pdf.destroy(); }
  expect(await panel.locator('input:not([type=file]),select').evaluateAll(inputs => inputs.every(input => (input as HTMLInputElement).labels?.length || input.getAttribute('aria-label')))).toBe(true);
});

test('text markup is created by selecting PDF text and stays movable and deletable after reopening', async ({ page, context }) => {
  const document = await PDFDocument.create(), sheet = document.addPage([400, 500]);
  sheet.drawText('Highlight this PDF text', { x: 50, y: 350, size: 18 });
  await open(page, await document.save());
  await page.locator('.quick-tools').getByTitle('Highlight', { exact: true }).click();
  const words = page.locator('.textLayer span').filter({ hasText: 'Highlight this PDF text' });
  await expect(words).toBeVisible(); const box = (await words.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(page.locator('.annotation-hit-regions polygon')).toHaveCount(1);
  const saved = await download(page);
  const reopened = await context.newPage(); await open(reopened, saved);
  const polygon = reopened.locator('.annotation-hit-regions polygon'); await expect(polygon).toHaveCount(1);
  const original = await polygon.getAttribute('points');
  await polygon.click(); await expect(polygon).toHaveAttribute('stroke', '#0066ff');
  await reopened.keyboard.press('ArrowRight');
  await expect(polygon).not.toHaveAttribute('points', original!);
  await reopened.getByRole('button', { name: /^Undo/ }).click(); await expect(polygon).toHaveAttribute('points', original!);
  const bounds = (await polygon.boundingBox())!;
  await reopened.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await reopened.mouse.down();
  await reopened.mouse.move(bounds.x + bounds.width / 2 + 25, bounds.y + bounds.height / 2 + 35, { steps: 4 });
  await reopened.evaluate(() => window.dispatchEvent(new Event('blur'))); await reopened.mouse.up();
  await expect(polygon).toHaveAttribute('points', original!);
  await polygon.click(); await reopened.keyboard.press('Delete'); await expect(polygon).toHaveCount(0);
  await reopened.getByRole('button', { name: /^Undo/ }).click(); await expect(polygon).toHaveCount(1);
  const exported = new mupdf.PDFDocument(await download(reopened)), exportedPage = exported.loadPage(0);
  try { const annotations = exportedPage.getAnnotations(); expect(annotations.map(annotation => annotation.getType())).toEqual(['Highlight']); annotations.forEach(annotation => annotation.destroy()); }
  finally { exportedPage.destroy(); exported.destroy(); }
  await reopened.close();
});

test('additional fingers cannot create a second stroke or move the primary stroke', async ({ page, context }) => {
  await open(page); const cdp = await context.newCDPSession(page);
  await page.getByTitle('Freehand', { exact: true }).click();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  const primary = { id: 1, x: box.x + 50, y: box.y + 100 }, second = { id: 2, x: box.x + 250, y: box.y + 300 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary, second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...primary, x: primary.x + 70, y: primary.y + 30 }, { ...second, x: second.x + 30 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...primary, x: primary.x + 70, y: primary.y + 30 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.getByTitle('Select (V)', { exact: true }).click(); const path = page.locator('.annotation-hit-regions path');
  await expect(path).toHaveCount(1); const stroke = (await path.boundingBox())!;
  expect(stroke.width).toBeLessThan(100); expect(stroke.height).toBeLessThan(60);
});

test('text properties format existing text and an open editor keeps the new style through export and reopen', async ({ page, context }) => {
  await open(page);
  await page.locator('.quick-tools').getByTitle('Text Box', { exact: true }).click();
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 50); await page.mouse.down(); await page.mouse.move(box.x + 340, box.y + 180, { steps: 5 }); await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable=true]'); await expect(editor).toBeVisible(); await editor.fill('Visible formatting');
  const panel = page.locator('.workspace-inspector .text-properties-panel');
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Toggle properties', exact: true }).click();
  const size = panel.getByRole('spinbutton', { name: 'Custom font size', exact: true });
  await size.fill('23.5'); await size.press('Enter');
  await panel.getByTitle('Bold (Ctrl+B)', { exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('Visible formatting');
  await expect(editor.locator('strong')).toHaveCSS('font-size', '23.5px');
  await page.getByRole('button', { name: 'Export', exact: true }).focus();
  const saved = await download(page);
  const document = new mupdf.PDFDocument(saved), sheet = document.loadPage(0), display = sheet.toDisplayList(true), text = display.toStructuredText();
  try {
    const characters: { character: string; size: number; font: string }[] = [];
    text.walk({ onChar(character, _origin, font, size) {
      try { characters.push({ character, size, font: font.getName() }); } finally { font.destroy(); }
    } });
    expect(characters.map(item => item.character).join('')).toBe('Visible formatting');
    expect(characters.every(item => Math.abs(item.size - 23.5) < .05 && /bold/i.test(item.font)), JSON.stringify(characters)).toBe(true);
  } finally { text.destroy(); display.destroy(); sheet.destroy(); document.destroy(); }
  const reopened = await context.newPage(); await open(reopened, saved);
  const region = reopened.locator('.annotation-hit-regions rect').first(); await region.dblclick();
  const restored = reopened.locator('.tiptap-editor-content'); await expect(restored).toBeVisible();
  await expect(restored.locator('strong')).toHaveText('Visible formatting');
  await expect(restored.locator('strong')).toHaveCSS('font-size', '23.5px');
  await reopened.close();
});
