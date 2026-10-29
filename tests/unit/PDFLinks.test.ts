import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPDFLinks, inspectPDFLinks, type PDFLinkDefinition, type PDFLinkTarget, type PDFLinkView } from '../../src/core/PDFLinks';
import { encryptPDF, ALL_PDF_PERMISSIONS } from '../../src/core/PDFEncryption';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';

const key = PDFName.of, buffer = (value: Uint8Array) => new Uint8Array(value).buffer;
function addLink(pdf: PDFDocument, pageNumber: number, properties: Record<string, unknown>) {
  const page = pdf.getPage(pageNumber - 1), annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 480, 120, 500], Border: [0, 0, 0], P: page.ref, ...properties }), ref = pdf.context.register(annotation);
  const annots = page.node.Annots() ?? pdf.context.obj([]); annots.push(ref); page.node.set(key('Annots'), annots); return { annotation, ref };
}
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.setTitle('Keep metadata'); pdf.setAuthor('原作者');
  const first = pdf.addPage([400, 600]); first.drawText('Original content', { x: 30, y: 540, size: 18 }); first.drawRectangle({ x: 30, y: 250, width: 80, height: 60, color: rgb(0.1, 0.3, 0.8) });
  const second = pdf.addPage([500, 700]); second.setCropBox(50, 70, 300, 450); second.setRotation(degrees(90)); second.node.set(key('UserUnit'), PDFNumber.of(2)); second.drawText('Target page', { x: 80, y: 450, size: 12 });
  pdf.addPage([400, 600]).drawText('Last page', { x: 30, y: 540, size: 18 });
  const field = pdf.getForm().createTextField('Preserved'); field.setText('Field value'); field.addToPage(first, { x: 30, y: 70, width: 160, height: 25 });
  const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [200, 400, 224, 424], Contents: PDFHexString.fromText('便签内容'), T: PDFHexString.fromText('作者') })); first.node.Annots()!.push(note);
  const outlines = pdf.context.obj({ Type: 'Outlines', Count: 1 }), outlinesRef = pdf.context.register(outlines), item = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Last page bookmark'), Parent: outlinesRef, Dest: [pdf.getPage(2).ref, 'Fit'] })); outlines.set(key('First'), item); outlines.set(key('Last'), item); pdf.catalog.set(key('Outlines'), outlinesRef);
  pdf.catalog.set(key('Metadata'), pdf.context.register(pdf.context.stream('<xmp>KEEP XML</xmp>', { Type: 'Metadata', Subtype: 'XML' })));
  await pdf.attach(new Uint8Array([0, 1, 99, 255]), '附件.bin', { mimeType: 'application/octet-stream' });
  return pdf;
}
async function save(pdf: PDFDocument) { return new Uint8Array(await pdf.save({ useObjectStreams: false, updateFieldAppearances: false })); }
const link = (target: PDFLinkTarget = { type: 'url', url: 'https://example.com/a' }, extra: Partial<PDFLinkDefinition> = {}): PDFLinkDefinition => ({ pageNumber: 1, rect: { x: 30, y: 100, width: 90, height: 20 }, target, border: { width: 0, color: '#123456', style: 'solid' }, description: '链接说明', ...extra });
function raster(data: Uint8Array, pageNumber: number) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(pageNumber - 1), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return Buffer.from(pixmap.getPixels()); } finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}

describe('native PDF links', () => {
  it('creates native URL/mail/internal links while preserving page pixels, fields, notes, metadata, attachments and bookmarks', async () => {
    const pdf = await fixture(), original = await save(pdf), copy = new Uint8Array(original), initial = await inspectPDFLinks(original);
    const targets: PDFLinkTarget[] = [{ type: 'url', url: 'https://example.com/中文?q=a%20b' }, { type: 'url', url: 'mailto:test@example.com?subject=Hello' }, { type: 'page', pageNumber: 3, view: 'Fit' }];
    const result = await applyPDFLinks(original, targets.map((target, index) => ({ type: 'create', definition: link(target, { rect: { x: 30, y: 100 + index * 40, width: 90, height: 20 } }) })), { expectedRevision: initial.revision });
    const inspection = await inspectPDFLinks(result); expect(inspection.links).toHaveLength(3); expect(inspection.links.every(item => item.editable)).toBe(true); expect(inspection.links[0].definition!.target).toEqual({ type: 'url', url: 'https://example.com/%E4%B8%AD%E6%96%87?q=a%20b' });
    for (const page of [1, 2, 3]) expect(raster(result, page).equals(raster(original, page))).toBe(true);
    const reopened = await PDFDocument.load(result, { updateMetadata: false }); expect(reopened.getForm().getTextField('Preserved').getText()).toBe('Field value'); expect(reopened.getForm().getFields()[0].ref.toString()).toBe(pdf.getForm().getFields()[0].ref.toString());
    expect(reopened.getTitle()).toBe('Keep metadata'); expect(reopened.getAuthor()).toBe('原作者'); expect(reopened.catalog.has(key('Outlines'))).toBe(true); expect(reopened.catalog.has(key('Metadata'))).toBe(true); expect(reopened.catalog.lookup(key('Names'), PDFDict).has(key('EmbeddedFiles'))).toBe(true);
    const native = new mupdf.PDFDocument(result), page = native.loadPage(0), links = page.getLinks(); try { expect(links).toHaveLength(3); expect(links.map(item => item.getURI()).join(' ')).toContain('mailto:test@example.com'); expect(native.resolveLink(links.find(item => !item.isExternal())!)).toBe(2); } finally { links.forEach(item => item.destroy()); page.destroy(); native.destroy(); }
    expect(Buffer.from(original).equals(Buffer.from(copy))).toBe(true);
  });
  it.each(['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'] as PDFLinkView[])('writes actual PageRef and roundtrips %s in CropBox/UserUnit coordinates', async view => {
    const pdf = await fixture(), original = await save(pdf), target: PDFLinkTarget = { type: 'page', pageNumber: 2, view, x: 80, y: 140, zoom: 1.5, rect: { x: 40, y: 60, width: 260, height: 240 } };
    const result = await applyPDFLinks(original, [{ type: 'create', definition: link(target, { pageNumber: 2, rect: { x: 80, y: 180, width: 160, height: 40 }, border: { color: '#0099cc', style: 'underline', width: 2 } }) }]);
    const report = await inspectPDFLinks(result), definition = report.links[0].definition!; expect(definition.pageNumber).toBe(2); expect(definition.rect).toEqual({ x: 80, y: 180, width: 160, height: 40 }); expect(definition.target).toMatchObject({ type: 'page', pageNumber: 2, view }); expect(definition.border).toEqual({ width: 2, color: '#0099cc', style: 'underline' });
    const parsed = await PDFDocument.load(result, { updateMetadata: false }), annotation = parsed.getPage(1).node.Annots()!.lookup(0, PDFDict), dest = annotation.lookup(key('Dest'), PDFArray);
    expect(dest.get(0).toString()).toBe(parsed.getPage(1).ref.toString()); expect(annotation.lookup(key('Rect'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber())).toEqual([90, 410, 170, 430]);
    if (view === 'XYZ') expect(dest.asArray().slice(2).map(value => (value as PDFNumber).asNumber())).toEqual([90, 450, 1.5]);
    if (view === 'FitR') expect(definition.target).toMatchObject({ rect: target.rect });
  });
  it('resolves old destinations, nested name trees, GoTo, relative URI.Base and null XYZ coordinates', async () => {
    const pdf = await fixture(); pdf.catalog.set(key('Dests'), pdf.context.obj({ OldName: [pdf.getPage(2).ref, 'Fit'] }));
    pdf.catalog.set(key('Names'), pdf.context.obj({ Dests: { Kids: [{ Names: [PDFHexString.fromText('中文目标'), { D: [pdf.getPage(1).ref, 'XYZ', null, 450, null] }] }] } }));
    pdf.catalog.set(key('URI'), pdf.context.obj({ Base: PDFString.of('https://example.com/docs/') }));
    addLink(pdf, 1, { Dest: key('OldName') }); addLink(pdf, 1, { A: { S: 'GoTo', D: PDFHexString.fromText('中文目标') } }); addLink(pdf, 1, { A: { S: 'URI', URI: PDFString.of('../help?q=yes') } });
    const data = await save(pdf), report = await inspectPDFLinks(data); expect(report.links.map(item => item.namedDestination)).toEqual(['OldName', '中文目标', undefined]);
    expect(report.links[1].definition!.target).toEqual({ type: 'page', pageNumber: 2, view: 'XYZ', x: null, y: 140, zoom: null }); expect(report.links[2].definition!.target).toEqual({ type: 'url', url: 'https://example.com/help?q=yes' });
    const updated = await applyPDFLinks(data, [{ type: 'update', id: report.links[1].id, definition: { ...report.links[1].definition!, description: 'Updated independently' } }]);
    const parsed = await PDFDocument.load(updated, { updateMetadata: false }), current = await inspectPDFLinks(updated); expect(current.links[1].namedDestination).toBeUndefined(); expect(parsed.catalog.lookup(key('Names'), PDFDict).has(key('Dests'))).toBe(true); expect(current.links[0].namedDestination).toBe('OldName');
  });
  it('clones only a selected shared annotation occurrence and action, including page Annots aliasing', async () => {
    const pdf = await fixture(), action = pdf.context.register(pdf.context.obj({ S: 'URI', URI: PDFString.of('https://shared.example/') }));
    const { ref, annotation } = addLink(pdf, 1, { A: action, CustomMetadata: PDFHexString.fromText('KEEP PRIVATE'), F: 4, H: 'O' });
    const shared = pdf.context.obj([ref, ref]); pdf.getPage(0).node.set(key('Annots'), shared); pdf.getPage(2).node.set(key('Annots'), shared);
    const data = await save(pdf), report = await inspectPDFLinks(data), selected = report.links[0]; expect(report.links).toHaveLength(4);
    const updated = await applyPDFLinks(data, [{ type: 'update', id: selected.id, definition: { ...selected.definition!, target: { type: 'url', url: 'https://changed.example/' } } }]);
    const next = await inspectPDFLinks(updated); expect(next.links[0].definition!.target).toEqual({ type: 'url', url: 'https://changed.example/' }); expect(next.links.slice(1).every(item => item.definition!.target.type === 'url' && item.definition!.target.url === 'https://shared.example/')).toBe(true);
    const parsed = await PDFDocument.load(updated, { updateMetadata: false }), changed = parsed.getPage(0).node.Annots()!.lookup(0, PDFDict); expect(changed.lookup(key('CustomMetadata'), PDFHexString).decodeText()).toBe('KEEP PRIVATE'); expect(changed.get(key('H'))).toBe(key('O')); expect(changed.lookup(key('F'), PDFNumber).asNumber()).toBe(4);
    expect(annotation.lookup(key('A'), PDFDict).lookup(key('URI'), PDFString).decodeText()).toBe('https://shared.example/');
    const removed = await applyPDFLinks(updated, [{ type: 'remove', id: next.links[0].id }]); expect((await inspectPDFLinks(removed)).links).toHaveLength(3);
  });
  it('keeps unsupported actions, AP/QuadPoints and locked links read-only but permits deleting just one occurrence', async () => {
    const pdf = await fixture(), script = pdf.context.register(pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('doNotRun()') }));
    addLink(pdf, 1, { A: script }); addLink(pdf, 1, { A: { S: 'URI', URI: PDFString.of('https://example.com/'), Next: script } });
    addLink(pdf, 1, { Dest: [pdf.getPage(2).ref, 'Fit'], QuadPoints: [30, 500, 120, 500, 30, 480, 120, 480] }); addLink(pdf, 1, { Dest: [pdf.getPage(2).ref, 'Fit'], F: 128 });
    const data = await save(pdf), report = await inspectPDFLinks(data); expect(report.links).toHaveLength(4); expect(report.links.every(item => !item.editable && item.removable)).toBe(true);
    await expect(applyPDFLinks(data, [{ type: 'update', id: report.links[0].id, definition: link() }])).rejects.toThrow();
    const removed = await applyPDFLinks(data, [{ type: 'remove', id: report.links[0].id }]), next = await inspectPDFLinks(removed); expect(next.links).toHaveLength(3); expect(next.links[0].unsupportedReason).toContain('Chained');
    const parsed = await PDFDocument.load(removed, { updateMetadata: false }), preserved = parsed.context.lookup(script, PDFDict); expect(preserved.lookup(key('JS'), PDFString).decodeText()).toBe('doNotRun()');
  });
  it('moves an existing link across UserUnit pages while retaining visible border width and unrelated fields', async () => {
    const pdf = await fixture(); addLink(pdf, 1, { A: { S: 'URI', URI: PDFString.of('https://example.com/') }, BS: { W: 2, S: 'D', D: [8, 3] }, C: [0.2, 0.4, 0.6] });
    const data = await save(pdf), report = await inspectPDFLinks(data), item = report.links[0], definition = { ...item.definition!, pageNumber: 2, rect: { x: 100, y: 200, width: 150, height: 50 } };
    const output = await applyPDFLinks(data, [{ type: 'update', id: item.id, definition }]), after = await inspectPDFLinks(output); expect(after.links[0].definition!.border!.width).toBe(2); expect(after.links[0].pageNumber).toBe(2);
    const parsed = await PDFDocument.load(output, { updateMetadata: false }), bs = parsed.getPage(1).node.Annots()!.lookup(0, PDFDict).lookup(key('BS'), PDFDict); expect(bs.lookup(key('W'), PDFNumber).asNumber()).toBe(1); expect(bs.lookup(key('D'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber())).toEqual([4, 1.5]); expect(parsed.getForm().getTextField('Preserved').getText()).toBe('Field value');
  });
  it('preserves legacy dash arrays when editing border width and keeps structure-linked annotations explicitly read-only', async () => {
    const pdf = await fixture(); addLink(pdf, 1, { A: { S: 'URI', URI: PDFString.of('https://dash.example/'), IsMap: false }, Border: [0, 0, 1, [8, 3]] });
    const tagged = addLink(pdf, 1, { A: { S: 'URI', URI: PDFString.of('https://tagged.example/') }, StructParent: 10 });
    const structure = pdf.context.register(pdf.context.obj({ Type: 'StructElem', S: 'Link', K: { Type: 'OBJR', Obj: tagged.ref } })); pdf.catalog.set(key('StructTreeRoot'), pdf.context.obj({ Type: 'StructTreeRoot', K: [structure] }));
    const original = await save(pdf), copy = new Uint8Array(original), report = await inspectPDFLinks(original); expect(report.links[0].editable).toBe(true); expect(report.links[1].editable).toBe(false); expect(report.links[1].removable).toBe(false); expect(report.links[1].unsupportedReason).toContain('structure tree');
    await expect(applyPDFLinks(original, [{ type: 'remove', id: report.links[1].id }])).rejects.toThrow(/structure/); expect(Buffer.from(original).equals(Buffer.from(copy))).toBe(true);
    const value = report.links[0].definition!, output = await applyPDFLinks(original, [{ type: 'update', id: report.links[0].id, definition: { ...value, border: { ...value.border!, width: 3 } } }]);
    const parsed = await PDFDocument.load(output, { updateMetadata: false }), changed = parsed.getPage(0).node.Annots()!.lookup(2, PDFDict), dash = changed.lookup(key('BS'), PDFDict).lookup(key('D'), PDFArray);
    expect(dash.asArray().map(value => (value as PDFNumber).asNumber())).toEqual([8, 3]);
    expect(parsed.context.lookup(structure, PDFDict).lookup(key('K'), PDFDict).get(key('Obj'))!.toString()).toBe(tagged.ref.toString());
  });
  it('rejects orphan page refs, missing/ambiguous named destinations and out-of-range destination positions without guessing page one', async () => {
    const pdf = await fixture(), orphan = pdf.context.register(pdf.context.obj({ Type: 'Page', MediaBox: [0, 0, 400, 600] }));
    addLink(pdf, 1, { Dest: [orphan, 'Fit'] }); addLink(pdf, 1, { Dest: PDFString.of('Missing') }); addLink(pdf, 1, { Dest: [pdf.getPage(1).ref, 'XYZ', 0, 9999, null] });
    pdf.catalog.set(key('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('Duplicate'), [pdf.getPage(0).ref, 'Fit'], PDFString.of('Duplicate'), [pdf.getPage(2).ref, 'Fit']] } })); addLink(pdf, 1, { Dest: PDFString.of('Duplicate') });
    const report = await inspectPDFLinks(await save(pdf)); expect(report.links.every(item => !item.editable)).toBe(true); expect(report.links.map(item => item.unsupportedReason).join(' ')).toMatch(/page tree|visible target page/);
  });
  it('validates revision, bounds and action input before any native save, and preserves no-op bytes', async () => {
    const data = await save(await fixture()), report = await inspectPDFLinks(data), writer = vi.spyOn(mupdf.PDFDocument.prototype, 'saveToBuffer');
    try {
      await expect(applyPDFLinks(data, [{ type: 'create', definition: link() }], { expectedRevision: 'stale' })).rejects.toThrow(/changed after/);
      await expect(applyPDFLinks(data, [{ type: 'create', definition: link({ type: 'url', url: 'javascript:alert(1)' }) }])).rejects.toThrow(/protocol/);
      await expect(applyPDFLinks(data, [{ type: 'create', definition: link(undefined, { rect: { x: 390, y: 100, width: 90, height: 20 } }) }])).rejects.toThrow(/inside/);
      await expect(applyPDFLinks(data, [{ type: 'create', definition: link({ type: 'page', pageNumber: 99, view: 'Fit' }) }])).rejects.toThrow(/invalid page/);
      expect(writer).not.toHaveBeenCalled(); expect(Buffer.from(await applyPDFLinks(data, [], { expectedRevision: report.revision })).equals(Buffer.from(data))).toBe(true);
    } finally { writer.mockRestore(); }
  });
  it.each(['signature', 'XFA'] as const)('reports %s sources read-only and refuses changes', async kind => {
    const pdf = await fixture(); if (kind === 'XFA') pdf.catalog.lookup(key('AcroForm'), PDFDict).set(key('XFA'), pdf.context.register(pdf.context.stream('<xfa/>')));
    else pdf.catalog.set(key('Perms'), pdf.context.obj({ DocMDP: pdf.context.register(pdf.context.obj({ Type: 'Sig', Contents: PDFHexString.of('1234'), ByteRange: [0, 1, 2, 3] })) }));
    const data = await save(pdf), report = await inspectPDFLinks(data); expect(report.canEdit).toBe(false); await expect(applyPDFLinks(data, [{ type: 'create', definition: link() }])).rejects.toThrow(/Signed|XFA/); expect(Buffer.from(await applyPDFLinks(data, [])).equals(Buffer.from(data))).toBe(true);
  });
  it('rejects locked/damaged input and supports cancellation before or after processing', async () => {
    const data = await save(await fixture()), encrypted = await encryptPDF(buffer(data), { userPassword: 'read', ownerPassword: 'owner', permissions: { ...ALL_PDF_PERMISSIONS } });
    await expect(inspectPDFLinks(encrypted)).rejects.toThrow(/Unlock/); await expect(inspectPDFLinks(new TextEncoder().encode('%PDF-1.7\nbroken'))).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); await expect(applyPDFLinks(data, [], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const end = new AbortController(); await expect(applyPDFLinks(data, [{ type: 'create', definition: link() }], { signal: end.signal, onProgress: value => { if (value.completed === value.total) end.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('keeps existing batch watermark resources manageable after link creation and removal', async () => {
    const original = await applyPageDecorations(buffer(await save(await fixture())), [{ type: 'create', definition: { kind: 'watermark', name: 'Keep mark', pages: [1], opacity: 0.3, layer: 'background', angle: 0, position: { anchor: 'center', offsetX: 0, offsetY: 0 }, content: { type: 'text', text: 'MANAGED', fontFamily: 'Helvetica', fontSize: 20, color: '#555555' } } }]);
    const before = await inspectPageDecorations(buffer(original)), linked = await applyPDFLinks(original, [{ type: 'create', definition: link() }]), links = await inspectPDFLinks(linked), removed = await applyPDFLinks(linked, [{ type: 'remove', id: links.links[0].id }]);
    const after = await inspectPageDecorations(buffer(removed)); expect(after.decorations[0].managed).toBe(true); expect(after.decorations[0].id).toBe(before.decorations[0].id); expect(raster(removed, 1).equals(raster(original, 1))).toBe(true);
  });
});
