import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream, degrees, drawObject } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { cleanPDF, inspectPDFCleanup, type CleanupOptions } from '../../src/core/DocumentCleanup';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';

const k = PDFName.of, bytes = (value: Uint8Array) => new Uint8Array(value).buffer;
const selection = (options: Partial<CleanupOptions>): CleanupOptions => ({ metadata: false, attachments: false, activeContent: false, comments: false, links: false, forms: false, privateData: false, ...options });
const all = selection({ metadata: true, attachments: true, activeContent: true, comments: true, links: true, forms: true, privateData: true });
const save = async (pdf: PDFDocument) => bytes(await pdf.save({ updateFieldAppearances: false, useObjectStreams: false }));
const xml = (pdf: PDFDocument, text: string) => pdf.context.register(pdf.context.flateStream(`<private>${text}</private>`, { Type: 'Metadata', Subtype: 'XML' }));
async function base() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 500]); page.setCropBox(20, 30, 340, 440); page.setRotation(degrees(90)); page.node.set(k('UserUnit'), PDFNumber.of(2));
  page.drawText('VISIBLE BODY STAYS', { x: 50, y: 400, size: 18 }); pdf.addPage([300, 400]).drawText('SECOND PAGE', { x: 30, y: 300, size: 14 });
  const text = pdf.getForm().createTextField('Customer'); text.setText('CURRENT_VALUE_70913'); text.acroField.dict.set(k('DV'), PDFString.of('DEFAULT_VALUE_62032'));
  for (const p of pdf.getPages()) text.addToPage(p, { x: 40, y: 200, width: 220, height: 25 }); text.enableReadOnly();
  return pdf;
}
function native(bytes: ArrayBuffer | Uint8Array, showExtras = true) {
  const doc = new mupdf.PDFDocument(new Uint8Array(bytes)), page = doc.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, showExtras), text = page.toStructuredText('');
  try { return { pixels: new Uint8Array(pixmap.getPixels()), text: text.asText() }; }
  finally { text.destroy(); pixmap.destroy(); page.destroy(); doc.destroy(); }
}
function allDecoded(data: Uint8Array) {
  const doc = new mupdf.PDFDocument(data), parts: string[] = []; const visited = new Set<number>();
  const visit = (object: mupdf.PDFObject) => { if (object.isIndirect()) { const ref = object.asIndirect(); if (visited.has(ref)) return; visited.add(ref); } if (object.isString()) parts.push(object.asString()); if (object.isStream()) { const contents = object.readStream(); try { parts.push(new TextDecoder().decode(contents.asUint8Array())); } finally { contents.destroy(); } } if (object.isArray() || object.isDictionary()) object.forEach(value => { try { visit(value); } finally { value.destroy(); } }); };
  const trailer = doc.getTrailer(); try { visit(trailer); return parts.join('\n'); } finally { trailer.destroy(); doc.destroy(); }
}
function attachment(pdf: PDFDocument, text = 'ATTACHMENT_SECRET_86354') {
  const stream = pdf.context.register(pdf.context.flateStream(text, { Type: 'EmbeddedFile', Subtype: 'text/plain' }));
  const specification = pdf.context.register(pdf.context.obj({ Type: 'Filespec', UF: PDFHexString.fromText('报告.txt'), F: PDFString.of('report.txt'), EF: { F: stream, UF: stream } }));
  return { stream, specification };
}
function note(pdf: PDFDocument) {
  const dictionary = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [60, 100, 84, 124], Contents: PDFString.of('COMMENT_SECRET_19245'), T: PDFString.of('Private reviewer'), P: pdf.getPage(0).ref });
  const ref = pdf.context.register(dictionary); pdf.getPage(0).node.addAnnot(ref); return { dictionary, ref };
}
function uriLink(pdf: PDFDocument, value = 'https://example.test/keep') {
  const action = pdf.context.register(pdf.context.obj({ S: 'URI', URI: PDFString.of(value) }));
  const annotation = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 350, 180, 370], A: action, P: pdf.getPage(0).ref })); pdf.getPage(0).node.addAnnot(annotation); return action;
}

describe('native selective document cleanup', () => {
  it('reports and removes file identifiers even when there is no Info or XMP', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); pdf.context.trailerInfo.Info = undefined; pdf.context.trailerInfo.ID = pdf.context.obj([PDFHexString.fromText('ORIGINAL_FILE_ID_72311'), PDFHexString.fromText('REVISION_ID_99213')]);
    const data = await save(pdf), report = await inspectPDFCleanup(data); expect(report.counts.metadata).toBe(1); expect(report.findings[0].label).toBe('Original file identifiers');
    const output = await cleanPDF(data, selection({ metadata: true })); expect(output.report.counts.metadata).toBe(0); const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.context.trailerInfo.ID).toBeUndefined(); expect(reopened.context.trailerInfo.Info).toBeUndefined(); expect(allDecoded(output.data)).not.toContain('ORIGINAL_FILE_ID');
  });
  it('removes actual saved page thumbnails and their bytes while preserving visible content', async () => {
    const pdf = await base(), image = pdf.context.register(pdf.context.flateStream(new Uint8Array([255, 0, 0]), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })); pdf.getPage(0).node.set(k('Thumb'), image);
    const data = await save(pdf), report = await inspectPDFCleanup(data); expect(report.findings.some(item => item.category === 'privateData' && item.label === 'Saved page thumbnail' && item.pages.includes(1))).toBe(true);
    const output = await cleanPDF(data, selection({ privateData: true })); expect(output.report.counts.privateData).toBe(0); expect(Buffer.from(native(output.data).pixels).equals(Buffer.from(native(data).pixels))).toBe(true);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.getPage(0).node.has(k('Thumb'))).toBe(false); expect(reopened.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFRawStream && object.dict.lookup(k('Subtype')) === k('Image'))).toBe(false);
  });
  it.each(['Metadata', 'Private', 'AF', 'AA', 'OpenAction', 'ByteRange', 'A', 'Next'])('preserves a legal font resource named %s', async resourceName => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([250, 200]), font = await pdf.embedFont(StandardFonts.CourierBold);
    page.node.set(k('Resources'), pdf.context.obj({ Font: { [resourceName]: font.ref } }));
    page.node.set(k('Contents'), pdf.context.register(pdf.context.flateStream(`BT /${resourceName} 18 Tf 20 150 Td (VISIBLE BODY iii) Tj ET`)));
    const data = await save(pdf), report = await inspectPDFCleanup(data); expect(report.hasSignatures).toBe(false); expect(report.counts.attachments).toBe(0); expect(report.counts.activeContent).toBe(0);
    const output = await cleanPDF(data, all); expect(Buffer.from(native(output.data).pixels).equals(Buffer.from(native(data).pixels))).toBe(true);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.getPage(0).node.Resources()!.lookup(k('Font'), PDFDict).has(k(resourceName))).toBe(true);
  });
  it('retains image resources named Metadata instead of deleting their visible pixels', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([100, 100]), bitmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false);
    let png: Uint8Array; try { bitmap.getPixels().set([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]); png = new Uint8Array(bitmap.asPNG()); } finally { bitmap.destroy(); }
    const image = await pdf.embedPng(png); page.node.set(k('Resources'), pdf.context.obj({ XObject: { Metadata: image.ref } })); page.node.set(k('Contents'), pdf.context.register(pdf.context.flateStream('q 100 0 0 100 0 0 cm /Metadata Do Q')));
    const data = await save(pdf), output = await cleanPDF(data, all); expect([...native(output.data).pixels.slice(0, 3)]).toEqual([0, 0, 255]); expect(Buffer.from(native(output.data).pixels).equals(Buffer.from(native(data).pixels))).toBe(true);
  });
  it('preserves Type3 glyph names, appearance state names, legacy destinations and structure class maps', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([200, 200]);
    const glyph = pdf.context.register(pdf.context.flateStream('1000 0 d0 0 0 1 rg 0 0 1000 1000 re f'));
    const font = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { Metadata: glyph }, Encoding: { Type: 'Encoding', Differences: [65, 'Metadata'] }, FirstChar: 65, LastChar: 65, Widths: [1000], Resources: {} }));
    page.node.set(k('Resources'), pdf.context.obj({ Font: { Glyphs: font } })); page.node.set(k('Contents'), pdf.context.register(pdf.context.flateStream('BT /Glyphs 50 Tf 10 140 Td (A) Tj ET')));
    const appearance = pdf.context.register(pdf.context.flateStream('1 0 0 rg 0 0 30 30 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 30, 30], Resources: {} }));
    const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', T: PDFString.of('kept checkbox'), Rect: [20, 20, 50, 50], P: page.ref, V: 'Metadata', AS: 'Metadata', AP: { N: { Metadata: appearance, AA: appearance, ByteRange: appearance } } })); page.node.addAnnot(widget); pdf.catalog.set(k('AcroForm'), pdf.context.obj({ Fields: [widget] }));
    pdf.catalog.set(k('Dests'), pdf.context.obj({ Metadata: [page.ref, 'Fit'], ByteRange: [page.ref, 'Fit'] }));
    pdf.catalog.set(k('StructTreeRoot'), pdf.context.obj({ Type: 'StructTreeRoot', RoleMap: { Private: 'P', A: 'Span' }, ClassMap: { AF: { O: 'Layout', Placement: 'Block' } } }));
    const data = await save(pdf), report = await inspectPDFCleanup(data); expect(report.hasSignatures).toBe(false);
    const output = await cleanPDF(data, selection({ metadata: true, privateData: true, attachments: true, activeContent: true })); expect(Buffer.from(native(output.data).pixels).equals(Buffer.from(native(data).pixels))).toBe(true);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.catalog.lookup(k('Dests'), PDFDict).has(k('Metadata'))).toBe(true); expect(reopened.catalog.lookup(k('StructTreeRoot'), PDFDict).lookup(k('ClassMap'), PDFDict).has(k('AF'))).toBe(true);
  });
  it('scans reachable nested metadata/private data and reports actual optional-content groups without mutating bytes', async () => {
    const pdf = await base(); pdf.setTitle('PRIVATE_TITLE_71891'); pdf.catalog.set(k('Metadata'), xml(pdf, 'CATALOG_XMP_41712')); pdf.getPage(0).node.set(k('Metadata'), xml(pdf, 'PAGE_XMP_33017'));
    const form = pdf.context.register(pdf.context.flateStream('1 0 0 rg 50 50 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 500], Resources: {}, Metadata: xml(pdf, 'XOBJECT_XMP_55912') }));
    pdf.getPage(0).pushOperators(drawObject(pdf.getPage(0).node.newXObject('Artwork', form)));
    pdf.catalog.set(k('PieceInfo'), pdf.context.obj({ Vendor: { Private: PDFString.of('APP_PRIVATE_11923') } }));
    pdf.catalog.set(k('OCProperties'), pdf.context.obj({ OCGs: [pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden layer') }))] }));
    const data = await save(pdf), copy = data.slice(0), report = await inspectPDFCleanup(data);
    const widgetRefs = pdf.getForm().getTextField('Customer').acroField.getWidgets().map(widget => pdf.context.getObjectRef(widget.dict)?.toString());
    expect(report.canClean).toBe(true); expect(report.counts.metadata).toBeGreaterThanOrEqual(4); expect(report.counts.privateData).toBeGreaterThan(0); expect(report.limitations.join(' ')).toContain('1 optional-content group'); expect(data).toEqual(copy);
    const output = await cleanPDF(data, selection({ metadata: true, privateData: true }), { expectedRevision: report.revision });
    expect(output.report.counts.metadata).toBe(0); expect(output.report.counts.privateData).toBe(0); expect(native(output.data).pixels).toEqual(native(data).pixels);
    const decoded = allDecoded(output.data); for (const secret of ['PRIVATE_TITLE_71891', 'CATALOG_XMP_41712', 'PAGE_XMP_33017', 'XOBJECT_XMP_55912', 'APP_PRIVATE_11923']) expect(decoded).not.toContain(secret);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.context.trailerInfo.Info).toBeUndefined(); expect(reopened.getForm().getTextField('Customer').getText()).toBe('CURRENT_VALUE_70913'); expect(reopened.catalog.has(k('OCProperties'))).toBe(true);
    expect(reopened.getForm().getTextField('Customer').acroField.getWidgets().map(widget => reopened.context.getObjectRef(widget.dict)?.toString())).toEqual(widgetRefs);
  });
  it('removes all attachment carriers, aliases, nested name trees and file-attachment popups while preserving destinations', async () => {
    const pdf = await base(), attached = attachment(pdf), other = attachment(pdf, 'OTHER_FILE_SECRET_00219');
    const leaf = pdf.context.register(pdf.context.obj({ Names: [PDFString.of('alias1'), attached.specification, PDFString.of('alias2'), attached.specification] }));
    pdf.catalog.set(k('Names'), pdf.context.obj({ EmbeddedFiles: { Kids: [leaf, pdf.context.register(pdf.context.obj({ Names: [PDFString.of('same filename'), other.specification] }))] }, Dests: { Names: [PDFString.of('chapter'), [pdf.getPage(1).ref, 'Fit']] } }));
    pdf.catalog.set(k('AF'), pdf.context.obj([attached.specification])); pdf.getPage(1).node.set(k('AF'), pdf.context.obj([attached.specification, other.specification]));
    const file = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [50, 60, 70, 80], FS: attached.specification }));
    const popup = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [50, 60, 100, 100], Parent: file })); pdf.context.lookup(file, PDFDict).set(k('Popup'), popup); pdf.getPage(0).node.addAnnot(file); pdf.getPage(0).node.addAnnot(popup);
    const output = await cleanPDF(await save(pdf), selection({ attachments: true }));
    expect(output.report.counts.attachments).toBe(0); expect(allDecoded(output.data)).not.toContain('ATTACHMENT_SECRET'); expect(allDecoded(output.data)).not.toContain('OTHER_FILE_SECRET');
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.catalog.lookup(k('Names'), PDFDict).has(k('Dests'))).toBe(true); expect(reopened.getForm().getTextField('Customer').getText()).toBe('CURRENT_VALUE_70913');
  });
  it('handles cyclic attachment name trees without hanging or touching page artwork', async () => {
    const pdf = await base(), attached = attachment(pdf), tree = pdf.context.obj({ Names: [PDFString.of('file'), attached.specification] }), ref = pdf.context.register(tree); tree.set(k('Kids'), pdf.context.obj([ref])); pdf.catalog.set(k('Names'), pdf.context.obj({ EmbeddedFiles: ref }));
    const data = await save(pdf), output = await cleanPDF(data, selection({ attachments: true })); expect(output.report.counts.attachments).toBe(0); expect(native(output.data).pixels).toEqual(native(data).pixels);
  });
  it('removes scripts, event/open actions, action chains and unknown actions while keeping ordinary manual links and bookmarks', async () => {
    const pdf = await base(), script = pdf.context.register(pdf.context.flateStream('JS_SECRET_48129; app.alert("not executed")'));
    const js = pdf.context.register(pdf.context.obj({ S: 'JavaScript', JS: script })); pdf.context.lookup(js, PDFDict).set(k('Next'), js);
    pdf.catalog.set(k('OpenAction'), js); pdf.catalog.set(k('Names'), pdf.context.obj({ JavaScript: { Names: [PDFString.of('startup'), js] } })); pdf.getPage(0).node.set(k('AA'), pdf.context.obj({ O: js }));
    pdf.getForm().getTextField('Customer').acroField.dict.set(k('AA'), pdf.context.obj({ K: js }));
    const normal = uriLink(pdf), goodAction = pdf.context.register(pdf.context.obj({ S: 'GoTo', D: [pdf.getPage(1).ref, 'Fit'], Next: js }));
    const bookmark = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Chapter'), A: goodAction })); pdf.catalog.set(k('Outlines'), pdf.context.obj({ First: bookmark, Last: bookmark, Count: 1 }));
    const unknown = pdf.context.register(pdf.context.obj({ S: 'UnknownExtensionAction', Secret: PDFString.of('UNKNOWN_ACTION_SECRET_23991') })); pdf.getPage(1).node.set(k('A'), unknown);
    const data = await save(pdf), output = await cleanPDF(data, selection({ activeContent: true })); expect(output.report.counts.activeContent).toBe(0); expect(output.report.counts.links).toBeGreaterThan(0); expect(native(output.data).pixels).toEqual(native(data).pixels);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.context.lookup(normal, PDFDict).lookup(k('S'))).toBe(k('URI')); expect(reopened.context.lookup(goodAction, PDFDict).lookup(k('S'))).toBe(k('GoTo')); expect(reopened.context.lookup(goodAction, PDFDict).has(k('Next'))).toBe(false);
    expect(allDecoded(output.data)).not.toContain('JS_SECRET'); expect(allDecoded(output.data)).not.toContain('UNKNOWN_ACTION_SECRET');
  });
  it('removes comments and thread replies while keeping links and widgets', async () => {
    const pdf = await base(), parent = note(pdf); uriLink(pdf);
    pdf.getPage(0).node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [70, 100, 94, 124], Contents: PDFString.of('REPLY_SECRET_22188'), IRT: parent.ref })));
    const output = await cleanPDF(await save(pdf), selection({ comments: true })); expect(output.report.counts.comments).toBe(0); expect(output.report.counts.forms).toBeGreaterThan(0); expect(output.report.counts.links).toBeGreaterThan(0); expect(allDecoded(output.data)).not.toContain('COMMENT_SECRET'); expect(allDecoded(output.data)).not.toContain('REPLY_SECRET');
  });
  it('removes link annotations and URI actions elsewhere while preserving internal bookmarks', async () => {
    const pdf = await base(), uri = uriLink(pdf, 'https://example.test/PRIVATE_URI_39912'), bookmark = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Keep bookmark'), Dest: [pdf.getPage(1).ref, 'Fit'] })); pdf.catalog.set(k('Outlines'), pdf.context.obj({ First: bookmark, Last: bookmark, Count: 1 })); pdf.getPage(1).node.set(k('A'), uri);
    const output = await cleanPDF(await save(pdf), selection({ links: true })); expect(output.report.counts.links).toBe(0); expect(allDecoded(output.data)).not.toContain('PRIVATE_URI'); const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.catalog.has(k('Outlines'))).toBe(true); expect(reopened.getForm().getTextField('Customer').getText()).toBe('CURRENT_VALUE_70913');
  });
  it('removes form widgets, readonly current values, defaults and appearances without flattening answers into page content', async () => {
    const pdf = await base(); note(pdf); uriLink(pdf); const data = await save(pdf), output = await cleanPDF(data, selection({ forms: true })); expect(output.report.counts.forms).toBe(0); expect(output.report.counts.comments).toBeGreaterThan(0); expect(output.report.counts.links).toBeGreaterThan(0);
    expect(allDecoded(output.data)).not.toContain('CURRENT_VALUE_70913'); expect(allDecoded(output.data)).not.toContain('DEFAULT_VALUE_62032'); expect(native(output.data, false).pixels).toEqual(native(data, false).pixels);
    const reopened = await PDFDocument.load(output.data, { updateMetadata: false }); expect(reopened.catalog.has(k('AcroForm'))).toBe(false);
  });
  it('strips known editor management metadata while leaving watermark pixels unchanged', async () => {
    const decorated = await applyPageDecorations(await save(await base()), [{ type: 'create', definition: { kind: 'watermark', name: 'PRIVATE_TEMPLATE_NAME_82188', pages: [1], opacity: 0.4, angle: 30, layer: 'foreground', position: { anchor: 'center', offsetX: 0, offsetY: 0 }, content: { type: 'text', text: 'VISIBLE WATERMARK', fontFamily: 'Helvetica', fontSize: 24, color: '#CC0000' } } }]);
    const output = await cleanPDF(bytes(decorated), selection({ privateData: true })); expect(output.report.counts.privateData).toBe(0); expect(native(output.data).pixels).toEqual(native(decorated).pixels); expect(allDecoded(output.data)).not.toContain('PRIVATE_TEMPLATE_NAME'); expect((await inspectPageDecorations(bytes(output.data))).decorations.every(item => !item.managed)).toBe(true);
  });
  it('fails atomically if a selected payload is retained through an unrecognized alias', async () => {
    const pdf = await base(), metadata = xml(pdf, 'SHARED_METADATA_SECRET_29122'); pdf.catalog.set(k('Metadata'), metadata); pdf.catalog.set(k('UnrecognizedAlias'), metadata); const data = await save(pdf), before = data.slice(0);
    await expect(cleanPDF(data, selection({ metadata: true }))).rejects.toThrow(/also referenced/); expect(data).toEqual(before);
    const attached = attachment(pdf); pdf.catalog.set(k('AF'), pdf.context.obj([attached.specification])); pdf.catalog.set(k('HiddenAttachmentAlias'), attached.specification);
    await expect(cleanPDF(await save(pdf), selection({ attachments: true }))).rejects.toThrow(/also referenced/);
  });
  it('rejects signatures/XFA without silently treating them as empty features', async () => {
    const signed = await base(); signed.catalog.set(k('Perms'), signed.context.obj({ DocMDP: { ByteRange: [0, 10, 20, 30] } })); const signedData = await save(signed), report = await inspectPDFCleanup(signedData); expect(report.hasSignatures).toBe(true); expect(report.canClean).toBe(false); await expect(cleanPDF(signedData, all)).rejects.toThrow(/Signed/);
    const xfa = await base(); xfa.catalog.lookup(k('AcroForm'), PDFDict).set(k('XFA'), xfa.context.register(xfa.context.stream('<xfa>secret</xfa>'))); const xfaData = await save(xfa); expect((await inspectPDFCleanup(xfaData)).hasXfa).toBe(true); await expect(cleanPDF(xfaData, all)).rejects.toThrow(/XFA/);
  });
  it('checks source revision and cancellation without publishing partial output', async () => {
    const data = await save(await base()), original = data.slice(0); await expect(cleanPDF(data, all, { expectedRevision: 'stale' })).rejects.toThrow(/changed after inspection/);
    const controller = new AbortController(); await expect(cleanPDF(data, all, { signal: controller.signal, onProgress: value => { if (value.phase === 'save') controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' }); expect(data).toEqual(original);
  });
  it('verifies complete cleanup independently and garbage-collects unreachable old revisions', async () => {
    const pdf = await base(); note(pdf); uriLink(pdf); pdf.setAuthor('AUTHOR_PRIVATE_37931'); const file = attachment(pdf); pdf.catalog.set(k('AF'), pdf.context.obj([file.specification])); pdf.catalog.set(k('Metadata'), xml(pdf, 'XMP_PRIVATE_87123')); pdf.catalog.set(k('PieceInfo'), pdf.context.obj({ Vendor: { Private: PDFString.of('PIECE_PRIVATE_22918') } }));
    pdf.catalog.set(k('OpenAction'), pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('SCRIPT_PRIVATE_21009') })); pdf.context.register(pdf.context.stream('ORPHAN_PRIVATE_77123'));
    const output = await cleanPDF(await save(pdf), all); expect(Object.values(output.report.counts).every(value => value === 0)).toBe(true);
    const report = await inspectPDFCleanup(bytes(output.data)); expect(Object.values(report.counts).every(value => value === 0)).toBe(true); expect(native(output.data).text).toContain('VISIBLE BODY');
    const decoded = allDecoded(output.data); for (const secret of ['AUTHOR_PRIVATE', 'ATTACHMENT_SECRET', 'XMP_PRIVATE', 'PIECE_PRIVATE', 'SCRIPT_PRIVATE', 'COMMENT_SECRET', 'CURRENT_VALUE', 'DEFAULT_VALUE', 'ORPHAN_PRIVATE']) expect(decoded).not.toContain(secret);
    const independentlyRead = await PDFDocument.load(output.data, { updateMetadata: false });
    for (const [, object] of independentlyRead.context.enumerateIndirectObjects()) if (object instanceof PDFRawStream) expect(new TextDecoder().decode(decodePDFRawStream(object).decode())).not.toContain('ORPHAN_PRIVATE_77123');
  });
  it.each(['Movie', 'Sound', 'RichMedia'])('removes %s annotations and their actual payloads without executing media', async subtype => {
    const pdf = await base(), attached = attachment(pdf, 'MULTIMEDIA_FILE_SECRET_72318');
    const media = subtype === 'Movie' ? { Movie: { F: attached.specification } }
      : subtype === 'Sound' ? { Sound: pdf.context.register(pdf.context.flateStream('SOUND_MEDIA_SECRET_12713', { Type: 'Sound', R: 8000, C: 1, B: 8, E: 'Raw' })) }
      : { RichMediaContent: { Assets: { Names: [PDFString.of('clip'), attached.specification] }, Configurations: [{ Type: 'RichMediaConfiguration', Subtype: 'Video' }] } };
    pdf.getPage(0).node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [30, 80, 90, 140], ...media })));
    const data = await save(pdf), output = await cleanPDF(data, selection({ activeContent: true })); expect(output.report.counts.activeContent).toBe(0); expect(allDecoded(output.data)).not.toContain('MULTIMEDIA_FILE_SECRET'); expect(allDecoded(output.data)).not.toContain('SOUND_MEDIA_SECRET'); expect(Buffer.from(native(output.data, false).pixels).equals(Buffer.from(native(data, false).pixels))).toBe(true);
  });
  it('refuses to erase a shared form appearance that is also used by original page artwork', async () => {
    const pdf = await base(), widget = pdf.getForm().getTextField('Customer').acroField.getWidgets()[0], appearance = widget.dict.lookup(k('AP'), PDFDict).get(k('N'))!;
    pdf.getPage(0).node.newXObject('OriginalArtworkUsesFormAppearance', appearance as import('pdf-lib').PDFRef);
    const data = await save(pdf), original = data.slice(0); await expect(cleanPDF(data, selection({ forms: true }))).rejects.toThrow(/also referenced/); expect(data).toEqual(original);
  });
  it('keeps unknown private properties without claiming arbitrary hidden data was removed', async () => {
    const pdf = await base(); pdf.catalog.set(k('Private'), PDFString.of('UNKNOWN_PRIVATE_PROPERTY_73215')); pdf.catalog.set(k('CustomProducerState'), PDFString.of('CUSTOM_STATE_82919')); pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict).set(k('JS'), PDFString.of('CUSTOM_INFO_PROPERTY_09231'));
    const output = await cleanPDF(await save(pdf), selection({ privateData: true, activeContent: true })); expect(allDecoded(output.data)).toContain('UNKNOWN_PRIVATE_PROPERTY'); expect(allDecoded(output.data)).toContain('CUSTOM_STATE'); expect(allDecoded(output.data)).toContain('CUSTOM_INFO_PROPERTY'); expect(output.report.limitations.join(' ')).toContain('unknown custom properties may remain');
  });
});
