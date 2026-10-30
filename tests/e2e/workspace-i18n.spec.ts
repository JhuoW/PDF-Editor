import { revealPDFRegion } from './pdf-region';
import { Buffer } from 'node:buffer';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';

async function open(page: Page) {
  const pdf = await PDFDocument.create(), sheet = pdf.addPage([500, 650]); pdf.addPage([500, 650]);
  sheet.drawText('Open Delete Close', { x: 50, y: 540, size: 18 });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original English value'); field.addToPage(sheet, { x: 50, y: 380, width: 250, height: 25 });
  const outline = pdf.context.obj({ Type: 'Outlines' }), item = pdf.context.obj({ Title: pdf.context.obj('Open'), Dest: [sheet.ref, 'Fit'] });
  // Use a literal PDF string for the bookmark title.
  const { PDFString } = await import('pdf-lib'); item.set(PDFName.of('Title'), PDFString.of('Open'));
  const ref = pdf.context.register(item); outline.set(PDFName.of('First'), ref); outline.set(PDFName.of('Last'), ref); outline.set(PDFName.of('Count'), pdf.context.obj(1));
  const outlineRef = pdf.context.register(outline); item.set(PDFName.of('Parent'), outlineRef); pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'Open Delete.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}
async function language(page: Page, locale: 'en' | 'zh-CN', scope: Locator = page.locator('.main-toolbar')) {
  await scope.locator(`.language-switcher button[lang="${locale}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}
async function command(page: Page, id: string) {
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  await page.locator(`.workspace-all-tools [data-command="${id}"]`).click();
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download'); await page.locator('.main-toolbar .toolbar-btn-primary').click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}

test('switches every workspace immediately, keeps PDF/form/bookmark content and remembers the preference', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Keep this English edit');
  await language(page, 'zh-CN');
  for (const [id, name] of [['home', '主页'], ['edit', '编辑'], ['annotate', '注释'], ['organize', '页面管理'], ['convert', '格式转换'], ['forms', '表单与签名'], ['protect', '保护']]) {
    await page.locator(`#workspace-${id}`).click(); await expect(page.locator(`#workspace-${id}`)).toHaveText(name);
    const labels = await page.locator('.workspace-ribbon .workspace-tool span').allTextContents();
    expect(labels.every(text => /[\u3400-\u9fff]/.test(text))).toBe(true);
  }
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Keep this English edit');
  await expect(page.locator('.textLayer').first()).toContainText('Open Delete Close');
  await page.getByRole('tab', { name: '书签', exact: true }).click(); await expect(page.locator('.outline-title')).toHaveText('Open');
  await language(page, 'en'); await expect(page.getByRole('tab', { name: 'Forms & Sign', exact: true })).toBeVisible();
  await language(page, 'zh-CN'); await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/);
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Keep this English edit');
  expect(errors).toEqual([]);
});

test('language changes preserve the active original-text draft, caret and undo history through export', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await open(page); await command(page, 'edit-text');
  await page.locator('.text-block').filter({ hasText: 'Open Delete Close' }).click();
  const input = page.locator('.pdf-text-input');
  await expect(input).toBeFocused(); await input.press('Control+A'); await input.fill('Original PDF edited');
  await input.press('Home'); await input.press('ArrowRight');
  const cursor = await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart);
  const canvas = page.locator('canvas.page-canvas'), before = await canvas.boundingBox();
  await language(page, 'zh-CN'); await expect(input).toBeFocused(); await expect(input).toHaveValue('Original PDF edited');
  expect(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(cursor);
  expect((await canvas.boundingBox())!.y).toBe(before!.y);
  await expect(page.getByRole('button', { name: '完成', exact: true })).toBeVisible();
  await language(page, 'en'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  const pdf = new mupdf.PDFDocument(await exported(page)), sheet = pdf.loadPage(0), text = sheet.toStructuredText('');
  try { expect(text.asText()).toContain('Original PDF edited'); expect(text.asText()).not.toContain('Open Delete Close'); } finally { text.destroy(); sheet.destroy(); pdf.destroy(); }
  await expect(page.locator('.combined-toolbar button[title^="Undo"]')).toBeEnabled();
});

test('native dialogs switch languages inside the modal and preserve unfinished property values', async ({ page }) => {
  await open(page); await command(page, 'properties');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  const title = dialog.locator('input[aria-label]').filter({ hasNot: page.locator('[type=checkbox]') }).first(); await title.fill('Keep this title');
  await language(page, 'zh-CN', dialog); await expect(title).toHaveValue('Keep this title');
  await expect(dialog.getByRole('button', { name: '保存属性', exact: true })).toBeVisible();
  await language(page, 'en', dialog); await expect(title).toHaveValue('Keep this title');
  await dialog.getByRole('button', { name: 'Close document properties', exact: true }).click();
});

test('all existing commands remain accessible and Chinese modal labels contain no English UI prose', async ({ page }) => {
  await open(page); await language(page, 'zh-CN');
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  expect(await page.locator('.workspace-all-tools [data-command]').count()).toBeGreaterThanOrEqual(35);
  await page.keyboard.press('Escape');
  for (const id of ['merge', 'split', 'extract-pages', 'duplicate-pages', 'replace-pages', 'crop-pages', 'create-pdf', 'pdf-to-images', 'export-pages', 'ocr', 'compress', 'form-designer', 'signature', 'encrypt', 'clean', 'properties', 'links', 'bookmarks', 'appearance']) {
    await command(page, id); const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await expect(dialog.locator('.language-switcher button[lang="zh-CN"]')).toHaveAttribute('aria-pressed', 'true');
    // Every visible action is localized. Technical formats/units and user data are allowed.
    const labels = await dialog.locator('button:visible,legend:visible').allTextContents();
    for (const value of labels) {
      const words = value.replace(/English|PDF|OCR|XMP|JSON|XFDF|FDF|JPEG|PNG|AES|ZIP|dpi|Ctrl|[XYZWH]|Contact/g, '');
      expect(words, `${id}: ${value}`).not.toMatch(/[A-Za-z]{3}/);
    }
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  }
});

test('workspace tabs own arrow keys and language controls remain reachable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await expect(page.locator('.workspace-history > button').nth(0)).toBeInViewport();
  await expect(page.locator('.workspace-history > button').nth(1)).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Toggle properties', exact: true })).toBeInViewport();
  const home = page.locator('#workspace-home'); await home.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#workspace-edit')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('1');
  await expect(page.locator('.main-toolbar .language-switcher')).toBeInViewport();
  expect((await page.locator('.main-toolbar .language-switcher').boundingBox())!.x + (await page.locator('.main-toolbar .language-switcher').boundingBox())!.width).toBeLessThanOrEqual(390);
  await language(page, 'zh-CN'); await expect(page.locator('.main-toolbar .language-switcher')).toBeInViewport();
  await page.locator('[data-toolbar-menu-trigger="document"]').click();
  const bounds = (await page.locator('.workspace-all-tools').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.x + bounds.width).toBeLessThanOrEqual(382);
});

test('language switching keeps rich-text annotation drafts and exposes localized properties', async ({ page }) => {
  await open(page); await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  await page.locator('.quick-tools').getByTitle('Text Box', { exact: true }).click();
  await revealPDFRegion(page, 350, 425);
  const bounds = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 350); await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 425, { steps: 5 }); await page.mouse.up();
  const editor = page.locator('.tiptap-editor-content[contenteditable="true"]');
  await expect(editor).toBeFocused(); await editor.pressSequentially('Keep this English annotation');
  await language(page, 'zh-CN'); await expect(editor).toBeFocused(); await expect(editor).toHaveText('Keep this English annotation');
  await language(page, 'en'); await expect(editor).toHaveText('Keep this English annotation');
  await page.locator('.quick-tools [data-command="select"]').click();
  await revealPDFRegion(page, 350, 425);
  const current = (await page.locator('canvas.page-canvas').boundingBox())!;
  await page.mouse.click(current.x + 100, current.y + 375, { button: 'right' });
  await expect(page.getByRole('button', { name: 'Text Properties...', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Text Properties...', exact: true }).click();
  await expect(page.locator('.workspace-inspector')).toBeVisible();
  await language(page, 'zh-CN'); await expect(page.locator('.workspace-inspector')).toContainText('文字');
  await expect(page.locator('.text-properties-panel')).toBeVisible();
});

test('Confirmation dialogs are localized and can switch without resetting the decision', async ({ page }) => {
  await open(page); await language(page, 'zh-CN');
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Unexported edit');
  await command(page, 'close'); const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible(); await language(page, 'en', dialog);
  await expect(dialog.getByRole('button', { name: 'Close Without Saving', exact: true })).toBeVisible();
  await language(page, 'zh-CN', dialog);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Unexported edit');
});

test('invalid PDF feedback uses the current UI language', async ({ page }) => {
  await page.goto('./'); await language(page, 'zh-CN');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('This is not a PDF') });
  const error = page.locator('.error-state'); await expect(error).toBeVisible();
  await expect(error).toContainText(/[\u3400-\u9fff]/); await expect(error).not.toContainText(/Invalid PDF|Unknown error|Failed to/);
  await language(page, 'en'); await expect(error).toContainText(/[A-Za-z]{3}/);
});

test('Chinese history feedback localizes page actions and preserves functional undo and redo', async ({ page }) => {
  await open(page); await language(page, 'zh-CN'); await page.locator('#workspace-organize').click();
  await page.locator('.workspace-ribbon [data-command="rotate-right"]').click();
  await expect.poll(async () => { const box = (await page.locator('canvas.page-canvas').boundingBox())!; return box.width / box.height; }).toBeGreaterThan(1);
  const undo = page.locator('.workspace-history > button').nth(0), redo = page.locator('.workspace-history > button').nth(1);
  await expect(undo).toHaveAccessibleName(/撤销/); await expect(undo).not.toHaveAttribute('title', /Rotate|page/);
  await undo.click();
  await expect.poll(async () => { const box = (await page.locator('canvas.page-canvas').boundingBox())!; return box.width / box.height; }).toBeLessThan(1);
  await expect(redo).not.toHaveAttribute('title', /Rotate|page/); await redo.click();
  await expect.poll(async () => { const box = (await page.locator('canvas.page-canvas').boundingBox())!; return box.width / box.height; }).toBeGreaterThan(1);
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('Original English value');
});
