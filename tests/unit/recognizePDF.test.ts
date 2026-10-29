import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { loadMuPDF } from '../../src/utils/mupdf';
import { recognizePDF } from '../../src/ocr/recognizePDF';
import { applySecureRedactions } from '../../src/editing/SecureRedaction';
import type { OCRProgress } from '../../src/ocr/recognizePDF';

const mock = vi.hoisted(() => ({ initialize: vi.fn(), recognize: vi.fn(), terminate: vi.fn(), created: vi.fn() }));
vi.mock('../../src/ocr/localOCRWorker', () => ({ LocalOCRWorker: class {
  constructor() { mock.created(); }
  initialize = mock.initialize;
  recognize = mock.recognize;
  terminate = mock.terminate;
} }));

function result(text = 'SEARCHABLE', bbox = { x0: 80, y0: 100, x1: 400, y1: 150 }) {
  return { text, confidence: 91, blocks: [{ paragraphs: [{ lines: [{ words: [{ text, bbox }] }] }] }] };
}

async function scanImage() {
  const engine = await loadMuPDF();
  const buffer = new engine.Buffer();
  const writer = new engine.DocumentWriter(buffer, 'pdf', '');
  const device = writer.beginPage([0, 0, 300, 450]);
  const font = new engine.Font('Helvetica');
  const text = new engine.Text();
  text.showString(font, [20, 0, 0, -20, 25, 60], 'SCANNED ORIGINAL');
  device.fillText(text, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, [0.2, 0.3, 0.6], 1);
  device.close(); device.destroy(); text.destroy(); font.destroy();
  writer.endPage(); writer.close();
  const document = new engine.PDFDocument(buffer);
  const page = document.loadPage(0);
  const pixmap = page.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, false);
  const png = new Uint8Array(pixmap.asPNG());
  pixmap.destroy(); page.destroy(); document.destroy(); writer.destroy(); buffer.destroy();
  return png;
}

async function fixture(rotation = 0, unit = 1, extras = true) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  page.setCropBox(30, 50, 300, 450);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
  const image = await pdf.embedPng(await scanImage());
  page.drawImage(image, { x: 30, y: 50, width: 300, height: 450 });
  if (extras) {
    pdf.setTitle('Keep metadata');
    const field = pdf.getForm().createTextField('Keep field');
    field.setText('Editable value');
    field.addToPage(page, { x: 60, y: 65, width: 100, height: 20 });
    const note = pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: 'Text', Rect: [280, 70, 300, 90], Contents: PDFHexString.fromText('Keep annotation'),
      NM: PDFHexString.fromText('original-note'), P: page.ref,
    }));
    page.node.addAnnot(note);
    const outlines = pdf.context.obj({ Type: 'Outlines', Count: 1 });
    const outlineRef = pdf.context.register(outlines);
    const item = pdf.context.register(pdf.context.obj({ Title: PDFHexString.fromText('Keep bookmark'), Parent: outlineRef, Dest: [page.ref, 'Fit'] }));
    outlines.set(PDFName.of('First'), item); outlines.set(PDFName.of('Last'), item);
    pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
    await pdf.attach(new Uint8Array([3, 7, 11]), 'keep.bin');
  }
  return new Uint8Array(await pdf.save()).buffer;
}

async function inspect(data: ArrayBuffer | Uint8Array, pageNumber = 1, scale = 1) {
  const engine = await loadMuPDF();
  const document = new engine.PDFDocument(data);
  const page = document.loadPage(pageNumber - 1);
  const pixmap = page.toPixmap(engine.Matrix.scale(scale, scale), engine.ColorSpace.DeviceRGB, false, true);
  const display = page.toDisplayList(false);
  const structured = display.toStructuredText('preserve-images');
  let images = 0;
  const characters: Array<{ character: string; quad: number[] }> = [];
  structured.walk({ onImageBlock() { images++; }, onChar(character, _origin, _font, _size, quad) { characters.push({ character, quad: [...quad] }); } });
  const info = { text: structured.asText(), images, pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth(), height: pixmap.getHeight(), characters, outline: document.loadOutline() };
  structured.destroy(); display.destroy(); pixmap.destroy(); page.destroy(); document.destroy();
  return info;
}

beforeEach(() => {
  vi.resetAllMocks();
  mock.initialize.mockResolvedValue(undefined);
  mock.recognize.mockResolvedValue(result());
});

describe('local PDF OCR', () => {
  it('adds searchable invisible text without changing pixels, images, fields, bookmarks, attachments, metadata or widget refs', async () => {
    const source = await fixture();
    const before = await inspect(source);
    const original = await PDFDocument.load(source);
    const originalWidget = original.getForm().getFields()[0].acroField.getWidgets()[0];
    const originalWidgetRef = original.context.getObjectRef(originalWidget.dict)?.toString();
    const progress: OCRProgress[] = [];
    const output = await recognizePDF(source, { onProgress: value => progress.push(value) });
    const after = await inspect(output.data);
    expect(after.text).toContain('SEARCHABLE');
    expect(before.text.trim()).toBe('');
    expect(after.pixels).toEqual(before.pixels);
    expect(after.images).toBe(before.images);
    expect(after.outline).toEqual(before.outline);
    const parsed = await PDFDocument.load(output.data);
    expect(parsed.getTitle()).toBe('Keep metadata');
    const field = parsed.getForm().getTextField('Keep field');
    expect(field.getText()).toBe('Editable value');
    expect(parsed.context.getObjectRef(field.acroField.getWidgets()[0].dict)?.toString()).toBe(originalWidgetRef);
    expect(parsed.getPage(0).node.Annots()?.size()).toBe(2);
    expect(parsed.catalog.get(PDFName.of('Names'))).toBeDefined();
    field.setText('Still editable');
    expect((await PDFDocument.load(await parsed.save())).getForm().getTextField('Keep field').getText()).toBe('Still editable');
    expect(output.pages).toEqual([{ pageNumber: 1, status: 'recognized', wordCount: 1, text: 'SEARCHABLE', confidence: 91 }]);
    expect(progress.at(-1)?.progress).toBe(1);
    expect(progress.every((value, index) => index === 0 || value.progress >= progress[index - 1].progress)).toBe(true);
    expect(mock.terminate).toHaveBeenCalledOnce();
  });

  it.each([0, 90, 180, 270])('maps search quads to raster positions with CropBox, UserUnit and rotation %i', async rotation => {
    const source = await fixture(rotation, 1.5, false);
    const bbox = { x0: 70, y0: 85, x1: 350, y1: 135 };
    mock.recognize.mockResolvedValue(result('QUAD', bbox));
    const output = await recognizePDF(source);
    const before = await inspect(source);
    const after = await inspect(output.data);
    expect(after.pixels).toEqual(before.pixels);
    expect(after.text).toContain('QUAD');
    const xs = after.characters.flatMap(char => [char.quad[0], char.quad[2], char.quad[4], char.quad[6]]);
    const ys = after.characters.flatMap(char => [char.quad[1], char.quad[3], char.quad[5], char.quad[7]]);
    const scale = 200 / 72;
    expect(Math.min(...xs)).toBeCloseTo(bbox.x0 / scale, 2);
    expect(Math.max(...xs)).toBeCloseTo(bbox.x1 / scale, 2);
    expect(Math.min(...ys)).toBeCloseTo(bbox.y0 / scale, 2);
    expect(Math.max(...ys)).toBeCloseTo(bbox.y1 / scale, 2);
    const parsed = await PDFDocument.load(output.data);
    expect(parsed.getPage(0).getRotation().angle).toBe(rotation);
    expect(parsed.getPage(0).getCropBox()).toEqual({ x: 30, y: 50, width: 300, height: 450 });
    expect(parsed.getPage(0).node.get(PDFName.of('UserUnit'))?.toString()).toBe('1.5');
  });

  it('preserves Chinese Unicode in a searchable text layer', async () => {
    mock.recognize.mockResolvedValue(result('中文识别 Hello 世界'));
    const output = await recognizePDF(await fixture(), { language: 'chi_sim+eng' });
    expect((await inspect(output.data)).text).toContain('中文识别 Hello 世界');
    expect(mock.initialize).toHaveBeenCalledWith('chi_sim+eng');
  });

  it('securely removes both invisible OCR text and scanned pixels while preserving outside text and image content', async () => {
    const engine = await loadMuPDF();
    const secret = 'OCR_SECRET_671923';
    const publicText = 'PUBLIC_VISIBLE_8472';
    const width = 300, height = 180;
    const buffer = new engine.Buffer();
    const writer = new engine.DocumentWriter(buffer, 'pdf', '');
    const device = writer.beginPage([0, 0, width, height]);
    const font = new engine.Font('Helvetica');
    const text = new engine.Text();
    text.showString(font, [18, 0, 0, -18, 20, 50], secret);
    text.showString(font, [18, 0, 0, -18, 20, 130], publicText);
    device.fillText(text, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    device.close(); device.destroy(); text.destroy(); font.destroy();
    writer.endPage(); writer.close();
    const rendered = new engine.PDFDocument(buffer);
    const renderedPage = rendered.loadPage(0);
    const pixels = renderedPage.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, false);
    const originalImagePixels = new Uint8Array(pixels.getPixels());
    const png = new Uint8Array(pixels.asPNG());
    pixels.destroy(); renderedPage.destroy(); rendered.destroy(); writer.destroy(); buffer.destroy();
    const source = await PDFDocument.create();
    const image = await source.embedPng(png);
    source.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    const sourceData = new Uint8Array(await source.save()).buffer;
    const scale = 200 / 72;
    const word = (value: string, y: number) => ({ text: value, bbox: { x0: 20 * scale, y0: y * scale, x1: 245 * scale, y1: (y + 26) * scale } });
    mock.recognize.mockResolvedValue({ text: `${secret}\n${publicText}`, confidence: 94,
      blocks: [{ paragraphs: [{ lines: [{ words: [word(secret, 30)] }, { words: [word(publicText, 110)] }] }] }] });
    const recognized = await recognizePDF(sourceData);
    const before = await inspect(recognized.data);
    expect(before.text).toContain(secret);
    expect(before.text).toContain(publicText);
    expect(before.pixels).toEqual(originalImagePixels); // The text layer is genuinely invisible.
    const inputCopy = recognized.data.slice();
    const redacted = await applySecureRedactions(new Uint8Array(recognized.data).buffer, [{
      id: 'remove-scanned-secret', pageNumber: 1, rect: { x: 10, y: 20, width: 270, height: 50 },
      overlayColor: '#000000', applied: false,
    }]);
    const after = await inspect(redacted);
    expect(after.text).not.toContain(secret);
    expect(after.text).toContain(publicText);
    expect(after.pixels.slice(80 * width * 3)).toEqual(before.pixels.slice(80 * width * 3));
    expect(after.pixels.slice((40 * width + 40) * 3, (40 * width + 40) * 3 + 3)).toEqual(new Uint8Array([0, 0, 0]));
    expect(recognized.data).toEqual(inputCopy);

    // Inspect the underlying XObjects rather than accepting a black overlay as
    // proof of removal. No hidden copy of the original OCR Form may survive.
    const document = new engine.PDFDocument(redacted);
    const imageSamples: Uint8Array[] = [];
    const formTexts: string[] = [];
    try {
      for (let index = 1; index < document.countObjects(); index++) {
        const object = document.newIndirect(index);
        const subtype = object.get('Subtype');
        try {
          if (!object.isStream()) continue;
          if (subtype.asName() === 'Image') {
            const embedded = document.loadImage(object);
            const imagePixmap = embedded.toPixmap();
            try {
              expect([imagePixmap.getWidth(), imagePixmap.getHeight()]).toEqual([width, height]);
              imageSamples.push(new Uint8Array(imagePixmap.getPixels()));
            } finally { imagePixmap.destroy(); embedded.destroy(); }
          } else if (subtype.asName() === 'Form') {
            const standalone = new engine.PDFDocument();
            const form = standalone.graftObject(object);
            const standalonePage = standalone.addPage([0, 0, width, height], 0, { XObject: { OCR: form } }, '/OCR Do');
            standalone.insertPage(0, standalonePage);
            const page = standalone.loadPage(0);
            const extracted = page.toStructuredText('');
            try { formTexts.push(extracted.asText()); }
            finally { extracted.destroy(); page.destroy(); standalonePage.destroy(); form.destroy(); standalone.destroy(); }
          }
        } finally { subtype.destroy(); object.destroy(); }
      }
    } finally { document.destroy(); }
    expect(imageSamples).toHaveLength(1);
    const cleanImage = imageSamples[0];
    expect(originalImagePixels.slice(30 * width * 3, 60 * width * 3).some(value => value < 128)).toBe(true);
    for (let y = 22; y < 68; y++) {
      expect(cleanImage.slice((y * width + 12) * 3, (y * width + 278) * 3).every(value => value === 255)).toBe(true);
    }
    expect(cleanImage.slice(80 * width * 3)).toEqual(originalImagePixels.slice(80 * width * 3));
    expect(formTexts.join('\n')).not.toContain(secret);
  });

  it('defaults to skipping existing page text and returns original bytes without initializing a worker', async () => {
    const pdf = await PDFDocument.load(await fixture());
    pdf.getPage(0).drawText('Already searchable', { x: 60, y: 150 });
    const source = new Uint8Array(await pdf.save()).buffer;
    const output = await recognizePDF(source);
    expect(output.data).toEqual(new Uint8Array(source));
    expect(output.pages[0].status).toBe('skipped-existing-text');
    expect(mock.created).not.toHaveBeenCalled();
    const forced = await recognizePDF(source, { skipExistingText: false });
    expect((await inspect(forced.data)).text).toContain('SEARCHABLE');
  });

  it('only processes selected pages, deduplicates them, and a second pass skips invisible OCR text', async () => {
    const pdf = await PDFDocument.load(await fixture());
    pdf.addPage([300, 450]);
    const source = new Uint8Array(await pdf.save()).buffer;
    const output = await recognizePDF(source, { pages: [2, 2] });
    expect(output.pages.map(page => page.pageNumber)).toEqual([2]);
    expect((await inspect(output.data, 1)).text.trim()).toBe('');
    expect((await inspect(output.data, 2)).text).toContain('SEARCHABLE');
    const repeated = await recognizePDF(new Uint8Array(output.data).buffer, { pages: [2] });
    expect(repeated.data).toEqual(output.data);
    expect(repeated.pages[0].status).toBe('skipped-existing-text');
    expect(mock.recognize).toHaveBeenCalledOnce();
  });

  it('returns unchanged bytes for a blank page without inventing text', async () => {
    mock.recognize.mockResolvedValue({ text: '', confidence: 0, blocks: null });
    const source = await fixture();
    const output = await recognizePDF(source);
    expect(output.data).toEqual(new Uint8Array(source));
    expect(output.pages[0].status).toBe('no-text');
  });

  it('limits raster dimensions and pixel count on very large pages', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([20_000, 18_000]);
    mock.recognize.mockImplementation(async (png: Uint8Array) => {
      const engine = await loadMuPDF();
      const image = new engine.Image(png);
      expect(image.getWidth()).toBeLessThanOrEqual(4096);
      expect(image.getHeight()).toBeLessThanOrEqual(4096);
      expect(image.getWidth() * image.getHeight()).toBeLessThanOrEqual(8_000_000);
      image.destroy();
      return result();
    });
    await recognizePDF(new Uint8Array(await pdf.save()).buffer);
    expect(mock.recognize).toHaveBeenCalledOnce();
  });

  it.each([
    { text: 'Missing', confidence: 5, blocks: null },
    result('Outside', { x0: -1, y0: 0, x1: 20, y1: 10 }),
    result('\u{10FFFF}'),
  ])('rejects missing positions, invalid bounds and unsupported characters instead of dropping text', async recognized => {
    const source = await fixture();
    const copy = source.slice(0);
    mock.recognize.mockResolvedValue(recognized);
    await expect(recognizePDF(source)).rejects.toThrow(/positions|outside|unsupported character/);
    expect(source).toEqual(copy);
    expect(mock.terminate).toHaveBeenCalledOnce();
  });

  it('aborts without producing a partial PDF, including after an earlier page has finished', async () => {
    const pdf = await PDFDocument.load(await fixture());
    pdf.addPage([300, 450]);
    const source = new Uint8Array(await pdf.save()).buffer;
    const copy = source.slice(0);
    const controller = new AbortController();
    mock.recognize.mockResolvedValueOnce(result()).mockImplementationOnce(async () => { controller.abort(); return result('LATE'); });
    await expect(recognizePDF(source, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(source).toEqual(copy);
    expect(mock.recognize).toHaveBeenCalledTimes(2);
    expect(mock.terminate).toHaveBeenCalledOnce();
  });

  it('rejects an already aborted operation and invalid page selections before starting OCR', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(recognizePDF(new ArrayBuffer(0), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const data = await fixture();
    for (const pages of [[], [0], [2], [1.5], [NaN]]) await expect(recognizePDF(data, { pages })).rejects.toThrow('valid PDF page');
    expect(mock.created).not.toHaveBeenCalled();
  });

  it('propagates recognition failure and terminates the worker', async () => {
    mock.recognize.mockRejectedValue(new Error('Recognition failed'));
    await expect(recognizePDF(await fixture())).rejects.toThrow('Recognition failed');
    expect(mock.terminate).toHaveBeenCalledOnce();
  });
});
