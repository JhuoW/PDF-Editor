import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { inspectPDFBookmarks } from '../../src/core/PDFBookmarks';
import { copyPagesWithForms } from '../../src/core/copyPagesWithForms';
import { deletePages, insertBlankPages, insertPagesFromPDF, mergePDFs, reorderPages, splitPDF } from '../../src/core/PDFManipulator';
const key = PDFName.of, buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
async function fixture(prefix = 'Source') {
 const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage([400, 600]).drawText(`${prefix} page ${i + 1}`);
 const root = pdf.context.obj({ Type: 'Outlines', Count: 3 }), rootRef = pdf.context.register(root);
 const chapter = pdf.context.obj({ Title: PDFHexString.fromText(`${prefix}章节`), Parent: rootRef, Dest: PDFString.of('chapter'), Count: -1, F: 3, C: [1, 0, 0] }), chapterRef = pdf.context.register(chapter);
 const child = pdf.context.obj({ Title: PDFString.of('Child'), Parent: chapterRef, A: { S: 'GoTo', D: [2, 'XYZ', 20, 540, 1.5] } }), childRef = pdf.context.register(child);
 const leaf = pdf.context.obj({ Title: PDFString.of('First page'), Parent: rootRef, Dest: [pdf.getPage(0).ref, 'Fit'] }), leafRef = pdf.context.register(leaf);
 const web = pdf.context.obj({ Title: PDFString.of('Website'), Parent: rootRef, A: { S: 'URI', URI: PDFString.of('/help') } }), webRef = pdf.context.register(web);
 root.set(key('First'), chapterRef); root.set(key('Last'), webRef); chapter.set(key('First'), childRef); chapter.set(key('Last'), childRef); chapter.set(key('Next'), leafRef); leaf.set(key('Prev'), chapterRef); leaf.set(key('Next'), webRef); web.set(key('Prev'), leafRef);
 pdf.catalog.set(key('Outlines'), rootRef); pdf.catalog.set(key('Names'), pdf.context.obj({ Dests: { Names: [PDFString.of('chapter'), [pdf.getPage(1).ref, 'FitH', 560]] } })); pdf.catalog.set(key('URI'), pdf.context.obj({ Base: PDFString.of(`https://${prefix.toLowerCase()}.example/docs/`) }));
 return { pdf, root, chapter, child, leaf, web };
}
const save = (pdf: PDFDocument) => pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
async function targets(bytes: Uint8Array) {
 const report = await inspectPDFBookmarks(bytes); return report.bookmarks.map(item => ({ title: item.definition.title, target: item.definition.target, children: item.children.map(child => child.definition.target) }));
}
function nativeTargets(bytes: Uint8Array) {
 const pdf = new mupdf.PDFDocument(bytes); try { const result: number[] = []; const visit = (items: NonNullable<ReturnType<typeof pdf.loadOutline>>) => items.forEach(item => { if (item.uri?.startsWith('#')) result.push(pdf.resolveLink(item.uri)); if (item.down) visit(item.down); }); visit(pdf.loadOutline() ?? []); return result; } finally { pdf.destroy(); }
}
describe('bookmarks across page operations', () => {
 it('merges named destinations without collisions, retaining source order, Unicode, style and actual page refs', async () => {
  const a = await fixture('A'), b = await fixture('B'), result = await mergePDFs([buffer(await save(a.pdf)), buffer(await save(b.pdf))]), report = await inspectPDFBookmarks(result);
  expect(report.bookmarks).toHaveLength(6); expect(report.bookmarks[0].definition).toMatchObject({ title: 'A章节', bold: true, italic: true, color: '#ff0000', expanded: false });
  expect(report.bookmarks[0].definition.target).toMatchObject({ pageNumber: 2 }); expect(report.bookmarks[3].definition.target).toMatchObject({ pageNumber: 5 });
  expect(report.bookmarks[3].children[0].definition.target).toMatchObject({ pageNumber: 6, view: 'XYZ', zoom: 1.5 }); expect(nativeTargets(result)).toEqual([1, 2, 0, 4, 5, 3]);
  expect(report.bookmarks[2].definition.target).toEqual({ type: 'url', url: 'https://a.example/help' }); expect(report.bookmarks[5].definition.target).toEqual({ type: 'url', url: 'https://b.example/help' });
 });
 it('splits out missing-target leaves, retaining surviving descendants under a non-navigating heading', async () => {
  const { pdf } = await fixture(), source = await save(pdf), [result] = await splitPDF(buffer(source), { mode: 'extract-pages', pages: [3] }), report = await inspectPDFBookmarks(result);
  expect(report.bookmarks.map(item => item.definition.title)).toEqual(['Source章节', 'Website']); expect(report.bookmarks[0].definition.target).toBeNull(); expect(report.bookmarks[0].children[0].definition.target).toMatchObject({ pageNumber: 1 }); expect(nativeTargets(result)).toEqual([0]);
  expect(await targets(source)).toHaveLength(3);
 });
 it('maps reversed and repeated output page selections to their first actual copy', async () => {
  const { pdf } = await fixture(), [result] = await splitPDF(buffer(await save(pdf)), { mode: 'extract-pages', pages: [3, 1, 3, 2] }), report = await inspectPDFBookmarks(result);
  expect(report.bookmarks[0].definition.target).toMatchObject({ pageNumber: 4 }); expect(report.bookmarks[0].children[0].definition.target).toMatchObject({ pageNumber: 1 }); expect(report.bookmarks[1].definition.target).toMatchObject({ pageNumber: 2 }); expect(nativeTargets(result)).toEqual([3, 0, 1]);
 });
 it('pins legacy numeric and named destinations before reordering or blank-page insertion', async () => {
  const { pdf } = await fixture(), source = buffer(await save(pdf)), reordered = await reorderPages(source, [3, 1, 2]);
  expect(nativeTargets(reordered)).toEqual([2, 0, 1]);
  const inserted = await insertBlankPages(source, { position: 1, count: 2 }); expect(nativeTargets(inserted)).toEqual([3, 4, 2]);
 });
 it('retains current and donor bookmarks when inserting pages before the current document', async () => {
  const a = await fixture('A'), b = await fixture('B'), result = await insertPagesFromPDF(buffer(await save(a.pdf)), buffer(await save(b.pdf)), 1, [3, 2]);
  const report = await inspectPDFBookmarks(result); expect(report.bookmarks).toHaveLength(5); expect(nativeTargets(result)).toEqual([3, 4, 2, 1, 0]);
  expect(report.bookmarks[3].definition.title).toBe('B章节');
 });
 it('deleting a target preserves surviving descendants as headings and prunes target leaves', async () => {
  const { pdf } = await fixture(), result = await deletePages(buffer(await save(pdf)), [2]), report = await inspectPDFBookmarks(result);
  expect(report.bookmarks[0].definition.target).toBeNull(); expect(report.bookmarks[0].children[0].definition.target).toMatchObject({ pageNumber: 2 }); expect(nativeTargets(result)).toEqual([1, 0]);
  const again = await deletePages(buffer(result), [2]); expect((await inspectPDFBookmarks(again)).bookmarks[0].children).toEqual([]); expect(nativeTargets(again)).toEqual([0]);
 });
 it('rejects malformed or unresolved source bookmarks before mutating the copy destination', async () => {
  for (const kind of ['missing', 'cycle', 'relative']) {
   const { pdf, chapter, web } = await fixture(), target = await PDFDocument.create(); target.addPage(); const initial = await save(target);
   if (kind === 'missing') chapter.set(key('Dest'), PDFString.of('absent')); if (kind === 'cycle') chapter.set(key('Next'), pdf.catalog.lookup(key('Outlines'), PDFDict).get(key('First'))!); if (kind === 'relative') { pdf.catalog.delete(key('URI')); web.lookup(key('A'), PDFDict).set(key('URI'), PDFString.of('../missingbase')); }
   await expect(copyPagesWithForms(target, pdf, [0, 1, 2])).rejects.toThrow(); expect(await save(target)).toEqual(initial); expect(target.getPageCount()).toBe(1);
  }
 });
 it('preserves action-chain GoTo targets using copied page refs', async () => {
  const { pdf, chapter } = await fixture(); chapter.delete(key('Dest')); chapter.set(key('A'), pdf.context.obj({ S: 'URI', URI: PDFString.of('https://example.test/'), Next: { S: 'GoTo', D: [pdf.getPage(2).ref, 'Fit'] } }));
  const [result] = await splitPDF(buffer(await save(pdf)), { mode: 'extract-pages', pages: [3, 2, 1] }), after = await PDFDocument.load(result), first = after.catalog.lookup(key('Outlines'), PDFDict).lookup(key('First'), PDFDict), dest = first.lookup(key('A'), PDFDict).lookup(key('Next'), PDFDict).lookup(key('D'), PDFArray);
  expect(dest.get(0).toString()).toBe(after.getPage(0).ref.toString());
 });
 it('protects structure-linked bookmarks when copying or deleting their target', async () => {
  const { pdf, child } = await fixture(); child.set(key('SE'), pdf.context.register(pdf.context.obj({ Type: 'StructElem', S: 'Sect' })));
  await expect(copyPagesWithForms(await PDFDocument.create(), pdf, [0, 1, 2])).rejects.toThrow(/structure/);
  await expect(deletePages(buffer(await save(pdf)), [3])).rejects.toThrow(/structure/);
 });
 it('maintains visible descendant counts after pruning and merging collapsed groups', async () => {
  const { pdf } = await fixture(), [result] = await splitPDF(buffer(await save(pdf)), { mode: 'extract-pages', pages: [3] }), after = await PDFDocument.load(result), root = after.catalog.lookup(key('Outlines'), PDFDict), group = root.lookup(key('First'), PDFDict);
  expect(root.lookup(key('Count'), PDFNumber).asNumber()).toBe(2); expect(group.lookup(key('Count'), PDFNumber).asNumber()).toBe(-1);
 });
});
