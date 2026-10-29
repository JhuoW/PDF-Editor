import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPDFBookmarks, inspectPDFBookmarks, type PDFBookmarkDefinition, type PDFBookmarkDraft } from '../../src/core/PDFBookmarks';
import { encryptPDF, ALL_PDF_PERMISSIONS } from '../../src/core/PDFEncryption';
const key = PDFName.of;
const def = (title: string, extra: Partial<PDFBookmarkDefinition> = {}): PDFBookmarkDefinition => ({ title, target: { type: 'page', pageNumber: 1, view: 'Fit' }, bold: false, italic: false, color: '#000000', expanded: true, ...extra });
const draft = (title: string, extra: Partial<PDFBookmarkDefinition> = {}, children: PDFBookmarkDraft[] = []): PDFBookmarkDraft => ({ id: `draft-${title.replace(/[^a-z0-9]/gi, '') || 'unicode'}`, definition: def(title, extra), children });
const save = (pdf: PDFDocument) => pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
async function base() {
 const pdf = await PDFDocument.create(); pdf.setTitle('Preserved document');
 for (let i = 0; i < 3; i++) pdf.addPage([400, 600]).drawText(`Page ${i + 1}`, { x: 20, y: 560 });
 pdf.getForm().createTextField('Contact').setText('Current value');
 return pdf;
}
async function fixture() {
 const pdf = await base(), root = pdf.context.obj({ Type: 'Outlines', Count: 4 }), rootRef = pdf.context.register(root);
 const first = pdf.context.obj({ Title: PDFHexString.fromText('原始章节'), Dest: PDFString.of('chapter'), Count: 1, F: 2, C: [.2, .4, .8], CustomRecord: PDFString.of('keep me') }), firstRef = pdf.context.register(first);
 const child = pdf.context.obj({ Title: PDFString.of('Child'), Dest: [pdf.getPage(2).ref, 'FitR', 20, 100, 200, 400] }), childRef = pdf.context.register(child);
 const web = pdf.context.obj({ Title: PDFString.of('Website'), A: { S: 'URI', URI: PDFString.of('/help') } }), webRef = pdf.context.register(web);
 const script = pdf.context.obj({ Title: PDFString.of('Unknown action'), A: { S: 'JavaScript', JS: PDFString.of('app.alert("never run")') } }), scriptRef = pdf.context.register(script);
 root.set(key('First'), firstRef); root.set(key('Last'), scriptRef);
 first.set(key('Parent'), rootRef); first.set(key('Next'), webRef); first.set(key('First'), childRef); first.set(key('Last'), childRef);
 child.set(key('Parent'), firstRef); web.set(key('Parent'), rootRef); web.set(key('Prev'), firstRef); web.set(key('Next'), scriptRef); script.set(key('Parent'), rootRef); script.set(key('Prev'), webRef);
 pdf.catalog.set(key('Outlines'), rootRef); pdf.catalog.set(key('URI'), pdf.context.obj({ Base: PDFString.of('https://example.com/docs/') }));
 pdf.catalog.set(key('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('chapter'), [pdf.getPage(1).ref, 'XYZ', null, 520, null]] } }));
 return { pdf, root, rootRef, first, firstRef, child, childRef, web, webRef, script, scriptRef };
}
function pixels(bytes: Uint8Array) { const pdf = new mupdf.PDFDocument(bytes), page = pdf.loadPage(0), pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true); try { return new Uint8Array(pix.getPixels()); } finally { pix.destroy(); page.destroy(); pdf.destroy(); } }
function stripped(tree: PDFBookmarkDraft[]): PDFBookmarkDraft[] { return tree.map(item => ({ id: item.id, definition: structuredClone(item.definition), children: stripped(item.children) })); }

describe('native PDF bookmarks', () => {
 it('inspects named, direct, relative URI and unsupported actions without guessing destinations', async () => {
  const { pdf } = await fixture(), report = await inspectPDFBookmarks(await save(pdf));
  expect(report.canEdit).toBe(true); expect(report.bookmarks).toHaveLength(3);
  expect(report.bookmarks[0].definition).toMatchObject({ title: '原始章节', bold: true, color: '#3366cc', target: { type: 'page', pageNumber: 2, view: 'XYZ', x: null, y: 80, zoom: null } });
  expect(report.bookmarks[0].namedDestination).toBe('chapter'); expect(report.bookmarks[0].children[0].definition.target).toMatchObject({ pageNumber: 3, view: 'FitR', rect: { x: 20, y: 200, width: 180, height: 300 } });
  expect(report.bookmarks[1].definition.target).toEqual({ type: 'url', url: 'https://example.com/help' });
  expect(report.bookmarks[2]).toMatchObject({ editable: false, movable: true, removable: true }); expect(report.bookmarks[2].unsupportedReason).toMatch(/unsupported|additional|JavaScript/);
 });
 it('creates Unicode hierarchy with correct counts, actual refs and independent reader navigation, without changing pages or forms', async () => {
  const source = await save(await base());
  const tree = [draft('Heading', { target: null, expanded: false }, [draft('中文章节', { title: '中文章节', target: { type: 'page', pageNumber: 3, view: 'XYZ', x: 25, y: 60, zoom: 1.5 }, bold: true, italic: true, color: '#ff0000' }, [draft('Nested', { target: { type: 'url', url: 'mailto:test@example.com' } })])]), draft('Second')];
  const output = await applyPDFBookmarks(source, tree), result = await inspectPDFBookmarks(output), pdf = await PDFDocument.load(output), root = pdf.catalog.lookup(key('Outlines'), PDFDict), first = root.lookup(key('First'), PDFDict), child = first.lookup(key('First'), PDFDict);
  expect(result.bookmarks[0].children[0].definition.title).toBe('中文章节'); expect(first.lookup(key('Count'), PDFNumber).asNumber()).toBe(-2); expect(root.lookup(key('Count'), PDFNumber).asNumber()).toBe(2);
  expect(child.lookup(key('F'), PDFNumber).asNumber()).toBe(3); expect(child.lookup(key('Dest'), PDFArray).get(0).toString()).toBe(pdf.getPage(2).ref.toString());
  expect(pdf.getTitle()).toBe('Preserved document'); expect(pdf.getForm().getTextField('Contact').getText()).toBe('Current value'); expect(pixels(output)).toEqual(pixels(source));
  const native = new mupdf.PDFDocument(output); try { const outline = native.loadOutline()!; expect(outline[0].down![0].title).toBe('中文章节'); expect(native.resolveLink(outline[0].down![0].uri!)).toBe(2); } finally { native.destroy(); }
 });
 it('reorders, promotes and edits styles while preserving surviving refs, named targets and unknown actions', async () => {
  const { pdf, firstRef, childRef, scriptRef } = await fixture(), source = await save(pdf), report = await inspectPDFBookmarks(source), tree = stripped(report.bookmarks), child = tree[0].children.pop()!;
  tree[0].definition.title = '重命名'; tree[0].definition.italic = true;
  const output = await applyPDFBookmarks(source, [tree[2], child, tree[0], tree[1]], { expectedRevision: report.revision }), after = await PDFDocument.load(output), root = after.catalog.lookup(key('Outlines'), PDFDict);
  expect(root.get(key('First'))!.toString()).toBe(scriptRef.toString());
  expect(after.context.lookup(firstRef, PDFDict).lookup(key('Dest'), PDFString).decodeText()).toBe('chapter');
  expect(after.context.lookup(firstRef, PDFDict).lookup(key('CustomRecord'), PDFString).decodeText()).toBe('keep me');
  expect(after.context.lookup(childRef, PDFDict).get(key('Parent'))!.toString()).toBe(after.catalog.get(key('Outlines'))!.toString());
  expect(after.context.lookup(scriptRef, PDFDict).lookup(key('A'), PDFDict).lookup(key('JS'), PDFString).decodeText()).toBe('app.alert("never run")');
  expect((await inspectPDFBookmarks(output)).bookmarks[2].definition.title).toBe('重命名');
 });
 it('deletes complete subtrees and removes unreachable titles while preserving unrelated entries', async () => {
  const { pdf } = await fixture(), source = await save(pdf), report = await inspectPDFBookmarks(source), output = await applyPDFBookmarks(source, stripped(report.bookmarks.slice(1)));
  expect((await inspectPDFBookmarks(output)).bookmarks.map(item => item.definition.title)).toEqual(['Website', 'Unknown action']);
  const after = await PDFDocument.load(output); expect(after.context.enumerateIndirectObjects().some(([, value]) => value instanceof PDFDict && value.lookup(key('Title')) instanceof PDFString && (value.lookup(key('Title')) as PDFString).decodeText() === 'Child')).toBe(false);
  const empty = await applyPDFBookmarks(output, []); expect((await PDFDocument.load(empty)).catalog.has(key('Outlines'))).toBe(false);
 });
 it.each([0, 90, 180, 270])('round-trips all destination modes with CropBox/UserUnit and rotation %i', async rotation => {
  const pdf = await base(), page = pdf.getPage(1); page.setCropBox(30, 40, 300, 500); page.setRotation(degrees(rotation)); page.node.set(key('UserUnit'), PDFNumber.of(2));
  const modes = ['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'] as const;
  const tree = modes.map(view => draft(view, { target: { type: 'page', pageNumber: 2, view, x: 80, y: 100, zoom: 1.25, rect: { x: 20, y: 30, width: 200, height: 400 } } }));
  const output = await applyPDFBookmarks(await save(pdf), tree), result = await inspectPDFBookmarks(output);
  expect(result.pages[1]).toMatchObject({ width: 600, height: 1000, rotation });
  result.bookmarks.forEach((item, index) => { expect(item.definition.target).toMatchObject({ pageNumber: 2, view: modes[index] }); });
  expect(result.bookmarks[0].definition.target).toMatchObject({ x: 80, y: 100, zoom: 1.25 }); expect(result.bookmarks[7].definition.target).toMatchObject({ rect: { x: 20, y: 30, width: 200, height: 400 } });
 });
 it('keeps no-op bytes exact and rejects old revisions even for an unchanged tree', async () => {
  const { pdf } = await fixture(), source = await save(pdf), report = await inspectPDFBookmarks(source);
  expect(await applyPDFBookmarks(source, stripped(report.bookmarks), { expectedRevision: report.revision })).toEqual(source);
  await expect(applyPDFBookmarks(source, stripped(report.bookmarks), { expectedRevision: 'old' })).rejects.toThrow(/changed/);
 });
 it('rejects invalid definitions, stale IDs, duplicates and cyclic drafts atomically', async () => {
  const source = await save(await base()), copy = new Uint8Array(source);
  for (const tree of [[draft('')], [draft('BadURL', { target: { type: 'url', url: 'javascript:alert(1)' } })], [draft('MissingPage', { target: { type: 'page', pageNumber: 99, view: 'Fit' } })], [{ ...draft('Stale'), id: 'old-id' }], [draft('Dup'), draft('Dup')]]) await expect(applyPDFBookmarks(source, tree)).rejects.toThrow();
  const cyclic = draft('Cycle'); cyclic.children.push(cyclic); await expect(applyPDFBookmarks(source, [cyclic])).rejects.toThrow(); expect(source).toEqual(copy);
 });
 it('preserves readonly actions, refuses editing them, and protects structure-linked nodes from deletion', async () => {
  const { pdf, child } = await fixture(); child.set(key('SE'), pdf.context.register(pdf.context.obj({ Type: 'StructElem', S: 'Sect' })));
  const source = await save(pdf), report = await inspectPDFBookmarks(source), tree = stripped(report.bookmarks);
  expect(report.bookmarks[0].children[0]).toMatchObject({ editable: false, movable: false, removable: false });
  tree[2].definition.title = 'Cannot change'; await expect(applyPDFBookmarks(source, tree)).rejects.toThrow(/unsupported|additional|JavaScript/);
  await expect(applyPDFBookmarks(source, [])).rejects.toThrow(/structure/);
 });
 it('rejects cyclic, shared and broken parent or sibling native trees', async () => {
  for (const damage of ['cycle', 'parent', 'previous', 'last']) {
   const { pdf, root, first, firstRef, web, rootRef } = await fixture();
   if (damage === 'cycle') first.set(key('Next'), firstRef); if (damage === 'parent') first.set(key('Parent'), firstRef); if (damage === 'previous') web.set(key('Prev'), rootRef); if (damage === 'last') root.set(key('Last'), firstRef);
   await expect(inspectPDFBookmarks(await save(pdf))).rejects.toThrow(/bookmark|processed safely/);
  }
 });
 it('reports signed and XFA documents readonly before any rewrite and rejects encrypted input and aborts', async () => {
  for (const kind of ['signed', 'xfa']) {
   const pdf = await base(); if (kind === 'signed') pdf.catalog.set(key('Perms'), pdf.context.obj({ DocMDP: { Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('0102') } })); else pdf.catalog.lookup(key('AcroForm'), PDFDict).set(key('XFA'), PDFString.of('packet'));
   const source = await save(pdf), report = await inspectPDFBookmarks(source); expect(report.canEdit).toBe(false); await expect(applyPDFBookmarks(source, [draft('New')])).rejects.toThrow(/Signed|XFA/);
  }
  const source = await save(await base()), encrypted = await encryptPDF(new Uint8Array(source).buffer, { userPassword: 'secret', ownerPassword: 'owner', permissions: ALL_PDF_PERMISSIONS });
  await expect(inspectPDFBookmarks(encrypted)).rejects.toThrow(/Unlock/);
  const controller = new AbortController(); controller.abort(); await expect(inspectPDFBookmarks(source, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
 });
});
