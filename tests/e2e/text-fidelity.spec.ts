import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, beginText, endText, setFontAndSize, setTextMatrix, setCharacterSqueeze, showText, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page, obstacle = false) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 600]), font = await pdf.embedFont(StandardFonts.Courier);
  const key = sheet.node.newFontDictionary('Body', font.ref);
  const rows = ['alpha beta', 'gamma delta', 'third line'];
  rows.forEach((row, i) => sheet.pushOperators(beginText(), setFontAndSize(key, 12), setCharacterSqueeze(175), setTextMatrix(1, 0, 0, 1, 40, 500 - i * 16), showText(font.encodeText(row)), endText()));
  if (obstacle) sheet.drawRectangle({ x: 35, y: 445, width: 250, height: 16, color: rgb(.8, .2, .1) });
  sheet.drawText('NEIGHBOR STAYS', { x: 40, y: 300, size: 12, font });
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'scaled-paragraph.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const block = page.locator('.text-block').filter({ hasText: 'alpha beta' });
  await expect(block).toContainText('third line');
  await block.click({ position: { x: 20, y: 5 } });
  return page.locator('.pdf-text-input');
}
async function download(page: Page, name: 'Save' | 'Export' = 'Export') {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile((await (await pending).path())!);
}
function inspect(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  const glyphs: { c: string; x: number; y: number }[] = [];
  const image = sheet.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    text.walk({ onChar(c, origin, font) { try { glyphs.push({ c, x: origin[0], y: origin[1] }); } finally { font.destroy(); } } });
    return { text: text.asText(), glyphs, pixels: Buffer.from(image.getPixels()) };
  } finally { image.destroy(); text.destroy(); sheet.destroy(); pdf.destroy(); }
}

test('saves the 53pt/44pt regression before the preview worker is ready and reopens without duplication', async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('InlineTextPreview')) {
          const send = this.postMessage.bind(this);
          this.postMessage = (...args: Parameters<Worker['postMessage']>) => { setTimeout(() => send(...args), 2000); };
        }
      }
    };
  });
  const input = await open(page), replacement = 'omega beta gamma delta third line';
  await input.fill(replacement);
  // No wait for the worker: saving must measure the current edit itself.
  const saved = await download(page, 'Save'), output = inspect(saved);
  expect(output.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  expect(output.text).not.toContain('alpha'); expect(output.text).toContain('NEIGHBOR STAYS');
  expect([...new Set(output.glyphs.filter(g => g.y < 200).map(g => Math.round(g.y)))]).toEqual([100, 116, 132]);
  const editedGlyphs = output.glyphs.filter(g => g.y < 200);
  expect(editedGlyphs[1].x - editedGlyphs[0].x).toBeCloseTo(12.6, 2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'saved.pdf', mimeType: 'application/pdf', buffer: saved });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  const reopened = inspect(await download(page));
  expect(reopened.pixels).toEqual(output.pixels);
  expect(reopened.text.match(/omega/g)).toHaveLength(1);
});

test('uses the same layout and PDF pixels for growing mixed-language text, preview and export', async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('InlineTextPreview')) this.addEventListener('message', event => {
          if (event.data.bytes && event.data.prepared) Reflect.set(window, '__textPreview', { text: event.data.prepared.input.text, bytes: Array.from(event.data.bytes) });
        });
      }
    };
  });
  const input = await open(page), replacement = '中英文 mixed text\n新增一行文字\nThird line\nFourth line';
  await input.fill(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const preview = await page.evaluate(() => Reflect.get(window, '__textPreview') as { text: string; bytes: number[] });
  expect(preview.text).toBe(replacement);
  const result = inspect(await download(page));
  expect(result.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  expect(result.pixels).toEqual(inspect(new Uint8Array(preview.bytes)).pixels);
  await page.getByRole('button', { name: /^Undo/ }).click();
  expect(inspect(await download(page)).text).toContain('alpha beta');
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(inspect(await download(page)).pixels).toEqual(result.pixels);
});

test('shows a persistent early overflow action and lets users move the whole text without reducing its size', async ({ page }) => {
  const input = await open(page, true), replacement = 'alpha beta\ngamma delta\nthird line\nextra line';
  await input.fill(replacement);
  const notice = page.locator('.text-edit-notice');
  await expect(notice).toContainText('needs more space');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Text layout…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Text layout', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue(replacement);
  for (const [name, value] of [['Y', '180'], ['Width', '230'], ['Height', '100']]) {
    const field = dialog.getByRole('spinbutton', { name, exact: true }); await field.fill(value); await field.press('Tab');
  }
  await expect(dialog.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('12');
  await expect(dialog.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(notice).toHaveCount(0);
  const result = inspect(await download(page));
  expect(result.text.replace(/\s/g, '')).toContain(replacement.replace(/\s/g, ''));
  expect(result.text).toContain('NEIGHBOR STAYS');
});

test('keeps the Issues link visible on desktop and mobile and switches its language immediately', async ({ page }) => {
  await page.goto('./');
  const feedback = page.locator('.app-feedback');
  await expect(feedback).toContainText('Found a bug');
  await expect(feedback.getByRole('link')).toHaveAttribute('href', 'https://github.com/JhuoW/PDF-Editor/issues');
  await expect(feedback.getByRole('link')).toBeInViewport();
  await page.locator('.main-toolbar .language-switcher button[lang="zh-CN"]').click();
  await expect(feedback).toContainText('使用过程中遇到问题或发现 Bug？欢迎通过');
  await expect(feedback.getByRole('link')).toHaveText('GitHub Issues 反馈');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(feedback.getByRole('link')).toBeInViewport();
  await page.reload(); await expect(feedback).toContainText('GitHub Issues 反馈');
});
