import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import * as mupdf from 'mupdf';

async function open(page: Page, bytes: Buffer, name: string) {
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('2');
  await expect(page.locator('.page-loading-overlay')).toHaveCount(0);
}

/** The browser paints the PDF with PDF.js, independently from the MuPDF exporter. */
async function originalPrefixPixels(page: Page, rect = [132, 124, 182, 139]) {
  return page.locator('canvas.page-canvas').evaluate((node, bounds) => {
    const canvas = node as HTMLCanvasElement, context = canvas.getContext('2d')!;
    // This ink is inside the paragraph being rewritten, not untouched page content.
    const scaleX = canvas.width / 595.276, scaleY = canvas.height / 841.89;
    const x = Math.floor(bounds[0] * scaleX), y = Math.floor(bounds[1] * scaleY);
    return Array.from(context.getImageData(x, y, Math.floor(bounds[2] * scaleX) - x, Math.floor(bounds[3] * scaleY) - y).data);
  }, rect);
}

function sameOutlines(source: number[], saved: number[]) {
  expect(saved).toHaveLength(source.length);
  let ink = 0, difference = 0;
  for (let index = 0; index < source.length; index++) {
    if (index % 4 === 3) continue;
    ink += 255 - source[index]; difference += Math.abs(source[index] - saved[index]);
  }
  expect(ink).toBeGreaterThan(10_000);
  // Allow tiny raster-rounding differences, never a correct text map over wrong glyphs.
  expect(difference / ink).toBeLessThan(.01);
}

function extractedText(bytes: Buffer) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(0), text = page.toStructuredText('');
  try { return text.asText().replace(/\s+/gu, ' ').trim(); }
  finally { text.destroy(); page.destroy(); document.destroy(); }
}

async function append(page: Page, suffix: string, action: 'Save' | 'Export') {
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: 'Plain Type one row' }).click({ position: { x: 20, y: 5 } });
  const input = page.locator('.pdf-text-input');
  await expect(input).toBeVisible();
  const text = `${await input.inputValue()}${suffix}`;
  await input.fill(text);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  const result = await readFile((await (await pending).path())!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(extractedText(result)).toContain(text.replace(/\s+/gu, ' ').trim());
  return result;
}

test('Type 1 glyphs remain visually correct in PDF.js after Save, reopen, edit and Export', async ({ page }, testInfo) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await open(page, await readFile('tests/fixtures/type1-font.pdf'), 'type1-source.pdf');
  const original = await originalPrefixPixels(page);
  const saved = await append(page, ' Zed 中文', 'Save');
  await testInfo.attach('saved.pdf', { body: saved, contentType: 'application/pdf' });
  await open(page, saved, 'type1-saved.pdf');
  sameOutlines(original, await originalPrefixPixels(page));
  await testInfo.attach('saved-pdfjs.png', { body: await page.locator('canvas.page-canvas').screenshot(), contentType: 'image/png' });

  const exported = await append(page, ' two', 'Export');
  await testInfo.attach('exported.pdf', { body: exported, contentType: 'application/pdf' });
  await open(page, exported, 'type1-exported.pdf');
  sameOutlines(original, await originalPrefixPixels(page));
  expect(extractedText(exported)).toContain('Zed 中文 two');
  await testInfo.attach('exported-pdfjs.png', { body: await page.locator('canvas.page-canvas').screenshot(), contentType: 'image/png' });
});

async function aliases() {
  const document = new mupdf.PDFDocument(await readFile('tests/fixtures/type1-font.pdf'));
  const page = document.findPage(0), resources = page.getInheritable('Resources'), font = resources.get('Font', 'F28');
  const widths = font.get('Widths'), expanded = document.newArray();
  const cmap = document.addStream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Aliases def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 2 beginbfchar <61> <0061> <41> <0391> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end', {});
  const contents = document.addStream('BT /F28 12 Tf 40 700 Td <6141> Tj ET BT /F28 12 Tf 40 640 Td <6141> Tj ET', {});
  try {
    for (let code = 65; code < 80; code++) expanded.push(code === 65 ? 500 : 0);
    widths.forEach(value => { try { expanded.push(value); } finally { value.destroy(); } });
    font.put('FirstChar', 65); font.put('Widths', expanded);
    font.put('Encoding', { Type: 'Encoding', Differences: [65, 'a'] }); font.put('ToUnicode', cmap); page.put('Contents', contents);
    const saved = document.saveToBuffer('');
    try { return Buffer.from(saved.asUint8Array()); } finally { saved.destroy(); }
  } finally { contents.destroy(); cmap.destroy(); expanded.destroy(); widths.destroy(); font.destroy(); resources.destroy(); page.destroy(); document.destroy(); }
}

test('PDF.js preserves distinct character meanings for aliased native glyphs after repeated saves', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await open(page, await aliases(), 'aliases-source.pdf');
  const rect = [39, 132, 52, 145], original = await originalPrefixPixels(page, rect);
  await expect(page.locator('.textLayer')).toHaveText('aΑaΑ');
  for (const [action, replacement] of [['Save', 'aΑa'], ['Export', 'aΑaΑ']] as const) {
    await page.getByRole('button', { name: 'All tools' }).click();
    await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
    await page.locator('.text-block').filter({ hasText: 'aΑ' }).first().click({ position: { x: 5, y: 5 } });
    await page.locator('.pdf-text-input').fill(replacement);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: action, exact: true }).click();
    const result = await readFile((await (await pending).path())!);
    expect(extractedText(result)).toBe(`${replacement} aΑ`);
    await open(page, result, `aliases-${action}.pdf`);
    await expect(page.locator('.textLayer')).toHaveText(`${replacement}aΑ`);
    sameOutlines(original, await originalPrefixPixels(page, rect));
  }
});
