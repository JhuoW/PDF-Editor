import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { deflateSync } from 'node:zlib';
import { DEFAULT_OPTIMIZER_SETTINGS, inspectPDFOptimization, optimizePDF } from '../../src/core/PDFOptimizer';
import { encryptPDF, ALL_PDF_PERMISSIONS } from '../../src/core/PDFEncryption';
import { createOptimizationPDF } from '../fixtures/optimizationPDF';
import { CLEANUP_SECRETS, decodedPDFStrings } from '../fixtures/cleanupPDF';

const budget = vi.hoisted(() => ({ stream: 32 * 1024 * 1024, total: 128 * 1024 * 1024, pixels: 80_000_000 }));
vi.mock('../../src/core/PDFOptimizerTypes', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/PDFOptimizerTypes')>();
  return { ...actual, PDF_OPTIMIZER_LIMITS: { ...actual.PDF_OPTIMIZER_LIMITS, get streamBytes() { return budget.stream; }, get totalStreamBytes() { return budget.total; }, get totalDecodedPixels() { return budget.pixels; } } };
});
afterEach(() => { vi.restoreAllMocks(); budget.stream = 32 * 1024 * 1024; budget.total = 128 * 1024 * 1024; budget.pixels = 80_000_000; });
const key = PDFName.of, bytes = (data: Uint8Array) => new Uint8Array(data).buffer;
function render(data: ArrayBuffer | Uint8Array, pageNumber = 0) {
  const document = new mupdf.PDFDocument(new Uint8Array(data)), page = document.loadPage(pageNumber), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true), text = page.toStructuredText('');
  try { return { pixels: Buffer.from(pixmap.getPixels()), width: pixmap.getWidth(), height: pixmap.getHeight(), text: text.asText() }; }
  finally { text.destroy(); pixmap.destroy(); page.destroy(); document.destroy(); }
}
function images(document: PDFDocument) { return document.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.dict.lookup(key('Subtype')) === key('Image')); }
async function bilevelPDF() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([256, 256]), samples = Uint8Array.from({ length: 1024 * 1024 / 8 }, (_, index) => Math.floor(index / 128) % 32 < 16 ? 0x00 : 0xff);
  const image = pdf.context.register(pdf.context.stream(samples, { Type: 'XObject', Subtype: 'Image', Width: 1024, Height: 1024, BitsPerComponent: 1, ColorSpace: 'DeviceGray' }));
  page.node.set(key('Resources'), pdf.context.obj({ XObject: { Scan: image } })); page.node.addContentStream(pdf.context.register(pdf.context.stream('q 256 0 0 256 0 0 cm /Scan Do Q')));
  return { data: await pdf.save({ useObjectStreams: false }), imageRef: image.objectNumber, samples };
}

describe('native PDF optimizer', () => {
  it('compresses real streams while preserving every page pixel, text, field/widget ref, note, attachment, link, script and bookmark', async () => {
    const original = await createOptimizationPDF(), copy = new Uint8Array(original), before = await PDFDocument.load(original, { updateMetadata: false });
    const fields = before.getForm().getFields().map(field => field.ref.toString());
    const inspection = await inspectPDFOptimization(original); expect(inspection.canOptimize).toBe(true); expect(inspection.imageCount).toBe(1); expect(inspection.eligibleImageCount).toBe(1);
    const result = await optimizePDF(original); expect(result.changed).toBe(true); expect(result.outputBytes).toBeLessThan(result.inputBytes * 0.8); expect(result.imagesOptimized).toBe(0); expect(original).toEqual(copy);
    for (let page = 0; page < 2; page++) { expect(render(result.data, page).pixels.equals(render(original, page).pixels)).toBe(true); expect(render(result.data, page).text).toBe(render(original, page).text); }
    const after = await PDFDocument.load(result.data, { updateMetadata: false }); expect(after.getForm().getFields().map(field => field.ref.toString())).toEqual(fields); expect(after.getTitle()).toBe(before.getTitle()); expect(after.catalog.has(key('Outlines'))).toBe(true);
    const retained = await decodedPDFStrings(result.data); for (const value of Object.values(CLEANUP_SECRETS)) expect(retained).toContain(value);
    expect(retained).toContain('https://example.com/review'); expect(retained).toContain('Second page bookmark');
  });
  it('changes only the chosen image pixels and dimensions while retaining text and interactive data', async () => {
    const original = await createOptimizationPDF(), result = await optimizePDF(original, { mode: 'images', dpi: 150, quality: 80 }); expect(result.imagesOptimized).toBe(1); expect(result.outputBytes).toBeLessThan(result.inputBytes / 2);
    const document = await PDFDocument.load(result.data, { updateMetadata: false }), image = images(document)[0][1] as PDFRawStream;
    expect(image.dict.lookup(key('Width'), PDFNumber).asNumber()).toBe(450); expect(image.dict.lookup(key('Height'), PDFNumber).asNumber()).toBe(300); expect(image.dict.lookup(key('Filter'))).toBe(key('DCTDecode'));
    const before = render(original), after = render(result.data); expect(after.text).toBe(before.text);
    // The image occupies native x=30..246, y=50..194 on a 400x600 page.
    for (let y = 0; y < before.height; y++) { if (y >= 405 && y <= 551) continue; expect(after.pixels.subarray(y * before.width * 3, (y + 1) * before.width * 3).equals(before.pixels.subarray(y * before.width * 3, (y + 1) * before.width * 3))).toBe(true); }
    expect(document.getForm().getTextField('Contact').getText()).toBe(CLEANUP_SECRETS.form); expect(await decodedPDFStrings(result.data)).toContain(CLEANUP_SECRETS.attachment);
  });
  it('retains original bytes and honest final counters when a verified candidate is not smaller', async () => {
    const once = await optimizePDF(await createOptimizationPDF()), twice = await optimizePDF(once.data);
    expect(twice.changed).toBe(false); expect(Buffer.from(twice.data).equals(Buffer.from(once.data))).toBe(true); expect(twice.outputBytes).toBe(once.data.length); expect(twice.candidateBytes).toBeGreaterThanOrEqual(twice.outputBytes); expect(twice.imagesOptimized).toBe(0); expect(twice.imagesDeduplicated).toBe(0); expect(twice.warnings.join(' ')).toContain('original bytes');
  });
  it('losslessly encodes a real bilevel scan as CCITT and verifies identical pixels', async () => {
    const { data } = await bilevelPDF(), original = new Uint8Array(data), result = await optimizePDF(data);
    expect(result.changed).toBe(true); expect(result.outputBytes).toBeLessThan(result.inputBytes / 4); expect(result.imagesOptimized).toBe(0);
    const reopened = await PDFDocument.load(result.data, { updateMetadata: false }), image = images(reopened)[0][1] as PDFRawStream;
    expect(image.dict.lookup(key('Filter'))).toBe(key('CCITTFaxDecode')); expect(render(result.data).pixels.equals(render(data).pixels)).toBe(true); expect(Buffer.from(data).equals(Buffer.from(original))).toBe(true);
  });
  it('refuses a bilevel rewrite with changed pixels and never returns a partial result', async () => {
    const { data, imageRef, samples } = await bilevelPDF(), original = new Uint8Array(data), save = mupdf.PDFDocument.prototype.saveToBuffer;
    vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer').mockImplementation(function (options) {
      if (!String(options).includes('objstms=yes')) { const image = this.newIndirect(imageRef); try { image.writeRawStream(new Uint8Array(samples.length)); } finally { image.destroy(); } }
      return save.call(this, options);
    });
    await expect(optimizePDF(data)).rejects.toThrow(/preserved image pixels/); expect(Buffer.from(data).equals(Buffer.from(original))).toBe(true);
  });
  it('decodes generated JPEGs again and refuses invalid image bytes from the writer', async () => {
    const original = await createOptimizationPDF(), source = await PDFDocument.load(original, { updateMetadata: false }), imageNumber = images(source)[0][0].objectNumber;
    const save = mupdf.PDFDocument.prototype.saveToBuffer;
    vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer').mockImplementation(function (options) {
      if (!String(options).includes('objstms=yes')) { const image = this.newIndirect(imageNumber); try { image.writeRawStream(new Uint8Array([0xff, 0xd8, 0, 0])); } finally { image.destroy(); } }
      return save.call(this, options);
    });
    await expect(optimizePDF(original, { mode: 'images', dpi: 150, quality: 80 })).rejects.toThrow(/image|JPEG|MuPDF/i);
    expect(render(original).text).toContain('Original body text');
  });
  it('counts original and rewritten bilevel decoding against the cumulative image budget', async () => {
    const { data } = await bilevelPDF(); budget.pixels = 1024 * 1024;
    const decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap'); await expect(optimizePDF(data)).rejects.toThrow(/cumulative verification resource limit/); expect(decode).not.toHaveBeenCalled();
  });
  it('rejects oversized raw image dimensions before invoking the native writer', async () => {
    const { data, imageRef } = await bilevelPDF(), pdf = await PDFDocument.load(data, { updateMetadata: false });
    const image = pdf.context.enumerateIndirectObjects().find(([ref]) => ref.objectNumber === imageRef)![1] as PDFRawStream; image.dict.set(key('Width'), PDFNumber.of(1_000_000));
    const original = await pdf.save({ useObjectStreams: false }), save = vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer');
    await expect(optimizePDF(original)).rejects.toThrow(/resource limit/); expect(save).not.toHaveBeenCalled();
  });
  it('preserves real content encoded with an ASCIIHex and Flate filter chain', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]), font = await pdf.embedFont(StandardFonts.Helvetica);
    page.node.set(key('Resources'), pdf.context.obj({ Font: { Body: font.ref } }));
    const content = 'BT /Body 18 Tf 20 100 Td (Chained stream text) Tj ET\n' + 'q Q\n'.repeat(20000);
    const encoded = new TextEncoder().encode(deflateSync(content).toString('hex') + '>');
    page.node.addContentStream(pdf.context.register(pdf.context.stream(encoded, { Filter: ['ASCIIHexDecode', 'FlateDecode'], DecodeParms: [null, null] })));
    const original = await pdf.save({ useObjectStreams: false }), result = await optimizePDF(original);
    expect(render(result.data).text).toContain('Chained stream text'); expect(render(result.data).pixels.equals(render(original).pixels)).toBe(true);
  });
  it.each(['name', 'null'] as const)('does not mistake an unused indirect %s for a reachable interned value', async kind => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]);
    const value = kind === 'name' ? key('Page') : pdf.context.obj(null); const unused = pdf.context.register(value);
    if (kind === 'null') pdf.catalog.set(key('LegalNull'), value);
    page.node.addContentStream(pdf.context.register(pdf.context.stream('q Q\n'.repeat(10000))));
    const original = await pdf.save({ useObjectStreams: false }), result = await optimizePDF(original), after = await PDFDocument.load(result.data, { updateMetadata: false });
    expect(result.changed).toBe(true); expect(after.context.lookup(unused)).toBeUndefined(); expect(render(result.data).pixels.equals(render(original).pixels)).toBe(true);
  });
  it('isolates an object-packing failure and returns the independently verified plain rewrite', async () => {
    const original = await createOptimizationPDF(), save = mupdf.PDFDocument.prototype.saveToBuffer; let packingFailed = false;
    vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer').mockImplementation(function (options) {
      if (String(options).includes('objstms=yes')) {
        packingFailed = true; const trailer = this.getTrailer(), root = trailer.get('Root'); try { root.delete('Names'); } finally { root.destroy(); trailer.destroy(); }
        throw new Error('cannot find object in xref (5 0 R)');
      }
      return save.call(this, options);
    });
    const result = await optimizePDF(original); expect(packingFailed).toBe(true); expect(result.changed).toBe(true); expect(result.warnings.join(' ')).toContain('packing was skipped'); expect(await decodedPDFStrings(result.data)).toContain(CLEANUP_SECRETS.attachment); expect(await decodedPDFStrings(result.data)).toContain(CLEANUP_SECRETS.script); expect(render(result.data).pixels.equals(render(original).pixels)).toBe(true);
  });
  it('refuses an output whose writer lost an attachment or changed document metadata', async () => {
    const original = await createOptimizationPDF(), copy = new Uint8Array(original), save = mupdf.PDFDocument.prototype.saveToBuffer;
    vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer').mockImplementation(function (options) {
      const trailer = this.getTrailer(), root = trailer.get('Root'); try { root.delete('Names'); } finally { root.destroy(); trailer.destroy(); } return save.call(this, options);
    });
    await expect(optimizePDF(original)).rejects.toThrow(/changed|removed|preserv/i); expect(original).toEqual(copy);
  });
  it('keeps file identifiers, all Info and nested XML metadata verbatim', async () => {
    const pdf = await PDFDocument.load(await createOptimizationPDF(), { updateMetadata: false }); pdf.context.trailerInfo.ID = pdf.context.obj([PDFHexString.fromText('ORIGINAL_IDENTIFIER'), PDFHexString.fromText('REVISION_IDENTIFIER')]);
    pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict).set(key('Custom'), PDFHexString.fromText('Private 中文 metadata'));
    const pageMetadata = pdf.context.register(pdf.context.flateStream('<xmp>PAGE_METADATA</xmp>', { Type: 'Metadata', Subtype: 'XML' })); pdf.getPage(1).node.set(key('Metadata'), pageMetadata);
    const original = await pdf.save({ useObjectStreams: false }), result = await optimizePDF(original), reopened = await PDFDocument.load(result.data, { updateMetadata: false });
    expect(reopened.context.trailerInfo.ID?.toString()).toBe(pdf.context.trailerInfo.ID.toString()); const text = await decodedPDFStrings(result.data); expect(text).toContain('Private 中文 metadata'); expect(text).toContain('PAGE_METADATA');
  });
  it('keeps optional-content images and their visibility state intact', async () => {
    const pdf = await PDFDocument.load(await createOptimizationPDF(), { updateMetadata: false }), group = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Optional layer') })); pdf.catalog.set(key('OCProperties'), pdf.context.obj({ OCGs: [group], D: { OFF: [group] } }));
    const original = await pdf.save({ useObjectStreams: false }), inspected = await inspectPDFOptimization(original); expect(inspected.eligibleImageCount).toBe(0); expect(inspected.warnings.join(' ')).toContain('optional-content');
    const result = await optimizePDF(original, { mode: 'images', dpi: 150, quality: 1 }); expect(result.imagesOptimized).toBe(0); expect(render(result.data).pixels.equals(render(original).pixels)).toBe(true);
    const reopened = await PDFDocument.load(result.data, { updateMetadata: false }); expect(reopened.catalog.lookup(key('OCProperties'), PDFDict).lookup(key('D'), PDFDict).lookup(key('OFF'), PDFArray).size()).toBe(1);
  });
  it.each(['XFA', 'signature'] as const)('refuses %s input without modifying it', async kind => {
    const pdf = await PDFDocument.load(await createOptimizationPDF(), { updateMetadata: false });
    if (kind === 'XFA') pdf.catalog.lookup(key('AcroForm'), PDFDict).set(key('XFA'), pdf.context.register(pdf.context.stream('<xfa>dynamic form</xfa>')));
    else pdf.catalog.set(key('Perms'), pdf.context.obj({ DocMDP: pdf.context.register(pdf.context.obj({ Type: 'Sig', Contents: PDFHexString.of('1234'), ByteRange: [0, 1, 2, 3] })) }));
    const original = await pdf.save({ updateFieldAppearances: false }), copy = new Uint8Array(original); const report = await inspectPDFOptimization(original); expect(report.canOptimize).toBe(false); await expect(optimizePDF(original)).rejects.toThrow(kind === 'XFA' ? /XFA/ : /Signed/); expect(original).toEqual(copy);
  });
  it('rejects locked input, malformed files and invalid settings clearly', async () => {
    const original = await createOptimizationPDF(), encrypted = await encryptPDF(bytes(original), { userPassword: 'read', ownerPassword: 'owner', permissions: { ...ALL_PDF_PERMISSIONS } });
    await expect(optimizePDF(encrypted)).rejects.toThrow(/Unlock/); await expect(optimizePDF(new TextEncoder().encode('%PDF-1.7\nbroken file'))).rejects.toThrow(); await expect(optimizePDF(original, { mode: 'images', dpi: 150, quality: 0 })).rejects.toThrow(/quality/);
  });
  it('does not confuse legal resource names with signatures or active content', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]), font = await pdf.embedFont(StandardFonts.CourierBold); page.node.set(key('Resources'), pdf.context.obj({ Font: { ByteRange: font.ref } })); page.node.addContentStream(pdf.context.register(pdf.context.flateStream('BT /ByteRange 18 Tf 20 150 Td (Keep me) Tj ET')));
    const original = await pdf.save({ useObjectStreams: false }); expect((await inspectPDFOptimization(original)).canOptimize).toBe(true); const result = await optimizePDF(original); expect(render(result.data).pixels.equals(render(original).pixels)).toBe(true);
  });
  it('enforces per-stream and aggregate decoded budgets before publishing anything', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); const a = pdf.context.register(pdf.context.flateStream('A'.repeat(4096))), b = pdf.context.register(pdf.context.flateStream('B'.repeat(4096))); pdf.catalog.set(key('PrivateA'), a); pdf.catalog.set(key('PrivateB'), b);
    const original = await pdf.save({ updateFieldAppearances: false }), copy = new Uint8Array(original); budget.stream = 2048; await expect(optimizePDF(original)).rejects.toThrow(/resource limit/); budget.stream = 8192; budget.total = 6000; await expect(optimizePDF(original)).rejects.toThrow(/resource limit/); expect(original).toEqual(copy);
  });
  it.each(['inspect', 'verify'] as const)('honors cancellation from the final %s progress callback', async phase => {
    const original = await createOptimizationPDF(), controller = new AbortController(), control = { signal: controller.signal, onProgress: (value: { phase: string; completed: number; total: number }) => { if (value.phase === phase && value.completed === value.total) controller.abort(); } };
    if (phase === 'inspect') await expect(inspectPDFOptimization(original, control)).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(optimizePDF(original, DEFAULT_OPTIMIZER_SETTINGS, control)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
