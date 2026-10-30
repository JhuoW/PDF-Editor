import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import { unzipSync } from 'fflate';
import * as mupdf from 'mupdf';
import { createScannedPDF } from '../fixtures/ocrPDF';
import { createCleanupPDF, CLEANUP_SECRETS, decodedPDFStrings } from '../fixtures/cleanupPDF';
import { createOptimizationPDF } from '../fixtures/optimizationPDF';
import { createTextLayoutPDF, LAYOUT_ORIGINAL, LAYOUT_NEIGHBOR } from '../fixtures/textLayoutPDF';
import { createLinksPDF } from '../fixtures/linksPDF';

test('edits and follows native PDF links through local production workers while preserving current forms', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'production-links.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createLinksPDF()) });
  const pageNumber = page.getByRole('spinbutton', { name: 'Page number', exact: true });
  await pageNumber.fill('2'); await pageNumber.press('Enter'); await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('链接保留中文');
  await pageNumber.fill('1'); await pageNumber.press('Enter');
  await page.getByRole('button', { name: 'All tools', exact: true }).click(); await page.getByRole('button', { name: 'Links…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Links', exact: true });
  await expect(panel.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  const options = panel.getByRole('combobox', { name: 'Links', exact: true });
  await options.selectOption((await options.locator('option').filter({ hasText: /Page 3.*XYZ/ }).getAttribute('value'))!);
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill('Production jump');
  await panel.getByRole('combobox', { name: 'Destination page', exact: true }).selectOption('2');
  await expect(panel.getByRole('status').filter({ hasText: /^Preview ready/ })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.pdf-links-preview')).toHaveAttribute('aria-busy', 'false');
  await panel.getByRole('button', { name: 'Apply links', exact: true }).click(); await expect(panel).toHaveCount(0);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  const pdf = await PDFDocument.load(bytes); expect(pdf.getForm().getTextField('Contact').getText()).toBe('链接保留中文');
  const native = new mupdf.PDFDocument(bytes), first = native.loadPage(0), nativeLinks = first.getLinks();
  try { expect(nativeLinks.some(link => { const uri = link.getURI(); return uri.startsWith('#') && native.resolveLink(uri) === 1; })).toBe(true); }
  finally { nativeLinks.forEach(link => link.destroy()); first.destroy(); native.destroy(); }
  await page.getByRole('link', { name: 'Production jump', exact: true }).click(); await expect(pageNumber).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Contact', exact: true })).toHaveValue('链接保留中文');
  expect(requests.some(url => /PDFLinks\.worker.*\.(?:ts|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin); expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('previews and saves longer original text with local layout workers under the deployment base', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'production-layout.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createTextLayoutPDF()) });
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('布局后保留中文');
  await page.getByRole('button', { name: 'All tools' }).click(); await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').filter({ hasText: LAYOUT_ORIGINAL }).dblclick();
  await page.getByRole('button', { name: 'Text layout…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Text layout', exact: true });
  await panel.getByRole('textbox', { name: 'Text', exact: true }).fill('Production 中文 reflow with a longer paragraph');
  await panel.getByRole('spinbutton', { name: 'Width', exact: true }).fill('280');
  await panel.getByRole('spinbutton', { name: 'Height', exact: true }).fill('70');
  await panel.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('18');
  await panel.getByRole('spinbutton', { name: 'Font size', exact: true }).press('Tab');
  await expect(panel.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.text-layout-preview')).toHaveAttribute('aria-busy', 'false');
  await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  expect((await PDFDocument.load(bytes)).getForm().getTextField('Contact').getText()).toBe('布局后保留中文');
  const document = new mupdf.PDFDocument(bytes), pdfPage = document.loadPage(0), content = pdfPage.toStructuredText('');
  try {
    const text = content.asText(); expect(text.replace(/\s/g, '')).toContain('Production中文reflowwithalongerparagraph');
    expect(text).toContain(LAYOUT_NEIGHBOR); expect(text).not.toContain(LAYOUT_ORIGINAL);
  } finally { content.destroy(); pdfPage.destroy(); document.destroy(); }
  expect(requests.some(url => /TextLayout\.worker.*\.(?:ts|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('compresses native images in the production worker while retaining Chinese forms and document structures', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  const source = await createOptimizationPDF();
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'production-compression.pdf', mimeType: 'application/pdf', buffer: Buffer.from(source) });
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('压缩后保留中文');
  const baselineReady = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const baseline = await readFile((await (await baselineReady).path())!);
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Compress PDF…', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Compress PDF', exact: true });
  await expect(panel.getByRole('button', { name: 'Compress PDF', exact: true })).toBeEnabled({ timeout: 30_000 });
  await panel.getByRole('radio', { name: 'Optimize images', exact: true }).check();
  await panel.getByRole('button', { name: 'Compress PDF', exact: true }).click();
  await expect(panel.getByText('Compression ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  const pending = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!); expect(bytes.length).toBeLessThan(baseline.length);
  const output = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(output.getPageCount()).toBe(2); expect(output.getForm().getTextField('Contact').getText()).toBe('压缩后保留中文');
  const strings = await decodedPDFStrings(bytes);
  for (const retained of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.comment, 'Second page bookmark', 'https://example.com/review']) expect(strings).toContain(retained);
  const document = new mupdf.PDFDocument(bytes), pdfPage = document.loadPage(0), text = pdfPage.toStructuredText('');
  try { expect(text.asText()).toContain('Original body text'); } finally { text.destroy(); pdfPage.destroy(); document.destroy(); }
  expect(requests.some(url => /PDFOptimizer\.worker.*\.(?:ts|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('loads the PDF worker and content editing engine under the deployment base', async ({ page, baseURL }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => failures.push(error.message));
  const source = await PDFDocument.create();
  source.addPage([400, 600]).drawText('Original content for deployment verification', { x: 30, y: 500, size: 12 });
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'deployment.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('.textLayer')).toContainText('Original content for deployment verification');
  expect(requests.some(url => /mupdf.*\.wasm/.test(url))).toBe(false);
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  await page.locator('.text-block').dblclick();
  await page.getByRole('textbox', { name: 'Edit text on page 1' }).fill('Local content edit');
  await page.getByRole('textbox', { name: 'Edit text on page 1' }).press('Control+Enter');
  await page.getByRole('button', { name: 'Apply Content Changes', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('Local content edit');
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadReady;
  expect(await download.failure()).toBeNull();
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Document Properties & Attachments…', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save properties', exact: true })).toBeVisible();
  const origin = new URL(baseURL!);
  const assets = requests.filter(url => /pdf\.worker.*\.mjs|mupdf.*\.wasm|DocumentPropertiesDialog.*\.(?:js|css)(?:\?|$)/.test(url));
  expect(assets.some(url => /pdf\.worker/.test(url))).toBe(true);
  expect(assets.some(url => /mupdf.*\.wasm/.test(url))).toBe(true);
  for (const asset of assets) {
    expect(new URL(asset).origin).toBe(origin.origin);
    expect(new URL(asset).pathname.startsWith(origin.pathname)).toBe(true);
  }
  expect(failures).toEqual([]);
});

test('resolves predefined Chinese CMaps from local assets', async ({ page, baseURL }) => {
  const source = await PDFDocument.create();
  const pdfPage = source.addPage([400, 600]);
  const context = source.context;
  const descriptor = context.register(context.obj({
    Type: 'FontDescriptor', FontName: 'STSong-Light', Flags: 6,
    FontBBox: [-25, -254, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 80,
  }));
  const descendant = context.register(context.obj({
    Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light',
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 },
    FontDescriptor: descriptor, DW: 1000,
  }));
  const font = context.register(context.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light', Encoding: 'UniGB-UCS2-H', DescendantFonts: [descendant],
  }));
  pdfPage.node.set(PDFName.of('Resources'), context.obj({ Font: { F1: font } }));
  pdfPage.node.set(PDFName.of('Contents'), context.register(context.flateStream('BT /F1 20 Tf 30 500 Td <4E2D6587> Tj ET')));
  const responses: string[] = [];
  page.on('response', response => { if (response.status() === 200) responses.push(response.url()); });
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'chinese-cmap.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await expect(page.locator('.textLayer')).toContainText('中文');
  const maps = responses.filter(url => url.endsWith('.bcmap'));
  expect(maps.length).toBeGreaterThan(0);
  for (const map of maps) {
    expect(new URL(map).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(map).pathname).toContain(`${new URL(baseURL!).pathname}pdfjs/cmaps/`);
  }
});

test('recognizes a real Chinese and English scan using only local production assets', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => failures.push(error.message));
  const source = await createScannedPDF(true);
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'local-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(source),
  });
  await expect(page.locator('.page-wrapper').first()).toBeVisible();
  expect(requests.some(url => url.includes('/ocr/'))).toBe(false);
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Scan OCR…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan OCR', exact: true });
  await dialog.getByLabel('Recognition language').selectOption('chi_sim+eng');
  await dialog.getByRole('button', { name: 'Start OCR', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Searchable text added to 1 page', { timeout: 60000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.textLayer')).toContainText('739251');
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await ready;
  const bytes = await readFile((await download.path())!);
  const before = new mupdf.PDFDocument(source);
  const after = new mupdf.PDFDocument(bytes);
  const beforePage = before.loadPage(0), afterPage = after.loadPage(0);
  const originalPixels = beforePage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  const resultPixels = afterPage.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  const text = afterPage.toStructuredText();
  try {
    expect(text.asText()).toContain('739251');
    expect(text.asText().replace(/\s/g, '')).toContain('中文识别测试');
    expect(Buffer.from(resultPixels.getPixels()).equals(Buffer.from(originalPixels.getPixels()))).toBe(true);
  } finally {
    text.destroy(); originalPixels.destroy(); resultPixels.destroy(); beforePage.destroy(); afterPage.destroy(); before.destroy(); after.destroy();
  }
  const assets = requests.filter(url => url.includes('/ocr/'));
  expect(assets.some(url => url.endsWith('/ocr/worker.min.js'))).toBe(true);
  expect(assets.some(url => url.includes('/ocr/core/'))).toBe(true);
  expect(assets.some(url => url.endsWith('/ocr/lang/eng.traineddata.gz'))).toBe(true);
  expect(assets.some(url => url.endsWith('/ocr/lang/chi_sim.traineddata.gz'))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(failures).toEqual([]);
});

test('cancels OCR while the local engine is still loading without changing history', async ({ page, baseURL }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/ocr/core/**', async route => {
    await held;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto(baseURL!);
    await page.locator('.main-toolbar input[type="file"]').setInputFiles({
      name: 'cancel-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createScannedPDF()),
    });
    await page.getByRole('button', { name: 'All tools', exact: true }).click();
    await page.getByRole('button', { name: 'Scan OCR…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Scan OCR', exact: true });
    const loadingEngine = page.waitForRequest('**/ocr/core/**');
    await dialog.getByRole('button', { name: 'Start OCR', exact: true }).click();
    await loadingEngine;
    await dialog.getByRole('button', { name: 'Cancel OCR', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('OCR canceled. The document was not changed.');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('.error-state')).toHaveCount(0);
    await expect(page.locator('.textLayer')).not.toContainText('739251');
  } finally { release(); }
});

test('exports a real JPEG ZIP from the module worker under the deployment base', async ({ page, baseURL }) => {
  const requests: string[] = [];
  const failures: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => failures.push(error.message));
  const document = await PDFDocument.create();
  document.addPage([144, 72]).drawRectangle({ x: 0, y: 0, width: 144, height: 72, color: rgb(1, 0, 0) });
  document.addPage([144, 72]).drawRectangle({ x: 0, y: 0, width: 144, height: 72, color: rgb(0, 0, 1) });
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'production.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()),
  });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Export Pages…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Pages', exact: true });
  await dialog.getByLabel('Export format', { exact: true }).selectOption('jpeg');
  await dialog.getByLabel('Page range', { exact: true }).fill('2, 1');
  await dialog.getByLabel('Resolution', { exact: true }).selectOption('150');
  const ready = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export pages', exact: true }).click();
  const download = await ready;
  expect(download.suggestedFilename()).toBe('production-pages.zip');
  const files = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(files)).toEqual(['production-page-2.jpg', 'production-page-1.jpg']);
  for (const number of [2, 1]) {
    const image = new mupdf.Image(files[`production-page-${number}.jpg`]);
    const pixels = image.toPixmap();
    try {
      expect([pixels.getWidth(), pixels.getHeight()]).toEqual([300, 150]);
      const values = pixels.getPixels();
      expect(values[number === 1 ? 0 : 2]).toBeGreaterThan(240);
      expect(values[1]).toBeLessThan(10);
    } finally { pixels.destroy(); image.destroy(); }
  }
  expect(requests.some(url => /PageExport\.worker.*\.(?:ts|js)(?:\?|$)/.test(url))).toBe(true);
  expect(requests.some(url => /mupdf.*\.wasm/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(failures).toEqual([]);
});

test('creates a fillable Chinese dropdown using the deployed form designer', async ({ page, baseURL }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  const source = await PDFDocument.create(); source.addPage([400, 600]);
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'design.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Design Form…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design Form', exact: true });
  await dialog.getByRole('button', { name: 'Dropdown', exact: true }).click();
  await dialog.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await dialog.getByLabel('Field name', { exact: true }).fill('City');
  await dialog.getByLabel('Label 1', { exact: true }).fill('北京');
  await dialog.getByLabel('Value 1', { exact: true }).fill('BJ');
  await dialog.getByLabel('Label 2', { exact: true }).fill('上海');
  await dialog.getByLabel('Value 2', { exact: true }).fill('SH');
  await dialog.getByRole('combobox', { name: 'Current value', exact: true }).selectOption('SH');
  await dialog.getByRole('button', { name: 'Save form design', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('combobox', { name: 'City', exact: true })).toHaveValue('SH');
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await ready).path())!);
  const field = (await PDFDocument.load(bytes)).getForm().getDropdown('City');
  expect(field.getSelected()).toEqual(['SH']); expect(field.isReadOnly()).toBe(false);
  expect(field.acroField.getOptions().map(option => [option.value.decodeText(), option.display?.decodeText()])).toEqual([['BJ', '北京'], ['SH', '上海']]);
  const result = new mupdf.PDFDocument(bytes), pdfPage = result.loadPage(0);
  const widget = pdfPage.getWidgets()[0], appearance = widget.toDisplayList(), text = appearance.toStructuredText('');
  try { expect(text.asText().trim()).toBe('上海'); }
  finally { text.destroy(); appearance.destroy(); widget.destroy(); pdfPage.destroy(); result.destroy(); }
  expect(requests.some(url => /FormDesignerDialog.*\.(?:tsx|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('previews and exports Chinese watermarks using local decoration assets under the deployment base', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  const source = await PDFDocument.create(); source.addPage([400, 600]).drawText('Preserved original', { x: 30, y: 540, size: 12 });
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({
    name: 'watermarks.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()),
  });
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Watermarks, Headers & Backgrounds…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Watermarks, Headers & Backgrounds', exact: true });
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Watermark text', exact: true }).fill('DEPLOY 中文');
  await expect(dialog.getByText('Preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.decoration-pdf-preview')).toHaveAttribute('aria-busy', 'false');
  await dialog.getByRole('button', { name: 'Apply decorations', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const bytes = await readFile((await (await ready).path())!);
  const result = new mupdf.PDFDocument(bytes), pdfPage = result.loadPage(0), text = pdfPage.toStructuredText('');
  try { expect(text.asText()).toContain('Preserved original'); expect(text.asText().replace(/\s/g, '')).toContain('DEPLOY中文'); }
  finally { text.destroy(); pdfPage.destroy(); result.destroy(); }
  expect(requests.some(url => /PageDecorationsDialog.*\.(?:tsx|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('cleans native data and downloads an independent visible copy through local production workers', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL!);
  await page.locator('.main-toolbar input[type="file"]').setInputFiles({ name: 'cleanup-production.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await createCleanupPDF()) });
  await page.getByRole('textbox', { name: 'Contact', exact: true }).fill('中文可见值');
  const open = async () => {
    await page.getByRole('button', { name: 'All tools', exact: true }).click();
    await page.getByRole('button', { name: 'Clean Document…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Clean Document', exact: true });
  };
  let dialog = await open();
  await expect(dialog.getByText('Cleanup preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Apply cleanup', exact: true }).click(); await expect(dialog).toHaveCount(0);
  let ready = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export', exact: true }).click();
  const cleaned = await readFile((await (await ready).path())!), strings = await decodedPDFStrings(cleaned);
  for (const secret of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.metadata, CLEANUP_SECRETS.script, CLEANUP_SECRETS.attachment]) expect(strings).not.toContain(secret);
  expect((await PDFDocument.load(cleaned, { updateMetadata: false })).context.trailerInfo.Info).toBeUndefined();
  dialog = await open(); await dialog.getByRole('tab', { name: 'Save visible copy', exact: true }).click();
  await expect(dialog.getByText('Visible copy preview ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  ready = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download image-only PDF', exact: true }).click();
  const bytes = await readFile((await (await ready).path())!), output = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(output.getPageCount()).toBe(2); expect(output.catalog.has(PDFName.of('AcroForm'))).toBe(false);
  const copied = new mupdf.PDFDocument(bytes), pdfPage = copied.loadPage(0), text = pdfPage.toStructuredText('');
  try { expect(text.asText().trim()).toBe(''); } finally { text.destroy(); pdfPage.destroy(); copied.destroy(); }
  const copyStrings = await decodedPDFStrings(bytes);
  for (const secret of [...Object.values(CLEANUP_SECRETS), '中文可见值']) expect(copyStrings).not.toContain(secret);
  expect(requests.some(url => /VisibleCopy\.worker.*\.(?:ts|js)(?:\?|$)/.test(url))).toBe(true);
  for (const url of requests.filter(url => /^https?:/.test(url))) {
    expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(url).pathname.startsWith(new URL(baseURL!).pathname)).toBe(true);
  }
  expect(errors).toEqual([]);
});
