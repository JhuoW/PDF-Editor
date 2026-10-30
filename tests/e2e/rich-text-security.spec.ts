import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

test('pastes formatted text without executing HTML or loading injected resources and exports the text', async ({ page }) => {
  const requests: string[] = [], errors: string[] = [];
  await page.route('https://invalid.example/**', async route => { requests.push(route.request().url()); await route.abort(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const source = await PDFDocument.create(); source.addPage([400, 600]);
  await page.goto('/');
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'safe-paste.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) });
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
  await page.locator('.quick-tools').getByTitle('Text Box', { exact: true }).click();
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 180); await page.mouse.down();
  await page.mouse.move(bounds.x + 360, bounds.y + 330, { steps: 5 }); await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable="true"]');
  await expect(editor).toBeFocused();
  await editor.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'Pasted content\nSafe second line');
    clipboard.setData('text/html', `<p onclick="window.__pasteExecuted=1" style="position:fixed;inset:0">
      <span style="font-family:Arial;font-size:22px;color:#123456;background-image:url(https://invalid.example/css)"><strong><u>Pasted content</u></strong></span>
      <script>window.__pasteExecuted=1</script><img src="https://invalid.example/image" onerror="window.__pasteExecuted=1"></p>
      <p style="text-align:center">Safe second line</p>`);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(editor).toContainText('Pasted content');
  await expect(editor.locator('strong u, u strong')).toHaveText('Pasted content');
  expect(await editor.locator('span').evaluateAll(elements => elements.some(element => (element as HTMLElement).style.fontSize === '22px'))).toBe(true);
  await expect(editor.locator('script, img, [onclick], [onerror]')).toHaveCount(0);
  expect(await editor.locator('[style]').evaluateAll(elements => elements.map(element => element.getAttribute('style')).join(' '))).not.toMatch(/position|inset|background-image|invalid\.example/);
  expect(await page.evaluate(() => Reflect.get(window, '__pasteExecuted'))).toBeUndefined();

  // Exercise the official font-size extension through the existing toolbar.
  await editor.press('ControlOrMeta+a');
  await page.getByTitle('Font Size', { exact: true }).selectOption('18');
  expect(await editor.locator('span').evaluateAll(elements => elements.some(element => (element as HTMLElement).style.fontSize === '18px'))).toBe(true);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const downloaded = await pending;
  const document = new mupdf.PDFDocument(await readFile((await downloaded.path())!));
  try {
    const pdfPage = document.loadPage(0), list = pdfPage.toDisplayList(true), text = list.toStructuredText('');
    try {
      expect(text.asText()).toContain('Pasted content');
      expect(text.asText()).toContain('Safe second line');
      expect(text.asText()).not.toContain('__pasteExecuted');
    } finally { text.destroy(); list.destroy(); pdfPage.destroy(); }
  } finally { document.destroy(); }
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});
