import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { createVisibleCopy, inspectVisibleCopy, VISIBLE_COPY_LIMITS } from '../../src/core/VisibleCopy';

const settings = { dpi: 150 as const, compression: 'lossless' as const };
function save(document: mupdf.PDFDocument) { const bytes = document.saveToBuffer('garbage=1,compress'); try { return new Uint8Array(bytes.asUint8Array()); } finally { bytes.destroy(); } }
function pixels(data: Uint8Array, pageNumber = 1, dpi = 150) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(pageNumber - 1), pixmap = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true, 'View', 'CropBox');
  try { return { width: pixmap.getWidth(), height: pixmap.getHeight(), data: new Uint8Array(pixmap.getPixels()) }; } finally { pixmap.destroy(); page.destroy(); pdf.destroy(); }
}
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.setTitle('SOURCE_METADATA_SECRET');
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([144, 216]); page.setCropBox(18, 36, 72, 144); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(rotation === 90 ? 2 : 1));
    page.drawRectangle({ x: 18, y: 36, width: 72, height: 144, color: rgb(.2, .6, .9) });
    page.drawText('VISIBLE', { x: 23, y: 150, size: 8 }); page.drawText('CROP_SECRET', { x: 95, y: 190, size: 6 });
  }
  const field = pdf.getForm().createTextField('Name'); field.setText('VISIBLE FIELD'); field.addToPage(pdf.getPage(0), { x: 20, y: 90, width: 65, height: 22, fontSize: 7 });
  await pdf.attach(new TextEncoder().encode('ATTACHMENT_SECRET'), 'SECRET_ATTACHMENT.txt');
  return new Uint8Array(await pdf.save());
}
function hiddenFixture() {
  const doc = new mupdf.PDFDocument(), font = new mupdf.Font('Helvetica'), fontRef = doc.addSimpleFont(font), layerName = doc.newString('OCG_METADATA_SECRET');
  const layer = doc.addObject({ Type: 'OCG', Name: layerName }), trailer = doc.getTrailer(), catalog = trailer.get('Root');
  const metadata = doc.addStream('<metadata>XML_METADATA_SECRET</metadata>', { Type: 'Metadata', Subtype: 'XML' }), script = doc.newString("app.alert('SCRIPT_SECRET')");
  try {
    catalog.put('OCProperties', { OCGs: [layer], D: { BaseState: 'ON', OFF: [layer] } }); catalog.put('Metadata', metadata);
    catalog.put('OpenAction', { S: 'JavaScript', JS: script });
    const payload = doc.addEmbeddedFile('PRIVATE_ATTACHMENT.txt', 'text/plain', new TextEncoder().encode('ATTACHMENT_SECRET'), new Date(0), new Date(0));
    try { doc.insertEmbeddedFile('PRIVATE_ATTACHMENT.txt', payload); } finally { payload.destroy(); }
    const ref = doc.addPage([0, 0, 240, 320], 0, { Font: { F: fontRef }, Properties: { Hidden: layer }, ExtGState: { Zero: { ca: 0, CA: 0 } } }, `
BT /F 12 Tf 20 280 Td (PUBLIC) Tj ET
BT /F 12 Tf 20 220 Td (COVERED_SECRET) Tj ET
1 1 1 rg 0 210 240 35 re f
q /Zero gs BT /F 12 Tf 20 180 Td (ALPHA_SECRET) Tj ET Q
BT /F 12 Tf 3 Tr 20 140 Td (OCR_SECRET) Tj ET
0 0 0 rg /OC /Hidden BDC BT /F 12 Tf 0 Tr 20 100 Td (OCG_SECRET) Tj ET EMC
q 0 0 1 1 re W n BT /F 12 Tf 0 Tr 20 60 Td (CLIPPED_SECRET) Tj ET Q
`);
    try { doc.insertPage(-1, ref); } finally { ref.destroy(); }
    const page = doc.loadPage(0), note = page.createAnnotation('Text'), hiddenNote = page.createAnnotation('Text');
    try {
      note.setRect([180, 20, 204, 44]); note.setContents('ANNOTATION_CONTENTS_SECRET'); note.update();
      hiddenNote.setRect([20, 20, 44, 44]); hiddenNote.setContents('HIDDEN_NOTE_SECRET'); hiddenNote.setFlags(mupdf.PDFAnnotation.IS_HIDDEN); hiddenNote.update();
    } finally { hiddenNote.destroy(); note.destroy(); page.destroy(); }
    return save(doc);
  } finally { script.destroy(); metadata.destroy(); catalog.destroy(); trailer.destroy(); layer.destroy(); layerName.destroy(); fontRef.destroy(); font.destroy(); doc.destroy(); }
}

describe('fresh visible page copies', () => {
  it('creates an independent image-only PDF, preserving mixed CropBox/Rotate/UserUnit pixels and visible widget appearance', async () => {
    const source = await fixture(), before = source.slice(), result = await createVisibleCopy(source, settings);
    expect(result).toMatchObject({ pageCount: 4, sourcePageCount: 4, pages: [1, 2, 3, 4], dpi: 150, compression: 'lossless', warnings: [] });
    for (let page = 1; page <= 4; page++) expect(pixels(result.data, page)).toEqual(pixels(source, page));
    const pdf = await PDFDocument.load(result.data); expect(pdf.getForm().getFields()).toHaveLength(0); expect(pdf.getTitle()).toBeUndefined(); expect(pdf.catalog.has(PDFName.of('Names'))).toBe(false);
    const native = new mupdf.PDFDocument(result.data);
    try { for (let page = 0; page < 4; page++) { const item = native.loadPage(page), text = item.toStructuredText(''); try { expect(text.asText().trim()).toBe(''); expect(item.getAnnotations()).toHaveLength(0); expect(item.getWidgets()).toHaveLength(0); } finally { text.destroy(); item.destroy(); } } }
    finally { native.destroy(); }
    expect(source).toEqual(before);
  });

  it('uses the same encoding pipeline for an exact single-page preview and 300 dpi JPEG output', async () => {
    const source = await fixture(), jpeg = { dpi: 300 as const, compression: 'jpeg' as const, quality: 92 };
    const full = await createVisibleCopy(source, jpeg), preview = await createVisibleCopy(source, jpeg, { previewPage: 2 });
    expect(preview).toMatchObject({ pageCount: 1, sourcePageCount: 4, pages: [2] });
    expect(pixels(preview.data, 1, 300)).toEqual(pixels(full.data, 2, 300));
    expect(pixels(preview.data, 1, 300)).toMatchObject({ width: 1200, height: 600 });
    expect(preview.encodedImageBytes).toBeGreaterThan(100);
  });

  it('rejects excessive dimensions, accumulated pixel/byte budgets and invalid settings without changing input', async () => {
    const large = await PDFDocument.create(); large.addPage([14400, 14400]);
    await expect(createVisibleCopy(await large.save(), settings)).rejects.toThrow('40 megapixels');
    const data = await fixture(), limit = VISIBLE_COPY_LIMITS.totalPixels;
    VISIBLE_COPY_LIMITS.totalPixels = 10;
    try { await expect(inspectVisibleCopy(data, settings)).rejects.toThrow('500 megapixel'); } finally { VISIBLE_COPY_LIMITS.totalPixels = limit; }
    const bytes = VISIBLE_COPY_LIMITS.encodedBytes; VISIBLE_COPY_LIMITS.encodedBytes = 10;
    try { await expect(createVisibleCopy(data, settings)).rejects.toThrow('120 MB'); } finally { VISIBLE_COPY_LIMITS.encodedBytes = bytes; }
    const outputBytes = VISIBLE_COPY_LIMITS.outputBytes; VISIBLE_COPY_LIMITS.outputBytes = 10;
    try { await expect(createVisibleCopy(data, settings)).rejects.toThrow('128 MB'); } finally { VISIBLE_COPY_LIMITS.outputBytes = outputBytes; }
    await expect(createVisibleCopy(data, { ...settings, quality: 101 })).rejects.toThrow('quality');
    await expect(createVisibleCopy(data, settings, { previewPage: 99 })).rejects.toThrow('preview page');
  });

  it('cancels between pages and releases private documents without partial results', async () => {
    const data = await fixture(), before = data.slice(), controller = new AbortController(), destroy = vi.spyOn(mupdf.PDFDocument.prototype, 'destroy');
    try {
      await expect(createVisibleCopy(data, settings, { signal: controller.signal, onProgress: progress => { if (progress.phase === 'render' && progress.completed === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(destroy).toHaveBeenCalled(); expect(data).toEqual(before);
    } finally { destroy.mockRestore(); }
  });

  it('refuses XFA and malformed rendering resources instead of returning incomplete pixels', async () => {
    const data = await fixture(), pdf = new mupdf.PDFDocument(data), trailer = pdf.getTrailer(), form = trailer.get('Root', 'AcroForm'), value = pdf.newString('XFA_SECRET');
    try { form.put('XFA', value); await expect(createVisibleCopy(save(pdf), settings)).rejects.toThrow('XFA'); }
    finally { value.destroy(); form.destroy(); trailer.destroy(); pdf.destroy(); }
    const broken = new mupdf.PDFDocument(), page = broken.addPage([0, 0, 72, 72], 0, {}, '/MissingImage Do'); broken.insertPage(-1, page); page.destroy();
    try { await expect(createVisibleCopy(save(broken), settings)).rejects.toThrow('renderer reported'); } finally { broken.destroy(); }
  });

  it('removes covered, invisible, clipped and hidden-layer content, annotations, scripts and attachments from the new object graph', async () => {
    const source = hiddenFixture(), result = await createVisibleCopy(source, settings);
    expect(pixels(result.data)).toEqual(pixels(source));
    const doc = new mupdf.PDFDocument(result.data), page = doc.loadPage(0), text = page.toStructuredText(''), trailer = doc.getTrailer(), catalog = trailer.get('Root');
    try {
      expect(text.asText().trim()).toBe(''); expect(page.getAnnotations()).toHaveLength(0); expect(doc.countLayers()).toBe(0);
      for (const name of ['Info', 'Metadata', 'Names', 'OpenAction', 'AcroForm', 'OCProperties', 'Outlines']) { const value = catalog.get(name); try { expect(value.isNull(), name).toBe(true); } finally { value.destroy(); } }
      for (let n = 1; n < doc.countObjects(); n++) {
        const ref = doc.newIndirect(n), object = ref.resolve();
        try {
          expect(object.toString()).not.toContain('SECRET');
          if (object.isStream()) { const data = object.readStream(); try { expect(new TextDecoder().decode(data.asUint8Array())).not.toContain('SECRET'); } finally { data.destroy(); } }
        } finally { object.destroy(); ref.destroy(); }
      }
    } finally { catalog.destroy(); trailer.destroy(); text.destroy(); page.destroy(); doc.destroy(); }
  });

  it('documents why native vector replay is not a visible-only copy', () => {
    // Native replay omits a hidden OCG, but it retains white-covered, alpha=0
    // and ignored OCR text as recoverable PDF text. Raster output is deliberate.
    const source = new mupdf.PDFDocument(hiddenFixture()), page = source.loadPage(0), output = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(output, 'pdf', '');
    try {
      const device = writer.beginPage(page.getBounds()); try { page.run(device, mupdf.Matrix.identity); device.close(); } finally { device.destroy(); }
      writer.endPage(); writer.close();
      const copy = new mupdf.PDFDocument(output), next = copy.loadPage(0), text = next.toStructuredText('');
      try { for (const secret of ['COVERED_SECRET', 'ALPHA_SECRET', 'OCR_SECRET']) expect(text.asText()).toContain(secret); expect(text.asText()).not.toContain('OCG_SECRET'); }
      finally { text.destroy(); next.destroy(); copy.destroy(); }
    } finally { writer.destroy(); output.destroy(); page.destroy(); source.destroy(); }
  });

  it('keeps only the displayed appearance of a field with an undisplayed value and a hidden widget', async () => {
    const lib = await PDFDocument.create(), page = lib.addPage([180, 120]), field = lib.getForm().createTextField('Internal field name');
    field.setText('PUBLIC'); field.addToPage(page, { x: 15, y: 50, width: 140, height: 25 });
    const hidden = lib.getForm().createTextField('Hidden'); hidden.setText('HIDDEN_WIDGET_SECRET'); hidden.addToPage(page, { x: 15, y: 10, width: 140, height: 25 });
    const source = new mupdf.PDFDocument(await lib.save()), nativePage = source.loadPage(0), widgets = nativePage.getWidgets();
    try {
      const first = widgets[0].getObject(), value = source.newString('UNDISPLAYED_FIELD_SECRET'), second = widgets[1].getObject();
      let displayed: ReturnType<typeof pixels>;
      try { second.put('F', 2); displayed = pixels(save(source)); first.put('V', value); } finally { second.destroy(); value.destroy(); first.destroy(); }
      const original = save(source), result = await createVisibleCopy(original, settings);
      expect(pixels(result.data)).toEqual(displayed);
      const copy = await PDFDocument.load(result.data); expect(copy.getForm().getFields()).toHaveLength(0);
      const document = new mupdf.PDFDocument(result.data); try { const next = document.loadPage(0), text = next.toStructuredText(''); try { expect(text.asText().trim()).toBe(''); } finally { text.destroy(); next.destroy(); } } finally { document.destroy(); }
    } finally { nativePage.destroy(); source.destroy(); }
  });

  it('reports non-embedded substitute fonts without rejecting a renderable document', async () => {
    const pdf = new mupdf.PDFDocument(), font = pdf.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'ExampleUnavailableFont', Encoding: 'WinAnsiEncoding' });
    const page = pdf.addPage([0, 0, 72, 72], 0, { Font: { F: font } }, 'BT /F 12 Tf 5 40 Td (PUBLIC) Tj ET'); pdf.insertPage(-1, page);
    try {
      const result = await createVisibleCopy(save(pdf), settings);
      expect(result.warnings).toEqual([expect.objectContaining({ pageNumber: 1, fontName: 'ExampleUnavailableFont' })]); expect(result.warningsTruncated).toBe(false);
    } finally { page.destroy(); font.destroy(); pdf.destroy(); }
  });

  it('preserves the raster grid for fractional page dimensions', async () => {
    const lib = await PDFDocument.create(), page = lib.addPage([73.123, 109.789]); page.drawRectangle({ x: 0, y: 0, width: 73.123, height: 109.789, color: rgb(.7, .4, .2) }); page.drawText('Grid', { x: 5.123, y: 60.789, size: 13 });
    const source = await lib.save(), result = await createVisibleCopy(source, settings), original = pixels(source), output = pixels(result.data);
    expect([output.width, output.height]).toEqual([original.width, original.height]);
    // CropBox boundary antialiasing can affect its final partial pixel; interior
    // pixels must map 1:1 rather than being rescaled to the rounded bitmap size.
    for (let y = 0; y < output.height - 1; y++) for (let x = 0; x < output.width - 1; x++) {
      const offset = (y * output.width + x) * 3;
      expect(output.data.subarray(offset, offset + 3)).toEqual(original.data.subarray(offset, offset + 3));
    }
  });

  it('reports signed fields without a page widget and copies their visible pages without retaining signature data', async () => {
    const pdf = new mupdf.PDFDocument(await fixture()), trailer = pdf.getTrailer(), form = trailer.get('Root', 'AcroForm'), fields = form.get('Fields'), signature = pdf.newString('SIGNATURE_BYTES_SECRET');
    try {
      const field = pdf.addObject({ FT: 'Sig', V: { Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: signature } }); try { fields.push(field); } finally { field.destroy(); }
      const data = save(pdf), inspection = await inspectVisibleCopy(data, settings), result = await createVisibleCopy(data, settings, { previewPage: 1 });
      expect(inspection.hasSignatures).toBe(true);
      const fresh = await PDFDocument.load(result.data); expect(fresh.getForm().getFields()).toHaveLength(0);
      // Detection is disclosure only: no cryptographic signature validation occurs.
    } finally { signature.destroy(); fields.destroy(); form.destroy(); trailer.destroy(); pdf.destroy(); }
  });

  it('rejects encrypted inputs and repaired files, and honors cancellation after final verification', async () => {
    const source = await fixture(), native = new mupdf.PDFDocument(source);
    try {
      const encrypted = native.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner');
      try { await expect(createVisibleCopy(new Uint8Array(encrypted.asUint8Array()), settings)).rejects.toThrow('Unlock'); } finally { encrypted.destroy(); }
    } finally { native.destroy(); }
    const damaged = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >> endobj\n');
    await expect(createVisibleCopy(damaged, settings)).rejects.toThrow(/renderer reported|repair/i);
    const controller = new AbortController();
    await expect(createVisibleCopy(source, settings, { previewPage: 1, signal: controller.signal, onProgress: progress => { if (progress.phase === 'verify' && progress.completed === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('processes a long document with at most one live page bitmap', async () => {
    const document = await PDFDocument.create(); for (let index = 0; index < 100; index++) document.addPage([36, 36]);
    const original = mupdf.PDFPage.prototype.toPixmap;
    let active = 0, peak = 0;
    const rendering = vi.spyOn(mupdf.PDFPage.prototype, 'toPixmap').mockImplementation(function (this: mupdf.PDFPage, ...args) {
      expect(active).toBe(0);
      const bitmap = original.apply(this, args), release = bitmap.destroy.bind(bitmap);
      active++; peak = Math.max(peak, active);
      bitmap.destroy = () => { active--; release(); };
      return bitmap;
    });
    try {
      const result = await createVisibleCopy(await document.save(), settings);
      expect(result.pageCount).toBe(100); expect(result.encodedImageBytes).toBeLessThan(1_000_000);
      expect(peak).toBe(1); expect(active).toBe(0);
    } finally { rendering.mockRestore(); }
  });
});
