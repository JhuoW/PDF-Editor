import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page } from '@playwright/test';
import * as mupdf from 'mupdf';

// Attention Is All You Need, NeurIPS 2017; arXiv v7, 2 August 2023.
// https://arxiv.org/abs/1706.03762v7
// https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html
// Download https://arxiv.org/pdf/1706.03762 separately. Never commit this paper.
const paperPath = process.env.PDF_EDITOR_ARXIV_PATH;
if (!paperPath) throw new Error('Set PDF_EDITOR_ARXIV_PATH to the downloaded Attention Is All You Need paper.');
const source = await readFile(paperPath);
if (createHash('sha256').update(source).digest('hex') !== 'bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697') {
  throw new Error('The arXiv PDF differs from the reviewed v7 fixture. Verify the source and SHA-256.');
}

type Rect = { x: number; y: number; width: number; height: number };
type Word = Rect & { text: string; font: string; size: number };
type Raster = { pixels: Uint8Array; width: number; height: number; stride: number; components: number };
const scale = 2;
const execute = promisify(execFile);
const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const sourcePageIdentities = new Map<number, ReturnType<typeof pageIdentity>>();

function pageIdentity(bytes: Uint8Array, index: number) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(index);
  const structured = page.toStructuredText('');
  const raster = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    return { text: structured.asText(), pixels: createHash('sha256').update(raster.getPixels()).digest('hex') };
  } finally { raster.destroy(); structured.destroy(); page.destroy(); document.destroy(); }
}

function inspect(bytes: Uint8Array, pageNumber: number) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(pageNumber - 1);
  const structured = page.toStructuredText('');
  const words: Word[] = [];
  let current: Word | undefined;
  const flush = () => { if (current) words.push(current); current = undefined; };
  try {
    structured.walk({
      onChar(character, _origin, font, size, quad) {
        try {
          if (/\s/.test(character)) { flush(); return; }
          const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
          const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
          const right = Math.max(quad[0], quad[2], quad[4], quad[6]);
          const bottom = Math.max(quad[1], quad[3], quad[5], quad[7]);
          if (current && (current.font !== font.getName() || Math.abs(current.size - size) > .05)) flush();
          if (current) {
            current.text += character;
            current.width = Math.max(current.x + current.width, right) - current.x;
            current.height = Math.max(current.y + current.height, bottom) - current.y;
          } else current = { text: character, font: font.getName(), size, x, y, width: right - x, height: bottom - y };
        } finally { font.destroy(); }
      },
      endLine: flush,
    });
    flush();
    return { text: structured.asText(), words, pageCount: document.countPages() };
  } finally { structured.destroy(); page.destroy(); document.destroy(); }
}

function pixels(pixmap: mupdf.Pixmap): Raster {
  return { pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth(), height: pixmap.getHeight(), stride: pixmap.getStride(), components: pixmap.getNumberOfComponents() };
}

async function render(bytes: Uint8Array, pageNumber: number, artifact: string) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(pageNumber - 1);
  const pixmap = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    await writeFile(test.info().outputPath(`${artifact}-mupdf.png`), pixmap.asPNG());
    return pixels(pixmap);
  } finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}

// Optional third reader, independent even of MuPDF's glyph interpreter. Enable
// with PDF_EDITOR_POPPLER=1 on machines with the pdftoppm command installed.
async function renderPoppler(bytes: Uint8Array, pageNumber: number, artifact: string) {
  const path = test.info().outputPath(`${artifact}-poppler-input.pdf`);
  const prefix = test.info().outputPath(`${artifact}-poppler`);
  await writeFile(path, bytes);
  await execute('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', '-r', String(72 * scale), '-png', path, prefix]);
  const image = new mupdf.Image(await readFile(`${prefix}.png`)), pixmap = image.toPixmap();
  try { return pixels(pixmap); } finally { pixmap.destroy(); image.destroy(); }
}

// Use the application's PDF.js canvas, not its MuPDF inline-edit overlay. Reopening
// the downloaded bytes makes this an independent reader of the actual saved PDF.
async function browserRaster(page: Page, pageNumber: number, artifact: string) {
  const wrapper = page.locator(`.page-wrapper[data-page="${pageNumber}"]`);
  await expect(wrapper.locator('.page-loading-overlay')).toHaveCount(0);
  const canvas = wrapper.locator('canvas.page-canvas');
  await expect(canvas).toBeVisible();
  const encoded = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL('image/png').split(',')[1]);
  const png = Buffer.from(encoded, 'base64');
  await writeFile(test.info().outputPath(`${artifact}-pdfjs.png`), png);
  const image = new mupdf.Image(png), pixmap = image.toPixmap();
  try { return pixels(pixmap); } finally { pixmap.destroy(); image.destroy(); }
}

function inRegion(word: Word, region: Rect) {
  return word.x >= region.x - 1 && word.x + word.width <= region.x + region.width + 1
    && word.y >= region.y - 1 && word.y + word.height <= region.y + region.height + 2;
}

// Compare ink shapes, rather than ToUnicode strings. A bad CID/Type 1 encoding can
// return perfect extracted text while painting garbage. Word patches from the
// original PDF are our visual oracle, including words that moved during reflow.
function inkPatch(raster: Raster, word: Word) {
  const left = Math.max(0, Math.floor(word.x * scale));
  const top = Math.max(0, Math.floor(word.y * scale) - 1);
  const right = Math.min(raster.width, Math.ceil((word.x + word.width) * scale));
  const bottom = Math.min(raster.height, Math.ceil((word.y + word.height) * scale) + 1);
  let x0 = right, y0 = bottom, x1 = left, y1 = top;
  const ink = (x: number, y: number) => 1 - raster.pixels[y * raster.stride + x * raster.components] / 255;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (ink(x, y) > .1) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  const width = Math.max(0, x1 - x0), height = Math.max(0, y1 - y0);
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = ink(x0 + x, y0 + y);
  return { width, height, values };
}

function inkDifference(before: ReturnType<typeof inkPatch>, after: ReturnType<typeof inkPatch>) {
  if (!before.width || !after.width) return 1;
  let best = 1;
  // A fractional baseline/origin changes antialiasing. Small integer translations
  // are allowed; scaling or stretching the glyphs is deliberately not allowed.
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let difference = 0, total = 0;
    for (let y = -2; y < Math.max(before.height, after.height) + 2; y++) {
      for (let x = -2; x < Math.max(before.width, after.width) + 2; x++) {
        const a = x >= 0 && y >= 0 && x < before.width && y < before.height ? before.values[y * before.width + x] : 0;
        const bx = x - dx, by = y - dy;
        const b = bx >= 0 && by >= 0 && bx < after.width && by < after.height ? after.values[by * after.width + bx] : 0;
        difference += Math.abs(a - b); total += a + b;
      }
    }
    best = Math.min(best, difference / Math.max(1, total));
  }
  return best;
}

async function assertGlyphFidelity(before: Raster, after: Raster, originalWords: Word[], outputWords: Word[], region: Rect, label: string) {
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  const candidates = originalWords.filter(word => inRegion(word, region) && /^[A-Za-z]{4,}$/.test(word.text));
  const results = outputWords.filter(word => inRegion(word, region) && /^[A-Za-z]{4,}$/.test(word.text)).flatMap(word => {
    const matching = candidates.filter(original => original.text === word.text && Math.abs(original.size - word.size) < .1);
    if (!matching.length) return [];
    const patch = inkPatch(after, word);
    return [{ text: word.text, score: Math.min(...matching.map(original => inkDifference(inkPatch(before, original), patch))) }];
  });
  const mean = results.reduce((sum, item) => sum + item.score, 0) / results.length;
  const report = test.info().outputPath(`${label}-glyph-fidelity.json`);
  await writeFile(report, JSON.stringify({ words: results.length, mean, results }, null, 2));
  await test.info().attach(`${label}-glyph-fidelity`, { path: report, contentType: 'application/json' });
  expect(results.length, `${label}: check many words inside the rewritten paragraph`).toBeGreaterThan(35);
  expect(mean, `${label}: original letter shapes must survive editing`).toBeLessThan(.24);
  expect(results.filter(item => item.score > .4).length / results.length, `${label}: no widespread garbled words`).toBeLessThan(.1);
}

function unchangedOutside(before: Raster, after: Raster, region: Rect) {
  let changed = 0;
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    if (x >= (region.x - 3) * scale && x <= (region.x + region.width + 3) * scale
      && y >= (region.y - 3) * scale && y <= (region.y + region.height + 3) * scale) continue;
    const offset = y * before.stride + x * before.components;
    if ([0, 1, 2].some(channel => before.pixels[offset + channel] !== after.pixels[offset + channel])) changed++;
  }
  expect(changed, 'Text, figures and margins outside the paragraph must stay pixel-identical').toBe(0);
}

async function openPDF(page: Page, bytes: Buffer, name: string, pageNumber: number) {
  // Exercise the browser download Save path without invoking a native OS dialog.
  await page.addInitScript(() => { Reflect.deleteProperty(window, 'showSaveFilePicker'); });
  await page.goto('./');
  await page.locator('.main-toolbar input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.page-wrapper[data-page="1"] canvas.page-canvas')).toBeVisible();
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1');
  if (pageNumber !== 1) {
    const input = page.getByRole('spinbutton', { name: 'Page number', exact: true });
    await input.fill(String(pageNumber)); await input.press('Enter');
  }
  await expect(page.locator(`.page-wrapper[data-page="${pageNumber}"] canvas.page-canvas`)).toBeVisible();
}

async function editParagraph(page: Page, pageNumber: number, prefix: string, replace: (text: string) => string) {
  await page.getByRole('button', { name: 'All tools' }).click();
  await page.getByRole('button', { name: 'Edit Text', exact: true }).click();
  const block = page.locator('.text-block').filter({ hasText: prefix });
  await expect(block).toHaveCount(1);
  const region = await rectOf(block);
  await block.click({ position: { x: 20, y: 6 } });
  const input = page.getByRole('textbox', { name: `Edit text on page ${pageNumber}`, exact: true });
  const original = await input.inputValue(), replacement = replace(original);
  expect(replacement).not.toBe(original);
  await input.fill(replacement);
  await expect(page.locator('.text-edit-layer')).toHaveAttribute('data-preview-text', replacement);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return { original, replacement, region };
}

async function rectOf(block: Locator): Promise<Rect> {
  return block.evaluate(element => {
    const style = (element as HTMLElement).style;
    return { x: parseFloat(style.left), y: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) };
  });
}

async function download(page: Page, action: 'Save' | 'Export', name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  const file = await pending, path = test.info().outputPath(name);
  await file.saveAs(path);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return readFile(path);
}

async function verifyOutput(page: Page, bytes: Buffer, pageNumber: number, replacement: string, region: Rect,
  original: ReturnType<typeof inspect>, originalNative: Raster, originalBrowser: Raster, label: string) {
  const output = inspect(bytes, pageNumber);
  expect(output.pageCount).toBe(15);
  expect(normalize(output.text)).toContain(normalize(replacement));
  expect(normalize(output.text).split(normalize(replacement))).toHaveLength(2);
  const native = await render(bytes, pageNumber, label);
  await assertGlyphFidelity(originalNative, native, original.words, output.words, region, `${label}-mupdf`);
  await openPDF(page, bytes, `${label}.pdf`, pageNumber);
  const browser = await browserRaster(page, pageNumber, label);
  await assertGlyphFidelity(originalBrowser, browser, original.words, output.words, region, `${label}-pdfjs`);
  if (process.env.PDF_EDITOR_POPPLER === '1') {
    const before = await renderPoppler(source, pageNumber, `${label}-original`);
    const after = await renderPoppler(bytes, pageNumber, label);
    await assertGlyphFidelity(before, after, original.words, output.words, region, `${label}-poppler`);
  }
  for (let index = 1; index <= 15; index++) if (index !== pageNumber) {
    if (!sourcePageIdentities.has(index)) sourcePageIdentities.set(index, pageIdentity(source, index - 1));
    expect(pageIdentity(bytes, index - 1), `Unedited page ${index} text AND rendered pixels`).toEqual(sourcePageIdentities.get(index));
  }
  return { native, browser };
}

test('real arXiv Type 1 text remains readable after separate Save and Export, including reopening', async ({ page }) => {
  await openPDF(page, source, 'attention-original.pdf', 1);
  const originalBrowser = await browserRaster(page, 1, 'original');
  const originalNative = await render(source, 1, 'original'), original = inspect(source, 1);
  const edit = await editParagraph(page, 1, 'The dominant sequence transduction', text => text.replace('dominant', 'powerful'));
  const saved = await download(page, 'Save', 'attention-saved.pdf');
  const exported = await download(page, 'Export', 'attention-exported.pdf');
  const savedResult = await verifyOutput(page, saved, 1, edit.replacement, edit.region, original, originalNative, originalBrowser, 'saved');
  unchangedOutside(originalNative, savedResult.native, edit.region);
  const exportedResult = await verifyOutput(page, exported, 1, edit.replacement, edit.region, original, originalNative, originalBrowser, 'exported');
  expect(Buffer.from(exportedResult.native.pixels)).toEqual(Buffer.from(savedResult.native.pixels));
  expect(Buffer.from(exportedResult.browser.pixels)).toEqual(Buffer.from(savedResult.browser.pixels));
});

test('real body paragraph supports insertion, deletion and editing again after save/reopen without corrupting glyphs', async ({ page }) => {
  await openPDF(page, source, 'attention-original.pdf', 1);
  const originalBrowser = await browserRaster(page, 1, 'original');
  const originalNative = await render(source, 1, 'original'), original = inspect(source, 1);
  const first = await editParagraph(page, 1, 'The dominant sequence transduction', text => text.replace('based solely on', 'based mostly on'));
  const saved = await download(page, 'Save', 'attention-first-save.pdf');
  await verifyOutput(page, saved, 1, first.replacement, first.region, original, originalNative, originalBrowser, 'first-save');
  const second = await editParagraph(page, 1, 'The dominant sequence transduction', text => text.replace('a new simple network', 'a new very simple network'));
  const exported = await download(page, 'Export', 'attention-word-inserted.pdf');
  // A reflow may grow the paragraph by a line, so include its original whitespace.
  const expanded = { ...first.region, height: first.region.height + 28 };
  await verifyOutput(page, exported, 1, second.replacement, expanded, original, originalNative, originalBrowser, 'word-inserted');
  const third = await editParagraph(page, 1, 'The dominant sequence transduction', text => text.replace('a new very simple network', 'a simple network'));
  const final = await download(page, 'Save', 'attention-word-deleted.pdf');
  await verifyOutput(page, final, 1, third.replacement, expanded, original, originalNative, originalBrowser, 'word-deleted');
  expect(normalize(inspect(final, 1).text)).not.toContain('anewverysimplenetwork');
  await page.screenshot({ path: test.info().outputPath('final-reopened-editor.png'), fullPage: true });
});

test('real second-page body text keeps inline formatting and neighboring mathematical text intact', async ({ page }) => {
  await openPDF(page, source, 'attention-original.pdf', 2);
  const originalBrowser = await browserRaster(page, 2, 'original');
  const originalNative = await render(source, 2, 'original'), original = inspect(source, 2);
  const edit = await editParagraph(page, 2, 'The goal of reducing sequential computation', text => text.replace('foundation', 'basis'));
  const exported = await download(page, 'Export', 'attention-page-two-exported.pdf');
  const result = await verifyOutput(page, exported, 2, edit.replacement, edit.region, original, originalNative, originalBrowser, 'page-two-exported');
  unchangedOutside(originalNative, result.native, edit.region);
});
