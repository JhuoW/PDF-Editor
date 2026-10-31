import { revealPDFRegion } from './pdf-region';
import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';

type Region = [number, number, number, number];
function pixels(png: Buffer) {
  const image = new mupdf.Image(png);
  const pixmap = image.toPixmap();
  try { return { width: pixmap.getWidth(), height: pixmap.getHeight(), channels: pixmap.getNumberOfComponents(), data: new Uint8Array(pixmap.getPixels()) }; }
  finally { pixmap.destroy(); image.destroy(); }
}
function bounds(image: ReturnType<typeof pixels>, region: Region, color: 'blue' | 'green' | 'black') {
  const positions: Array<[number, number]> = [];
  for (let y = region[1]; y < Math.min(image.height, region[3]); y++) {
    for (let x = region[0]; x < Math.min(image.width, region[2]); x++) {
      const offset = (y * image.width + x) * image.channels;
      const [r, g, b] = image.data.slice(offset, offset + 3);
      if (color === 'blue' ? b > 140 && r < 100 && g < 160 : color === 'green' ? g > 150 && r < 100 && b < 100 : r < 100 && g < 100 && b < 100) positions.push([x, y]);
    }
  }
  return positions.length ? [Math.min(...positions.map(p => p[0])), Math.min(...positions.map(p => p[1])), Math.max(...positions.map(p => p[0])), Math.max(...positions.map(p => p[1]))] : null;
}
function assertNear(actual: number[] | null, expected: number[], tolerance = 3) {
  expect(actual).not.toBeNull();
  actual!.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(tolerance));
}
async function draw(page: Page, title: string, points: [number, number][]) {
  await page.locator('.quick-tools').getByTitle(title, { exact: true }).click();
  await revealPDFRegion(page, Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[1])));
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 5 });
  await page.mouse.up();
}
async function exported(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const stream = await (await ready).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
});

for (const rotation of [90, 270]) {
  test(`drawing, selecting, resizing, image insertion and text boxes match export on CropBox/UserUnit2/Rotate${rotation}`, async ({ page }) => {
    const source = await PDFDocument.create();
    const pdfPage = source.addPage([600, 500]);
    pdfPage.setCropBox(50, 50, 300, 350);
    pdfPage.setRotation(degrees(rotation));
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    await page.goto('./');
    await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'drawing-coordinates.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) });
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
    await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
    await draw(page, 'Rectangle', [[60, 60], [200, 160]]);
    await page.getByTitle('Select (V)', { exact: true }).click();
    const box = (await page.locator('canvas.page-canvas').boundingBox())!;
    // Drag in Select mode, then enlarge the screen-right edge. This exercises
    // the inverse page transform and both logical north/south resize handles.
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 130, box.y + 110);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 130, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.mouse.move(box.x + 220, box.y + 130);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 130, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await draw(page, 'Ellipse', [[300, 60], [400, 160]]);
    await draw(page, 'Freehand', [[60, 250], [100, 270], [140, 250]]);
    await draw(page, 'Line', [[300, 220], [420, 280]]);

    const green = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 32, 24], false);
    const greenPixels = green.getPixels();
    for (let offset = 0; offset < greenPixels.length; offset += 3) greenPixels.set([0, 255, 0], offset);
    const image = Buffer.from(green.asPNG());
    green.destroy();
    await page.getByLabel('Insert images', { exact: true }).setInputFiles({ name: 'green.png', mimeType: 'image/png', buffer: image });
    await expect(page.locator('.image-placement-status')).toBeVisible();
    const placementBox = (await page.locator('canvas.page-canvas').boundingBox())!;
    await page.mouse.click(placementBox.x + 450, placementBox.y + 400);
    await page.keyboard.press('Escape');

    await draw(page, 'Text Box', [[60, 370], [300, 470]]);
    const editor = page.locator('.tiptap-editor-content[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await editor.fill('PDF note');
    await expect(editor).toHaveText('PDF note');
    await page.getByTitle('Select (V)', { exact: true }).click();
    await expect(editor).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Read the entire rendered canvas: a laptop viewport can clip its lower
    // edge even after scrolling. A DOM screenshot would omit valid PDF pixels.
    const preview = pixels(Buffer.from(await page.locator('canvas.annotation-canvas').evaluate(source => {
      const canvas = document.createElement('canvas');
      const bounds = source.getBoundingClientRect();
      canvas.width = Math.round(bounds.width); canvas.height = Math.round(bounds.height);
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.setTransform(new DOMMatrix(getComputedStyle(source.parentElement!).transform));
      context.drawImage(source as HTMLCanvasElement, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64'));
    assertNear(bounds(preview, [20, 20, 280, 200], 'blue'), [78, 78, 241, 181]);
    expect(bounds(preview, [390, 340, 520, 460], 'green')).not.toBeNull();
    await draw(page, 'Sticky Note', [[600, 450]]);
    const noteContent = page.getByRole('textbox', { name: 'Note content', exact: true });
    await noteContent.fill('Rotated note 便签');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await noteContent.press('Escape');
    await page.getByTitle('Select (V)', { exact: true }).click();
    const currentBox = (await page.locator('canvas.page-canvas').boundingBox())!;
    await page.mouse.click(currentBox.x + 606, currentBox.y + 456);
    await expect(noteContent).toHaveValue('Rotated note 便签');
    await noteContent.press('Escape');
    const bytes = await exported(page);
    const document = new mupdf.PDFDocument(bytes);
    const resultPage = document.loadPage(0);
    const pixmap = resultPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const result = pixels(Buffer.from(pixmap.asPNG()));
    try {
      const note = resultPage.getAnnotations().find(annotation => annotation.getType() === 'Text')!;
      expect(note.getContents()).toBe('Rotated note 便签');
      const noteRect = note.getObject().get('Rect');
      const x = noteRect.get(0).asNumber(), y = noteRect.get(3).asNumber();
      const [a, b, c, d, e, f] = resultPage.getTransform();
      const noteAnchor = [a * x + c * y + e, b * x + d * y + f];
      assertNear(noteAnchor, [600, 450], 1);
      noteRect.destroy(); note.destroy();
      for (const [region, color] of [
        [[20, 20, 280, 200], 'blue'], [[280, 20, 450, 200], 'blue'],
        [[30, 220, 180, 300], 'black'], [[280, 200, 450, 300], 'black'],
        [[390, 340, 520, 460], 'green'],
      ] as Array<[Region, 'blue' | 'green' | 'black']>) {
        assertNear(bounds(result, region, color), bounds(preview, region, color)!);
      }
      const text = resultPage.toStructuredText('');
      try {
        expect(text.asText().replace(/\s/g, '')).toContain('PDFnote');
        let textBounds: number[] | undefined;
        text.walk({ beginTextBlock(rect) { textBounds = rect; } });
        expect(textBounds).toBeDefined();
        expect(textBounds![0]).toBeGreaterThanOrEqual(60);
        expect(textBounds![1]).toBeGreaterThanOrEqual(370);
        expect(textBounds![2]).toBeLessThanOrEqual(300);
        expect(textBounds![3]).toBeLessThanOrEqual(470);
      } finally { text.destroy(); }
    } finally { pixmap.destroy(); resultPage.destroy(); document.destroy(); }
  });
}

test('rapidly switching text boxes preserves both drafts and ignores old delayed blur callbacks', async ({ page }) => {
  const source = await PDFDocument.create();
  source.addPage([400, 600]);
  await page.goto('./');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'text-sessions.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  const editor = page.locator('.tiptap-editor-content[contenteditable="true"]');
  await draw(page, 'Text Box', [[30, 100], [300, 170]]);
  await editor.fill('First text');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(editor).toHaveCount(0);
  await draw(page, 'Text Box', [[30, 250], [300, 320]]);
  await editor.fill('Second text');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(editor).toHaveCount(0);
  const box = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.dblclick(box.x + 80, box.y + 130);
  await expect(editor).toBeFocused();
  await editor.fill('First revised');
  await expect(editor).toHaveText('First revised');
  // No waiting between editing the first box and opening the second one.
  const editingBox = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.dblclick(editingBox.x + 80, editingBox.y + 280);
  await expect(editor).toHaveText('Second text');
  await editor.fill('Second revised');
  await page.getByTitle('Select (V)', { exact: true }).click();
  await expect(editor).toHaveCount(0);
  const document = new mupdf.PDFDocument(await exported(page));
  const pdfPage = document.loadPage(0), text = pdfPage.toStructuredText('');
  try {
    expect(text.asText()).toContain('First revised');
    expect(text.asText()).toContain('Second revised');
  } finally { text.destroy(); pdfPage.destroy(); document.destroy(); }
});
