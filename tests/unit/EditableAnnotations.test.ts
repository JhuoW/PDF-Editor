import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFHexString, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { exportPDFPages } from '../../src/core/PageExport';
import { serializeAnnotationsToPDF } from '../../src/annotations/AnnotationSerializer';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';
import { createFreeTextAnnotation, createInkAnnotation, createRectangleAnnotation, createHighlightAnnotation, createImageAnnotation } from '../../src/store/annotationStore';
import { createFreeTextAppearance } from '../../src/annotations/FreeTextAppearance';
import { addNativeAnnotation, annotationBounds } from '../../src/annotations/NativeAnnotation';
import type { Annotation, FreeTextAnnotation } from '../../src/annotations/types';

async function source() { const document = await PDFDocument.create(); document.addPage([400, 600]); return new Uint8Array(await document.save()).buffer; }
function pixels(bytes: Uint8Array) { const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true); try { return new Uint8Array(pixmap.getPixels()); } finally { pixmap.destroy(); page.destroy(); doc.destroy(); } }
function text(bytes: Uint8Array) { const doc = new mupdf.PDFDocument(bytes), page = doc.loadPage(0), result = page.toStructuredText(''); try { return result.asText(); } finally { result.destroy(); page.destroy(); doc.destroy(); } }

describe('editable native annotation round trips', () => {
  it('preserves native types, exact appearances and editing properties through save/reopen/save', async () => {
    const free = createFreeTextAnnotation(1, [20, 430, 240, 80], 'Hello 中文 BOLD');
    free.richContent = [{ text: 'Hello 中文 ', style: {} }, { text: 'BOLD', style: { fontWeight: 'bold', color: '#ff0000', fontSize: 20, highlightColor: '#ffff00', textDecoration: 'underline' } }];
    free.rotation = 12;
    const rectangle = createRectangleAnnotation(1, [20, 100, 50, 50], '#123456', 2, '#abcdef');
    const ink = createInkAnnotation(1, [[[10, 200], [30, 220], [80, 190]]], '#ff0000', 3);
    const markup = createHighlightAnnotation(1, [[10, 300, 110, 300, 10, 280, 110, 280]], '#ffff00', .4, 'Highlight');
    const input = new Map<number, Annotation[]>([[1, [free, rectangle, ink, markup]]]);
    const first = await serializeAnnotationsToPDF(await source(), input);
    const painted = pixels(first);
    let yellow = 0; for (let index = 0; index < painted.length; index += 3) if (painted[index] > 240 && painted[index + 1] > 240 && painted[index + 2] < 20) yellow++;
    expect(yellow).toBeGreaterThan(100);
    const pdf = await PDFDocument.load(first), page = pdf.getPage(0);
    expect(page.node.Annots()!.size()).toBe(4);
    expect(page.node.Contents()).toBeUndefined();
    expect(page.node.Annots()!.asArray().map(ref => pdf.context.lookup(ref, PDFDict).lookup(PDFName.of('Subtype'))?.toString()))
      .toEqual(['/FreeText', '/Square', '/Ink', '/Highlight']);
    const plain = await exportPDFPages(first, { format: 'text', range: '', dpi: 150, quality: 90, fileName: 'annotations.pdf' });
    expect(new TextDecoder().decode(plain.data)).toContain('Hello 中文 BOLD');
    const imported = await importEditableAnnotations(new Uint8Array(first).buffer);
    expect(imported.annotations.get(1)?.map(annotation => annotation.type)).toEqual(['freetext', 'rectangle', 'ink', 'highlight']);
    const reopened = imported.annotations.get(1)![0] as FreeTextAnnotation;
    expect(reopened.content).toBe(free.content); expect(reopened.richContent).toEqual(free.richContent); expect(reopened.rotation).toBe(12);
    const second = await serializeAnnotationsToPDF(imported.data, imported.annotations);
    expect(pixels(second)).toEqual(pixels(first));
    expect((await PDFDocument.load(second)).getPage(0).node.Annots()!.size()).toBe(4);
    reopened.content = '再次编辑 Edited'; reopened.richContent = undefined;
    const changed = await serializeAnnotationsToPDF(imported.data, imported.annotations, { flattenAnnotations: true });
    expect(text(changed)).toContain('再次编辑 Edited'); expect(text(changed)).not.toContain('BOLD');
  });
  it('keeps modified external appearances untouched instead of resurrecting stale text metadata', async () => {
    const free = createFreeTextAnnotation(1, [20, 100, 200, 80], 'Original');
    const output = await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]));
    const pdf = await PDFDocument.load(output), annotation = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
    annotation.set(PDFName.of('Contents'), PDFHexString.fromText('External change'));
    const edited = new Uint8Array(await pdf.save()).buffer;
    const imported = await importEditableAnnotations(edited);
    expect(imported.annotations.size).toBe(0);
    expect(imported.data).toBe(edited);
  });
  it('exports Chinese and rich text as searchable glyphs in explicit flattened copies', async () => {
    const free = createFreeTextAnnotation(1, [20, 200, 210, 20], 'Normal 红色 Bold\nSecond line');
    free.richContent = [{ text: 'Normal ', style: {} }, { text: '红色 Bold\nSecond line', style: { color: '#ff0000', fontWeight: 'bold', fontSize: 18 } }];
    const output = await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]), { flattenAnnotations: true });
    expect(text(output)).toContain('Normal 红色 Bold'); expect(text(output)).toContain('Second line');
    const pdf = await PDFDocument.load(output);
    const fonts = pdf.context.enumerateIndirectObjects().map(([, object]) => object instanceof PDFDict ? object.lookup(PDFName.of('BaseFont'))?.toString() : '').filter(Boolean);
    expect(fonts.some(font => /Bold/.test(font!))).toBe(true);
    const stream = pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream);
    expect(stream.length).toBeGreaterThan(0);
    expect((await importEditableAnnotations(new Uint8Array(output).buffer)).annotations.size).toBe(0);
  });
  it('restores inserted images without losing crop and rotation', async () => {
    const image = createImageAnnotation(1, [50, 50, 80, 60], 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 1, 1);
    image.rotation = 30; image.flipHorizontal = true; image.cropBounds = { top: 10, right: 20, bottom: 5, left: 5 };
    const bytes = await serializeAnnotationsToPDF(await source(), new Map([[1, [image]]]));
    const imported = await importEditableAnnotations(new Uint8Array(bytes).buffer);
    expect(imported.annotations.get(1)?.[0]).toMatchObject({ type: 'image', rotation: 30, flipHorizontal: true, cropBounds: image.cropBounds, imageData: image.imageData });
    expect(pixels(await serializeAnnotationsToPDF(imported.data, imported.annotations))).toEqual(pixels(bytes));
  });
  it('does not import an appearance whose nested drawing resource was changed externally', async () => {
    const free = createFreeTextAnnotation(1, [20, 100, 200, 80], 'Sensitive original');
    const output = await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]));
    const pdf = await PDFDocument.load(output), annotation = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
    const appearance = annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream);
    const resources = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);
    const child = pdf.context.lookup(resources.entries()[0][1], PDFRawStream);
    // External editors may redact inside a Form XObject without changing the
    // outer annotation Contents or the top-level `/Fm Do` appearance stream.
    child.dict.set(PDFName.of('Resources'), pdf.context.obj({}));
    const changed = new Uint8Array(await pdf.save()).buffer;
    const imported = await importEditableAnnotations(changed);
    expect(imported.annotations.size).toBe(0); expect(imported.data).toBe(changed);
  });

  it('preserves a forged metadata appearance instead of injecting its unsafe rich styles into the editor', async () => {
    const free = createFreeTextAnnotation(1, [20, 100, 200, 80], 'Safe visible text');
    const output = await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]));
    const pdf = await PDFDocument.load(output), page = pdf.getPage(0);
    const old = page.node.Annots()!.lookup(0, PDFDict), appearance = old.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef;
    page.node.delete(PDFName.of('Annots'));
    free.richContent = [{ text: free.content, style: { fontFamily: 'Arial" onclick="alert(1)' } }];
    await addNativeAnnotation(pdf, page, free, appearance, annotationBounds(free));
    const malicious = new Uint8Array(await pdf.save()).buffer;
    const imported = await importEditableAnnotations(malicious);
    expect(imported.annotations.size).toBe(0); expect(imported.data).toBe(malicious);
  });

  it('allows deleting overflow text while keeping the expanded box and every remaining glyph', async () => {
    const free = createFreeTextAnnotation(1, [30, 490, 260, 30], Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n'));
    const appearance = await createFreeTextAppearance(free);
    const top = free.rect[1] + free.rect[3];
    free.rect = [30, top - appearance.height, 260, appearance.height];
    expect(free.rect[1]).toBeLessThan(0);
    await expect(serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]))).rejects.toThrow('Text exceeds the page height');
    free.content = 'Corrected 中文';
    const output = await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]), { flattenAnnotations: true });
    expect(text(output).trim()).toBe('Corrected 中文');
    const imported = await importEditableAnnotations(new Uint8Array(await serializeAnnotationsToPDF(await source(), new Map([[1, [free]]]))).buffer);
    expect((imported.annotations.get(1)?.[0] as FreeTextAnnotation).rect[3]).toBe(appearance.height);
  });

});
