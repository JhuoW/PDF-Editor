import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createLinksPDF } from '../fixtures/linksPDF';

async function open(page: Page) {
  await page.goto('/'); await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'links.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createLinksPDF()) });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
}
async function go(page: Page, number: number) {
  const input = page.getByRole('spinbutton', { name: 'Page number', exact: true }); await input.fill(String(number)); await input.press('Enter');
  await expect(page.locator(`.page-wrapper[data-page="${number}"] canvas.page-canvas`)).toBeVisible();
}
async function links(page: Page) {
  await page.getByRole('button', { name: 'All tools', exact: true }).click(); await page.getByRole('button', { name: 'Links…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Links', exact: true }); await ready(panel); return panel;
}
async function ready(panel: Locator) {
  await expect(panel.getByRole('status').filter({ hasText: /^Preview ready/ })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.pdf-links-preview')).toHaveAttribute('aria-busy', 'false');
}
async function select(panel: Locator, name: RegExp) {
  const option = panel.getByRole('combobox', { name: 'Links', exact: true }).locator('option').filter({ hasText: name }).first();
  await panel.getByRole('combobox', { name: 'Links', exact: true }).selectOption((await option.getAttribute('value'))!);
}
async function number(panel: Locator, name: string, value: number) {
  const input = panel.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab');
}
async function exported(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click(); return readFile((await (await pending).path())!);
}
async function nativeLinks(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes), pages = pdf.getPages();
  const text = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
  return pages.flatMap((page, index) => (page.node.Annots()?.asArray() ?? []).flatMap(ref => {
    const dictionary = pdf.context.lookup(ref); if (!(dictionary instanceof PDFDict) || dictionary.lookup(PDFName.of('Subtype')) !== PDFName.of('Link')) return [];
    const action = dictionary.lookup(PDFName.of('A')), dest = dictionary.lookup(PDFName.of('Dest'));
    const first = dest instanceof PDFArray ? dest.get(0) : undefined;
    return [{ page: index + 1, description: text(dictionary.lookup(PDFName.of('Contents'))), uri: action instanceof PDFDict ? text(action.lookup(PDFName.of('URI'))) : undefined,
      target: first instanceof PDFRef ? pages.findIndex(item => item.ref.toString() === first.toString()) + 1 : undefined,
      destination: dest instanceof PDFArray ? dest.toString() : text(dest),
      action: action instanceof PDFDict ? action.lookup(PDFName.of('S'))?.toString() : undefined }];
  }));
}
function pageText(bytes: Uint8Array, index = 0) {
  const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(index), text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); }); });

test('edits native links with current body/forms, follows the saved page target, and restores changes across undo and refresh', async ({ page }) => {
  test.setTimeout(120_000); await open(page);
  await go(page, 2); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('Links 中文 form'); await go(page, 1);
  await page.getByRole('button', { name: 'All tools' }).click(); await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Original link body' }).dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).fill('Edited body'); await page.getByRole('textbox', { name: 'Edit text on page 1', exact: true }).press('Control+Enter');
  await page.getByTitle('Select (V)', { exact: true }).click();
  const panel = await links(page); await select(panel, /example.com\/original/);
  await panel.getByRole('textbox', { name: 'URL', exact: true }).fill('https://example.org/updated');
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill('Updated website');
  await number(panel, 'Border width', 2); await panel.getByRole('combobox', { name: 'Border style', exact: true }).selectOption('underline');
  await panel.getByRole('button', { name: 'Add link', exact: true }).click(); await panel.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill('Jump to third');
  await panel.getByRole('combobox', { name: 'Link type', exact: true }).selectOption('page');
  await panel.getByRole('combobox', { name: 'Destination page', exact: true }).selectOption('3');
  await panel.getByRole('combobox', { name: 'Destination view', exact: true }).selectOption('XYZ');
  for (const axis of ['X', 'Y']) await panel.getByRole('checkbox', { name: `Keep current ${axis}`, exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'Keep current zoom', exact: true }).uncheck();
  for (const [label, value] of [['Destination X', 40], ['Destination Y', 120], ['Destination zoom (%)', 150], ['X', 230], ['Y', 180], ['Width', 130], ['Height', 24]] as const) await number(panel, label, value);
  await select(panel, /JavaScript/); await expect(panel.getByRole('status').filter({ hasText: /cannot|unsupported|action/i }).first()).toBeVisible();
  await panel.getByRole('button', { name: 'Delete link', exact: true }).click(); await ready(panel);
  await panel.getByRole('checkbox', { name: 'Show link areas', exact: true }).uncheck();
  await expect(panel.locator('.native-link-border-layer line')).toHaveCount(1);
  await expect(panel.locator('.native-link-border-layer line')).toHaveAttribute('stroke-width', '2');
  await page.screenshot({ path: test.info().outputPath('links-desktop.png') });
  await panel.getByRole('button', { name: 'Apply links', exact: true }).click(); await expect(panel).toHaveCount(0);
  await expect(page.locator('.page-wrapper[data-page="1"] .native-link-border-layer line')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Undo Edit links/ })).toBeEnabled();
  const saved = await exported(page), result = await nativeLinks(saved);
  expect(result).toHaveLength(4); expect(result.find(item => item.description === 'Updated website')?.uri).toBe('https://example.org/updated');
  expect(result.find(item => item.description === 'Jump to third')?.target).toBe(3); expect(result.some(item => item.action === '/JavaScript')).toBe(false);
  expect(pageText(saved)).toContain('Edited body'); expect((await PDFDocument.load(saved)).getForm().getTextField('Contact').getText()).toBe('Links 中文 form');
  await page.getByRole('link', { name: 'Jump to third', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Page number', exact: true })).toHaveValue('3');
  await expect(page.getByRole('combobox', { name: 'Zoom', exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: /^Undo/ }).click();
  const original = await nativeLinks(await exported(page)); expect(original.some(item => item.uri === 'https://example.com/original')).toBe(true); expect(original.some(item => item.description === 'Jump to third')).toBe(false);
  await page.getByRole('button', { name: /^Redo/ }).click(); expect(await nativeLinks(await exported(page))).toEqual(result);
  await expect(page.locator('.session-save-status')).toHaveClass(/status-saved/); await page.reload(); await expect(page.locator('canvas.page-canvas')).toBeVisible();
  expect(await nativeLinks(await exported(page))).toEqual(result);
});

test('draws, moves and resizes link areas on narrow screens, rejects unsafe URLs, and cancels without modifying the PDF', async ({ page }) => {
  test.setTimeout(90_000); await open(page); const before = await nativeLinks(await exported(page)); const panel = await links(page);
  await panel.getByRole('button', { name: 'Add link', exact: true }).click();
  const overlay = await panel.getByRole('region', { name: 'Link areas', exact: true }).boundingBox();
  await page.mouse.move(overlay!.x + overlay!.width * .5, overlay!.y + overlay!.height * .2); await page.mouse.down();
  await page.mouse.move(overlay!.x + overlay!.width * .8, overlay!.y + overlay!.height * .25, { steps: 4 }); await page.mouse.up();
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill('Temporary email');
  await panel.getByRole('textbox', { name: 'URL', exact: true }).fill('javascript:alert(1)');
  await expect(panel.getByRole('alert')).toContainText(/https|http|mailto|URL/); await expect(panel.getByRole('button', { name: 'Apply links', exact: true })).toBeDisabled();
  await panel.getByRole('textbox', { name: 'URL', exact: true }).fill('mailto:review@example.com'); await ready(panel);
  const x = Number(await panel.getByRole('spinbutton', { name: 'X', exact: true }).inputValue());
  const area = await panel.getByRole('button', { name: 'Select link Temporary email', exact: true }).boundingBox();
  await page.mouse.move(area!.x + 20, area!.y + 10); await page.mouse.down(); await page.mouse.move(area!.x + 45, area!.y + 35, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await panel.getByRole('spinbutton', { name: 'X', exact: true }).inputValue())).toBeGreaterThan(x); await ready(panel);
  const width = Number(await panel.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue()), corner = await panel.getByRole('button', { name: 'Resize link area', exact: true }).boundingBox();
  await page.mouse.move(corner!.x + 6, corner!.y + 6); await page.mouse.down(); await page.mouse.move(corner!.x + 26, corner!.y + 26, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await panel.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue())).toBeGreaterThan(width); await ready(panel);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(panel.getByRole('button', { name: 'Apply links', exact: true })).toBeInViewport(); await page.screenshot({ path: test.info().outputPath('links-narrow.png') });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(await nativeLinks(await exported(page))).toEqual(before);
  await expect(page.getByRole('button', { name: /Undo Edit links/ })).toHaveCount(0);
});
