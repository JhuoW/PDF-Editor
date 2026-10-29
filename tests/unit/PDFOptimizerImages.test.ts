import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyImageOptimization, planImageOptimization } from '../../src/core/PDFOptimizerImages';
import { DEFAULT_OPTIMIZER_SETTINGS } from '../../src/core/PDFOptimizerTypes';

const budget = vi.hoisted(() => ({ pixels: 80_000_000 }));
vi.mock('../../src/core/PDFOptimizerTypes', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/PDFOptimizerTypes')>();
  return { ...actual, PDF_OPTIMIZER_LIMITS: { ...actual.PDF_OPTIMIZER_LIMITS, get totalDecodedPixels() { return budget.pixels; } } };
});
afterEach(() => { budget.pixels = 80_000_000; vi.restoreAllMocks(); });
const key = PDFName.of;
const imageSettings = { mode: 'images' as const, dpi: 150 as const, quality: 85 };
function reachable(document: PDFDocument) {
  const found = new Map<number, PDFObject>(), seen = new Set<PDFObject>();
  const queue: PDFObject[] = [document.catalog];
  for (let index = 0; index < queue.length; index++) {
    const original = queue[index], object = document.context.lookup(original); if (!object) throw new Error('Dangling fixture reference');
    if (original instanceof PDFRef) found.set(original.objectNumber, object);
    if (seen.has(object)) continue; seen.add(object);
    if (object instanceof PDFRawStream) queue.push(object.dict);
    else if (object instanceof PDFArray) queue.push(...object.asArray());
    else if (object instanceof PDFDict) queue.push(...object.values());
  }
  // Include the catalog's indirect object, as the production graph does.
  for (const [ref, value] of document.context.enumerateIndirectObjects()) if (value === document.catalog) found.set(ref.objectNumber, value);
  return found;
}
function pixels(width: number, height: number, variant = 0) {
  const result = new Uint8Array(width * height * 3);
  const colors = [[235, 20, 20], [20, 235, 20], [20, 20, 235], [235, 235, 20]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
    result.set(color.map(value => value - variant), (y * width + x) * 3);
  }
  return result;
}
async function fixture(width = 960, height = 640) {
  const document = await PDFDocument.create(), page = document.addPage([400, 600]);
  const image = (variant = 0, properties = {}) => document.context.register(document.context.stream(pixels(width, height, variant), {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    Interpolate: true, Intent: 'RelativeColorimetric', ...properties,
  }));
  const first = image(), duplicate = image();
  page.node.set(key('Resources'), document.context.obj({ XObject: { Metadata: first, AA: first, Twin: duplicate } }));
  page.node.addContentStream(document.context.register(document.context.stream('q 216 0 0 144 20 400 cm /Metadata Do Q q 60 0 0 40 280 400 cm /AA Do Q q 60 0 0 40 280 300 cm /Twin Do Q')));
  return { document, page, first, duplicate, image };
}
async function prepared(document: PDFDocument) {
  const bytes = await document.save({ useObjectStreams: false, updateFieldAppearances: false }), source = await PDFDocument.load(bytes, { updateMetadata: false });
  return { bytes, source, native: new mupdf.PDFDocument(bytes), plan: planImageOptimization(source, reachable(source)) };
}
function save(document: mupdf.PDFDocument) {
  const buffer = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
  try { return new Uint8Array(buffer.asUint8Array()); } finally { buffer.destroy(); }
}
function imageInformation(document: mupdf.PDFDocument, name = 'Metadata') {
  const page = document.loadPage(0), object = page.getObject(), image = object.get('Resources', 'XObject', name);
  try {
    const width = image.get('Width'), height = image.get('Height'), filter = image.get('Filter'), interpolate = image.get('Interpolate'), intent = image.get('Intent');
    try { return { ref: image.asIndirect(), width: width.asNumber(), height: height.asNumber(), filter: filter.asName(), interpolate: interpolate.asBoolean(), intent: intent.asName() }; }
    finally { width.destroy(); height.destroy(); filter.destroy(); interpolate.destroy(); intent.destroy(); }
  } finally { image.destroy(); object.destroy(); page.destroy(); }
}
function render(document: mupdf.PDFDocument, pageNumber = 0) {
  const page = document.loadPage(pageNumber), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return new Uint8Array(pixmap.getPixels()); } finally { pixmap.destroy(); page.destroy(); }
}

describe('native PDF image optimization', () => {
  it('merges only exact image resources, preserves arbitrary aliases and all pixels after garbage collection', async () => {
    const fixtureData = await fixture(60, 40);
    fixtureData.document.catalog.set(key('ImageAliases'), fixtureData.document.context.obj([fixtureData.duplicate, { Nested: [fixtureData.duplicate] }]));
    const input = await prepared(fixtureData.document);
    const original = render(input.native), inputCopy = input.bytes.slice();
    try {
      const changed = await applyImageOptimization(mupdf, input.native, input.plan, DEFAULT_OPTIMIZER_SETTINGS, {});
      expect(changed.imagesDeduplicated).toBe(1); expect(changed.imagesOptimized).toBe(0); expect(changed.aliases.size).toBe(1);
      const output = new mupdf.PDFDocument(save(input.native));
      try {
        expect(Buffer.from(render(output)).equals(Buffer.from(original))).toBe(true);
        expect(imageInformation(output).ref).toBe(imageInformation(output, 'AA').ref);
        expect(imageInformation(output).ref).toBe(imageInformation(output, 'Twin').ref);
        expect(imageInformation(output)).toMatchObject({ width: 60, height: 40, interpolate: true, intent: 'RelativeColorimetric' });
        const trailer = output.getTrailer(), alias = trailer.get('Root', 'ImageAliases', 1, 'Nested', 0);
        try { expect(alias.asIndirect()).toBe(imageInformation(output).ref); } finally { alias.destroy(); trailer.destroy(); }
      } finally { output.destroy(); }
      expect(input.bytes).toEqual(inputCopy);
    } finally { input.native.destroy(); }
  });

  it('keeps distinct image dictionaries separate even when their encoded pixels match', async () => {
    const data = await fixture(30, 20);
    data.document.context.lookup(data.duplicate, PDFRawStream).dict.set(key('Interpolate'), data.document.context.obj(false));
    const input = await prepared(data.document);
    try {
      const result = await applyImageOptimization(mupdf, input.native, input.plan, DEFAULT_OPTIMIZER_SETTINGS, {});
      expect(result.imagesDeduplicated).toBe(0);
      expect(imageInformation(input.native).ref).not.toBe(imageInformation(input.native, 'Twin').ref);
    } finally { input.native.destroy(); }
  });

  it('downsamples without flipping the lower image corners and preserves non-encoding properties', async () => {
    const data = await fixture(), input = await prepared(data.document);
    try {
      const result = await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(result.imagesOptimized).toBe(1); expect(result.imagesDeduplicated).toBe(1);
      const output = new mupdf.PDFDocument(save(input.native));
      try {
        expect(imageInformation(output)).toMatchObject({ width: 450, height: 300, filter: 'DCTDecode', interpolate: true, intent: 'RelativeColorimetric' });
        const ref = output.newIndirect(imageInformation(output).ref), image = output.loadImage(ref), pixmap = image.toPixmap();
        try {
          for (const [x, y, expected] of [[20, 20, [235, 20, 20]], [430, 20, [20, 235, 20]], [20, 280, [20, 20, 235]], [430, 280, [235, 235, 20]]] as Array<[number, number, number[]]>) {
            const offset = y * pixmap.getStride() + x * pixmap.getNumberOfComponents();
            expected.forEach((channel, component) => expect(Math.abs(pixmap.getPixels()[offset + component] - channel)).toBeLessThan(8));
          }
        } finally { pixmap.destroy(); image.destroy(); ref.destroy(); }
      } finally { output.destroy(); }
    } finally { input.native.destroy(); }
  });

  it('uses the largest shared placement through nested forms, CropBox, native rotation and UserUnit', async () => {
    const data = await fixture(1200, 800), second = data.document.addPage([400, 600]);
    const form = data.document.context.register(data.document.context.stream('q 180 0 0 120 0 0 cm /Shared Do Q', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 180, 120], Resources: { XObject: { Shared: data.first } },
    }));
    second.node.set(key('Resources'), data.document.context.obj({ XObject: { Nested: form } }));
    second.node.set(key('CropBox'), data.document.context.obj([20, 30, 380, 570]));
    second.node.set(key('Rotate'), data.document.context.obj(90)); second.node.set(key('UserUnit'), data.document.context.obj(2));
    second.node.addContentStream(data.document.context.register(data.document.context.stream('q 1 0 0 1 50 60 cm /Nested Do Q')));
    const input = await prepared(data.document);
    try {
      await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(imageInformation(input.native)).toMatchObject({ width: 750, height: 500 });
    } finally { input.native.destroy(); }
  });

  it('protects an image shared by page content and a native annotation appearance', async () => {
    const data = await fixture();
    const appearance = data.document.context.register(data.document.context.stream('q 120 0 0 80 0 0 cm /Image Do Q', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 80], Resources: { XObject: { Image: data.first } },
    }));
    const stamp = data.document.context.register(data.document.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [20, 100, 140, 180], AP: { N: appearance }, F: 4 }));
    data.page.node.set(key('Annots'), data.document.context.obj([stamp]));
    const input = await prepared(data.document);
    try {
      expect(input.plan.eligibleImageCount).toBe(1); expect(input.plan.warnings.join(' ')).toContain('appearances');
      const result = await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(result.imagesOptimized).toBe(1); expect(result.imagesDeduplicated).toBe(0);
      expect(imageInformation(input.native)).toMatchObject({ width: 960, height: 640 });
      const output = new mupdf.PDFDocument(save(input.native)), page = output.loadPage(0), object = page.getObject(), reference = object.get('Annots', 0, 'AP', 'N', 'Resources', 'XObject', 'Image');
      try { expect(reference.asIndirect()).toBe(imageInformation(output).ref); }
      finally { reference.destroy(); object.destroy(); page.destroy(); output.destroy(); }
    } finally { input.native.destroy(); }
  });

  it.each(['decoration', 'Type3', 'Pattern', 'attachment', 'mask'] as const)('protects images reachable through %s resources even when also drawn on the page', async kind => {
    const data = await fixture(60, 40);
    const protectedResource = kind === 'decoration' ? { PDFEditorDecorationID: 'managed', Resources: { XObject: { Image: data.first } } }
      : kind === 'Type3' ? { Type: 'Font', Subtype: 'Type3', Resources: { XObject: { Image: data.first } } }
      : kind === 'Pattern' ? { Type: 'Pattern', PatternType: 1, Resources: { XObject: { Image: data.first } } }
      : kind === 'attachment' ? { Type: 'Filespec', EF: { F: data.first } } : { SMask: data.first };
    data.document.catalog.set(key('PreservedTestResource'), data.document.context.obj(protectedResource));
    const input = await prepared(data.document);
    try { expect(input.plan.eligibleImageCount).toBe(1); expect(input.plan.candidates.map(item => item.ref)).not.toContain(data.first.objectNumber); }
    finally { input.native.destroy(); }
  });

  it('preserves optional-content images without decoding or changing their resolution', async () => {
    const data = await fixture();
    const layer = data.document.context.register(data.document.context.obj({ Type: 'OCG', Name: 'Hidden layer' }));
    data.document.catalog.set(key('OCProperties'), data.document.context.obj({ OCGs: [layer], D: { OFF: [layer] } }));
    const input = await prepared(data.document), decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap');
    try {
      expect(input.plan.eligibleImageCount).toBe(0);
      const result = await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(result.imagesOptimized).toBe(0); expect(decode).not.toHaveBeenCalled(); expect(imageInformation(input.native).width).toBe(960);
    } finally { input.native.destroy(); }
  });

  it('skips specialized color spaces, masks and dimensions rather than reinterpreting their pixels', async () => {
    const data = await fixture(20, 10);
    const first = data.document.context.lookup(data.first, PDFRawStream), duplicate = data.document.context.lookup(data.duplicate, PDFRawStream);
    first.dict.set(key('ColorSpace'), key('DeviceCMYK')); duplicate.dict.set(key('Width'), data.document.context.obj(20000));
    const input = await prepared(data.document);
    try { expect(input.plan.eligibleImageCount).toBe(0); expect(input.plan.warnings.join(' ')).toContain('color spaces'); expect(input.plan.warnings.join(' ')).toContain('size limits'); }
    finally { input.native.destroy(); }
  });

  it('stops decoding before the aggregate pixel budget is exceeded', async () => {
    const data = await fixture(200, 120);
    const duplicate = data.document.context.lookup(data.duplicate, PDFRawStream); duplicate.contents[0] = 17;
    budget.pixels = 30_000;
    const input = await prepared(data.document), decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap');
    try {
      const result = await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(decode).toHaveBeenCalledTimes(1); expect(result.imagesOptimized).toBe(1); expect(result.warnings.join(' ')).toContain('decoding budget');
      expect(imageInformation(input.native, 'Twin').width).toBe(200);
    } finally { input.native.destroy(); }
  });

  it('does not replace an existing JPEG with a larger recompressed image', async () => {
    const data = await fixture(60, 40), pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 60, 40], false);
    pixmap.getPixels().set(pixels(60, 40));
    const encoded = pixmap.asJPEG(1); pixmap.destroy();
    for (const ref of [data.first, data.duplicate]) {
      const dict = data.document.context.lookup(ref, PDFRawStream).dict;
      data.document.context.assign(ref, data.document.context.stream(encoded, { ...Object.fromEntries(dict.entries().map(([property, value]) => [property.decodeText(), value])), Filter: 'DCTDecode' }));
    }
    const input = await prepared(data.document);
    try {
      const result = await applyImageOptimization(mupdf, input.native, input.plan, { ...imageSettings, quality: 100 }, {});
      expect(result.imagesOptimized).toBe(0); expect(result.warnings.join(' ')).toContain('already smaller');
      expect(imageInformation(input.native)).toMatchObject({ width: 60, height: 40, filter: 'DCTDecode' });
    } finally { input.native.destroy(); }
  });

  it('rejects decoder warnings rather than publishing a partially decoded image', async () => {
    const data = await fixture(60, 40), raw = data.document.context.lookup(data.first, PDFRawStream);
    data.document.context.assign(data.first, data.document.context.stream(new Uint8Array([255, 0, 0]), Object.fromEntries(raw.dict.entries().map(([property, value]) => [property.decodeText(), value]))));
    const input = await prepared(data.document);
    try { await expect(applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {})).rejects.toThrow(/image processing|premature|truncated/i); }
    finally { input.native.destroy(); }
  });

  it('releases held image handles and rejects cancellation without producing a result', async () => {
    const data = await fixture(60, 40), input = await prepared(data.document), controller = new AbortController();
    const load = vi.spyOn(mupdf.PDFDocument.prototype, 'loadImage');
    try {
      await expect(applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {
        signal: controller.signal, onProgress: () => controller.abort(),
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(load).toHaveBeenCalled();
      for (const call of load.mock.results) if (call.type === 'return') expect(call.value.pointer).toBe(0);
    } finally { input.native.destroy(); }
  });

  it.each([
    { Predictor: 1_000_000_000 }, { Predictor: 12, Colors: 1_000_000_000 },
    { Predictor: 12, Columns: 1_000_000_000 }, { Predictor: 2, BitsPerComponent: 32 },
    { Predictor: 12, Colors: 2 }, { Predictor: 12, Columns: 1.5 },
  ])('preserves Flate images with unsafe predictor geometry %j without native image decoding', async parameters => {
    const data = await fixture(20, 10);
    for (const ref of [data.first, data.duplicate]) data.document.context.assign(ref, data.document.context.flateStream(pixels(20, 10), {
      Type: 'XObject', Subtype: 'Image', Width: 20, Height: 10, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
      DecodeParms: parameters,
    }));
    const input = await prepared(data.document), load = vi.spyOn(mupdf.PDFDocument.prototype, 'loadImage');
    try {
      expect(input.plan.eligibleImageCount).toBe(0);
      const result = await applyImageOptimization(mupdf, input.native, input.plan, imageSettings, {});
      expect(result.imagesOptimized).toBe(0); expect(result.imagesDeduplicated).toBe(0);
      expect(result.warnings.join(' ')).toContain('decoder settings'); expect(load).not.toHaveBeenCalled();
    } finally { input.native.destroy(); }
  });
});
