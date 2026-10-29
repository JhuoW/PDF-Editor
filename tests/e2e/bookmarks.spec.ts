import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { createBookmarksPDF } from '../fixtures/bookmarksPDF';
async function open(page: Page) { await page.goto('./'); await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'bookmarks.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createBookmarksPDF()) }); await expect(page.locator('canvas.page-canvas')).toBeVisible(); }
async function go(page: Page, value: number) { const input = page.getByRole('spinbutton', { name: 'Page number', exact: true }); await input.fill(String(value)); await input.press('Enter'); await expect(page.locator(`.page-wrapper[data-page="${value}"] canvas.page-canvas`)).toBeVisible(); }
async function ready(panel: Locator) { await expect(panel.getByRole('status').filter({ hasText: /^Preview ready/ })).toBeVisible({ timeout: 30_000 }); await expect(panel.locator('.pdf-links-preview')).toHaveAttribute('aria-busy', 'false'); }
async function manage(page: Page) { await page.getByRole('button', { name: 'Document ▾', exact: true }).click(); await page.getByRole('button', { name: 'Bookmarks…', exact: true }).click(); const panel = page.getByRole('dialog', { name: 'Bookmarks', exact: true }); await ready(panel); return panel; }
async function select(panel: Locator, title: string) { const list = panel.getByRole('listbox', { name: 'Bookmarks', exact: true }); await list.selectOption((await list.locator('option').filter({ hasText: title }).getAttribute('value'))!); }
async function number(panel: Locator, name: string, value: number) { const input = panel.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab'); }
async function exportFile(page: Page) { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click(); return readFile((await (await pending).path())!); }
interface Bookmark { title: string; page?: number; view?: string; count?: number; children: Bookmark[] }
async function nativeBookmarks(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes), pages = pdf.getPages(), root = pdf.catalog.lookup(PDFName.of('Outlines'));
  const walk = (parent: PDFDict): Bookmark[] => { const result: Bookmark[] = []; let raw = parent.get(PDFName.of('First'));
    while (raw) { const node = pdf.context.lookup(raw); if (!(node instanceof PDFDict)) throw new Error('Invalid outline');
      const title = node.lookup(PDFName.of('Title')), dest = node.lookup(PDFName.of('Dest')), count = node.lookup(PDFName.of('Count')); const ref = dest instanceof PDFArray ? dest.get(0) : undefined;
      result.push({ title: title instanceof PDFString || title instanceof PDFHexString ? title.decodeText() : '', page: ref instanceof PDFRef ? pages.findIndex(page => page.ref.toString() === ref.toString()) + 1 : undefined, view: dest instanceof PDFArray ? dest.get(1).toString() : undefined, count: count instanceof PDFNumber ? count.asNumber() : undefined, children: walk(node) }); raw = node.get(PDFName.of('Next')); }
    return result; };
  return root instanceof PDFDict ? walk(root) : [];
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });
test('creates and organizes native bookmarks with current forms, follows full destinations and restores undo/refresh', async ({ page }) => {
  test.setTimeout(120_000); await open(page); await go(page, 2); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Bookmarks 中文 form'); await go(page, 1);
  const panel = await manage(page); await select(panel, 'Introduction');
  await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('开始 Introduction'); await panel.getByRole('combobox', { name: 'Destination page', exact: true }).selectOption('2');
  await panel.getByRole('combobox', { name: 'Destination view', exact: true }).selectOption('XYZ');
  for (const axis of ['X', 'Y']) await panel.getByRole('checkbox', { name: `Keep current ${axis}`, exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'Keep current zoom', exact: true }).uncheck();
  await number(panel, 'Destination X', 40); await number(panel, 'Destination Y', 120); await number(panel, 'Destination zoom (%)', 125);
  await select(panel, 'Chapter group'); await panel.getByRole('checkbox', { name: 'Initially expanded', exact: true }).check();
  await panel.getByRole('button', { name: 'Add bookmark', exact: true }).click(); await panel.getByRole('textbox', { name: 'Title', exact: true }).fill('附录 Notes');
  await panel.getByRole('combobox', { name: 'Destination page', exact: true }).selectOption('2'); await panel.getByRole('button', { name: 'Indent', exact: true }).click(); await ready(panel);
  await page.screenshot({ path: test.info().outputPath('bookmarks-desktop.png') });
  await panel.getByRole('button', { name: 'Apply bookmarks', exact: true }).click(); await expect(panel).toHaveCount(0);
  const bytes = await exportFile(page), tree = await nativeBookmarks(bytes);
  expect(tree.map(item => item.title)).toEqual(['开始 Introduction', 'Chapter group']); expect(tree[0]).toMatchObject({ page: 2, view: '/XYZ' });
  expect(tree[1].children.map(item => item.title)).toEqual(['第三页', '附录 Notes']); expect(tree[1].count).toBe(2); expect(tree[1].children[1].page).toBe(2);
  expect((await PDFDocument.load(bytes)).getForm().getTextField('Contact').getText()).toBe('Bookmarks 中文 form');
  await page.getByRole('tab', { name: 'Bookmarks', exact: true }).click();
  await page.locator('.outline-action').filter({ hasText: '开始 Introduction' }).click(); await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('2'); await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveValue('1.25');
  await page.locator('.outline-action').filter({ hasText: '第三页' }).click(); await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: /Undo Edit bookmarks/ }).click(); expect((await nativeBookmarks(await exportFile(page)))[0].title).toBe('Introduction');
  await page.getByRole('button', { name: /Redo Edit bookmarks/ }).click(); expect(await nativeBookmarks(await exportFile(page))).toEqual(tree);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/); await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible(); expect(await nativeBookmarks(await exportFile(page))).toEqual(tree);
});
test('validates addresses, cancels on narrow screens, and can delete the complete bookmark tree atomically', async ({ page }) => {
  test.setTimeout(90_000); await open(page); const original = await nativeBookmarks(await exportFile(page)); let panel = await manage(page);
  await panel.getByRole('button', { name: 'Add bookmark', exact: true }).click(); await panel.getByRole('combobox', { name: 'Destination type', exact: true }).selectOption('url'); await panel.getByRole('textbox', { name: 'URL', exact: true }).fill('javascript:alert(1)');
  await expect(panel.getByRole('alert')).toContainText(/http|mailto|URL/); await expect(panel.getByRole('button', { name: 'Apply bookmarks', exact: true })).toBeDisabled();
  await panel.getByRole('textbox', { name: 'URL', exact: true }).fill('mailto:review@example.com'); await ready(panel); await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true); await expect(panel.getByRole('button', { name: 'Apply bookmarks', exact: true })).toBeInViewport(); await page.screenshot({ path: test.info().outputPath('bookmarks-narrow.png') });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await nativeBookmarks(await exportFile(page))).toEqual(original);
  await page.setViewportSize({ width: 1280, height: 900 }); panel = await manage(page);
  for (const title of ['Chapter group', 'Introduction']) { await select(panel, title); await panel.getByRole('button', { name: 'Delete bookmark', exact: true }).click(); await panel.getByRole('button', { name: 'Confirm delete', exact: true }).click(); }
  await ready(panel); await panel.getByRole('button', { name: 'Apply bookmarks', exact: true }).click(); await expect(panel).toHaveCount(0); expect(await nativeBookmarks(await exportFile(page))).toEqual([]);
  await page.getByRole('button', { name: /Undo Edit bookmarks/ }).click(); expect(await nativeBookmarks(await exportFile(page))).toEqual(original);
});
