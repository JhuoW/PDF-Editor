import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { assertPageManagementSource, cropPDFPages, duplicatePDFPages, replacePDFPages, resetPageCrop } from '../../src/core/PageManagement';
import { resolvePDFLinkDestination } from '../../src/core/PDFLinkDestinations';

const buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
const key = PDFName.of;
async function fixture(prefix = 'ORIGINAL') {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${prefix} title`);
  const pages = [pdf.addPage([200, 300]), pdf.addPage([210, 310]), pdf.addPage([220, 320])];
  pages.forEach((page, index) => page.drawText(`${prefix} PAGE ${index + 1}`, { x: 10, y: 200, size: 10 }));
  const field = pdf.getForm().createTextField('Name'); field.setText(`${prefix} form`);
  field.addToPage(pages[1], { x: 10, y: 40, width: 120, height: 20 });
  const link = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 100, 80, 120], Dest: [pages[1].ref, 'Fit'] });
  pages[0].node.set(key('Annots'), pdf.context.obj([pdf.context.register(link)]));
  const outline = pdf.context.obj({ Type: 'Outlines' }), outlineRef = pdf.context.register(outline);
  const item = pdf.context.obj({ Title: PDFString.of('SECOND PAGE'), Parent: outlineRef, Dest: [pages[1].ref, 'Fit'] }), itemRef = pdf.context.register(item);
  outline.set(key('First'), itemRef); outline.set(key('Last'), itemRef); outline.set(key('Count'), PDFNumber.of(1));
  pdf.catalog.set(key('Outlines'), outlineRef);
  return { pdf, pages, itemRef };
}
function pageTexts(bytes: Uint8Array) {
  const pdf = new mupdf.PDFDocument(bytes);
  try { return Array.from({ length: pdf.countPages() }, (_, index) => {
    const page = pdf.loadPage(index), text = page.toStructuredText('');
    try { return text.asText(); } finally { text.destroy(); page.destroy(); }
  }); } finally { pdf.destroy(); }
}

describe('high-priority page management', () => {
  it('duplicates selected pages in their requested order with independent forms and the original catalog', async () => {
    const { pdf } = await fixture(), original = buffer(await pdf.save());
    const modified = await duplicatePDFPages(original, [3, 2], 2), loaded = await PDFDocument.load(modified);
    expect(loaded.getTitle()).toBe('ORIGINAL title');
    expect(loaded.getPages().map(page => page.getWidth())).toEqual([200, 220, 210, 210, 220]);
    expect(loaded.getForm().getFields().map(field => field.getName())).toEqual(['Name', 'Name_2']);
    loaded.getForm().getTextField('Name_2').setText('COPY ONLY');
    expect(loaded.getForm().getTextField('Name').getText()).toBe('ORIGINAL form');
    expect(pageTexts(modified).map(text => /ORIGINAL PAGE (\d)/.exec(text)?.[1])).toEqual(['1', '3', '2', '2', '3']);
    expect((await PDFDocument.load(original)).getPageCount()).toBe(3);
  });

  it('keeps duplicated links to unselected original pages and copies self-links to the new occurrence', async () => {
    const { pdf, pages } = await fixture();
    const self = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 150, 80, 170], Dest: [pages[0].ref, 'Fit'] });
    pages[0].node.Annots()!.push(pdf.context.register(self));
    const copied = await PDFDocument.load(await duplicatePDFPages(buffer(await pdf.save()), [1], 0));
    const destinations = copied.getPage(3).node.Annots()!.asArray().map(raw => {
      const annotation = copied.context.lookup(raw, PDFDict);
      return resolvePDFLinkDestination(copied, annotation.get(key('Dest')))?.pageNumber;
    });
    expect(destinations).toEqual([2, 4]);
    const original = copied.getPage(0).node.Annots()!.lookup(0, PDFDict);
    expect(resolvePDFLinkDestination(copied, original.get(key('Dest')))?.pageNumber).toBe(2);
  });

  it('replaces native page contents and fields while retaining existing incoming links, bookmarks and metadata', async () => {
    const target = await fixture(), donor = await fixture('REPLACEMENT');
    const previousRef = target.pages[1].ref.toString();
    const result = await replacePDFPages(buffer(await target.pdf.save()), [2], buffer(await donor.pdf.save()), [2]);
    const loaded = await PDFDocument.load(result);
    expect(loaded.getPages().map(page => page.getWidth())).toEqual([200, 210, 220]);
    expect(loaded.getTitle()).toBe('ORIGINAL title');
    expect(loaded.getPage(1).ref.toString()).toBe(previousRef);
    expect(pageTexts(result)[1]).toContain('REPLACEMENT PAGE 2');
    expect(pageTexts(result)[1]).not.toContain('ORIGINAL PAGE 2');
    expect(loaded.getForm().getFields().map(field => field.getName())).toEqual(['Name']);
    const widget = loaded.getForm().getTextField('Name').acroField.getWidgets()[0];
    expect(widget.P()).toBe(loaded.getPage(1).ref);
    expect(loaded.getForm().getTextField('Name').getText()).toBe('REPLACEMENT form');
    const firstLink = loaded.getPage(0).node.Annots()!.lookup(0, PDFDict);
    expect(resolvePDFLinkDestination(loaded, firstLink.get(key('Dest')))?.pageNumber).toBe(2);
    const outline = loaded.catalog.lookup(key('Outlines'), PDFDict), first = outline.lookup(key('First'), PDFDict);
    expect(resolvePDFLinkDestination(loaded, first.get(key('Dest')))?.pageNumber).toBe(2);
  });

  it('replaces nonconsecutive slots in the selected pairing order and rebinds donor internal links', async () => {
    const target = await fixture(), donor = await fixture('REPLACEMENT');
    const result = await replacePDFPages(buffer(await target.pdf.save()), [3, 1], buffer(await donor.pdf.save()), [1, 2]);
    const loaded = await PDFDocument.load(result), link = loaded.getPage(2).node.Annots()!.lookup(0, PDFDict);
    expect(resolvePDFLinkDestination(loaded, link.get(key('Dest')))?.pageNumber).toBe(1);
    expect(pageTexts(result).map(text => /(?:REPLACEMENT|ORIGINAL) PAGE (\d)/.exec(text)?.[0])).toEqual(['REPLACEMENT PAGE 2', 'ORIGINAL PAGE 2', 'REPLACEMENT PAGE 1']);
    expect(loaded.getForm().getFields().map(field => field.getName())).toEqual(['Name', 'Name_2']);
  });

  it.each([
    [0, { x: 30, y: 35, width: 130, height: 220 }],
    [90, { x: 15, y: 40, width: 140, height: 210 }],
    [180, { x: 20, y: 25, width: 130, height: 220 }],
    [270, { x: 25, y: 30, width: 140, height: 210 }],
  ] as const)('crops physical visible-edge margins on Rotate %i and UserUnit 2', async (rotation, expected) => {
    const pdf = await PDFDocument.create(), first = pdf.addPage([200, 300]); pdf.addPage([200, 300]);
    first.setCropBox(10, 20, 160, 240); first.setRotation(degrees(rotation)); first.node.set(key('UserUnit'), PDFNumber.of(2));
    first.drawText('RETAIN HIDDEN CONTENT', { x: 0, y: 5, size: 8 });
    const source = buffer(await pdf.save());
    const result = await cropPDFPages(source, [1], { top: 10, right: 20, bottom: 30, left: 40 });
    const loaded = await PDFDocument.load(result);
    expect(loaded.getPage(0).getCropBox()).toEqual(expected);
    expect(loaded.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 200, height: 300 });
    expect(loaded.getPage(0).getRotation().angle).toBe(rotation);
    expect(loaded.getPage(1).getCropBox()).toEqual({ x: 0, y: 0, width: 200, height: 300 });
    const reset = await resetPageCrop(buffer(result), [1]), restored = await PDFDocument.load(reset);
    expect(restored.getPage(0).getCropBox()).toEqual(restored.getPage(0).getMediaBox());
    expect(pageTexts(reset)[0]).toContain('RETAIN HIDDEN CONTENT');
  });

  it('uses inherited CropBox and Rotate values without changing sibling page geometry', async () => {
    const pdf = await PDFDocument.create(), first = pdf.addPage([200, 300]), second = pdf.addPage([200, 300]);
    const parent = first.node.lookup(key('Parent'), PDFDict);
    parent.set(key('CropBox'), pdf.context.obj([10, 20, 170, 260])); parent.set(key('Rotate'), PDFNumber.of(90));
    for (const page of [first, second]) { page.node.delete(key('CropBox')); page.node.delete(key('Rotate')); }
    const result = await cropPDFPages(buffer(await pdf.save()), [1], { top: 10, right: 20, bottom: 30, left: 40 });
    const loaded = await PDFDocument.load(result);
    expect(loaded.getPage(0).getCropBox()).toEqual({ x: 20, y: 60, width: 120, height: 180 });
    expect(loaded.getPage(1).getCropBox()).toEqual({ x: 10, y: 20, width: 160, height: 240 });
  });

  it('rejects invalid selections, replacement counts and empty crop areas without modifying source bytes', async () => {
    const { pdf } = await fixture(), source = buffer(await pdf.save()), before = new Uint8Array(source).slice();
    for (const pages of [[], [0], [4], [1, 1], [1.5]]) {
      await expect(duplicatePDFPages(source, pages, 0)).rejects.toThrow('valid page numbers');
      await expect(cropPDFPages(source, pages, { top: 0, right: 0, bottom: 0, left: 0 })).rejects.toThrow('valid page numbers');
    }
    await expect(duplicatePDFPages(source, [1], 5)).rejects.toThrow('insertion position');
    await expect(replacePDFPages(source, [1], source, [1, 2])).rejects.toThrow('same number');
    await expect(cropPDFPages(source, [1], { top: 300, right: 0, bottom: 0, left: 0 })).rejects.toThrow('no visible area');
    await expect(cropPDFPages(source, [1], { top: NaN, right: 0, bottom: 0, left: 0 })).rejects.toThrow('nonnegative');
    expect(new Uint8Array(source)).toEqual(before);
  });

  it.each(['xfa', 'signature', 'dangling'] as const)('rejects unsupported %s source objects before changing pages', async kind => {
    const { pdf } = await fixture();
    if (kind === 'xfa') pdf.catalog.getOrCreateAcroForm().dict.set(key('XFA'), PDFString.of('unsupported'));
    if (kind === 'signature') pdf.catalog.set(key('Perms'), pdf.context.obj({ DocMDP: pdf.context.obj({ Type: 'Sig' }) }));
    if (kind === 'dangling') pdf.catalog.set(key('Dangling'), PDFRef.of(999999));
    const source = buffer(await pdf.save({ updateFieldAppearances: false }));
    await expect(assertPageManagementSource(source)).rejects.toThrow(kind === 'xfa' ? 'XFA' : kind === 'signature' ? 'Signed' : 'dangling');
    await expect(resetPageCrop(source, [1])).rejects.toThrow();
  });
});
