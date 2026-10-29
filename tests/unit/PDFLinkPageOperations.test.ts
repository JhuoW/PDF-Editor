import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { copyPagesWithForms } from '../../src/core/copyPagesWithForms';
import { deletePages, insertBlankPages, insertPagesFromPDF, mergePDFs, reorderPages, splitPDF } from '../../src/core/PDFManipulator';
import { createPDFLinkDestinationResolver, resolvePDFLinkDestination } from '../../src/core/PDFLinkDestinations';

const name = PDFName.of, buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
function annotate(pdf: PDFDocument, page: number, values: Record<string, unknown>) {
  const dict = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 20, 100, 40], Border: [0, 0, 0], ...values });
  pdf.getPage(page - 1).node.addAnnot(pdf.context.register(dict)); return dict;
}
async function fixture() {
  const pdf = await PDFDocument.create();
  const pages = [1, 2, 3].map(number => { const page = pdf.addPage([300, 400]); page.drawText(`PUBLIC PAGE ${number}`); return page; });
  const dest = pdf.context.obj([pages[2].ref, name('XYZ'), 20, 300, null]), self = pdf.context.obj([pages[0].ref, name('Fit')]);
  annotate(pdf, 1, { NM: PDFString.of('direct'), Dest: dest });
  annotate(pdf, 1, { NM: PDFString.of('goto'), A: { S: 'GoTo', D: dest } });
  annotate(pdf, 1, { NM: PDFString.of('named'), Dest: PDFHexString.fromText('最后页') });
  annotate(pdf, 1, { NM: PDFString.of('old-named'), Dest: name('oldTarget') });
  annotate(pdf, 1, { NM: PDFString.of('self'), Dest: self });
  annotate(pdf, 1, { NM: PDFString.of('external'), A: { S: 'URI', URI: PDFString.of('https://example.invalid/path') } });
  annotate(pdf, 1, { Subtype: 'Text', Contents: PDFString.of('Keep this note') });
  const field = pdf.getForm().createTextField('Name'); field.setText('Keep this form'); field.addToPage(pages[0], { x: 20, y: 100, width: 140, height: 20 });
  pdf.catalog.set(name('Dests'), pdf.context.obj({ oldTarget: { D: dest }, oldKeep: [pages[1].ref, name('Fit')] }));
  const leaf = pdf.context.obj({ Names: [PDFString.of('keep'), [pages[1].ref, name('Fit')], PDFHexString.fromText('最后页'), dest], Limits: [PDFString.of('keep'), PDFHexString.fromText('最后页')] });
  pdf.catalog.set(name('Names'), pdf.context.obj({ Dests: { Kids: [pdf.context.register(leaf)] } }));
  return pdf;
}
function annotations(pdf: PDFDocument, page: number) { return (pdf.getPage(page - 1).node.Annots()?.asArray() ?? []).map(raw => pdf.context.lookup(raw, PDFDict)); }
function links(pdf: PDFDocument, page: number) { return annotations(pdf, page).filter(dict => dict.lookup(name('Subtype')) === name('Link')); }
function id(dict: PDFDict) { return (dict.lookup(name('NM')) as PDFString)?.decodeText(); }
function targets(pdf: PDFDocument, page: number) {
  const resolve = createPDFLinkDestinationResolver(pdf);
  return Object.fromEntries(links(pdf, page).map(dict => {
    const action = dict.lookup(name('A'));
    return [id(dict), resolve(dict.get(name('Dest')) ?? (action instanceof PDFDict ? action.get(name('D')) : undefined))?.pageNumber];
  }));
}
function assertNoReachableOrphanPages(pdf: PDFDocument) {
  const pages = new Set(pdf.getPages().map(page => page.node)), seen = new Set<PDFObject>();
  const walk = (value: PDFObject | undefined) => {
    if (!value || seen.has(value)) return; seen.add(value);
    if (value instanceof PDFRef) { walk(pdf.context.lookup(value)); return; }
    if (value instanceof PDFArray) value.asArray().forEach(walk);
    if (value instanceof PDFDict) {
      if (value.lookup(name('Type')) === name('Page')) expect(pages.has(value)).toBe(true);
      value.entries().forEach(([, child]) => walk(child));
    }
  };
  walk(pdf.catalog);
}
function nativeTargets(bytes: Uint8Array, pageNumber: number) {
  const document = new mupdf.PDFDocument(bytes), page = document.loadPage(pageNumber - 1), found = page.getLinks();
  try { return found.filter(link => !link.getURI().startsWith('https:')).map(link => document.resolveLink(link) + 1); }
  finally { found.forEach(link => link.destroy()); page.destroy(); document.destroy(); }
}

describe('native PDF links through page operations', () => {
  it.each(['merge', 'split', 'insert'] as const)('%s binds direct, GoTo and both named destinations to actual copied pages', async operation => {
    const source = buffer(await (await fixture()).save());
    const empty = await PDFDocument.create(); empty.addPage();
    const bytes = operation === 'merge' ? await mergePDFs([source, source])
      : operation === 'split' ? (await splitPDF(source, { mode: 'extract-pages', pages: [1, 2, 3] }))[0]
      : await insertPagesFromPDF(buffer(await empty.save()), source, 0);
    const pdf = await PDFDocument.load(bytes), start = operation === 'insert' ? 2 : 1, target = start + 2;
    expect(targets(pdf, start)).toMatchObject({ direct: target, goto: target, named: target, 'old-named': target, self: start });
    expect(nativeTargets(bytes, start)).toEqual([target, target, target, target, start]);
    if (operation === 'merge') expect(targets(pdf, 4)).toMatchObject({ direct: 6, named: 6, self: 4 });
    expect(pdf.getForm().getTextField('Name').getText()).toBe('Keep this form');
    expect(annotations(pdf, start).some(dict => dict.lookup(name('Subtype')) === name('Text'))).toBe(true);
    expect(links(pdf, start).find(dict => id(dict) === 'external')!.lookup(name('A'), PDFDict).lookup(name('URI'), PDFString).decodeText()).toBe('https://example.invalid/path');
    assertNoReachableOrphanPages(pdf);
  });

  it('drops only links to excluded targets when extracting a subset', async () => {
    const bytes = (await splitPDF(buffer(await (await fixture()).save()), { mode: 'extract-pages', pages: [1, 2] }))[0];
    const pdf = await PDFDocument.load(bytes);
    expect(links(pdf, 1).map(id)).toEqual(['self', 'external']);
    expect(pdf.getForm().getTextField('Name').getText()).toBe('Keep this form');
    expect(annotations(pdf, 1).some(dict => dict.lookup(name('Subtype')) === name('Text'))).toBe(true);
    assertNoReachableOrphanPages(pdf);
  });

  it('maps duplicate-page self links to their own occurrence and other links to the first target copy', async () => {
    const source = await fixture(), target = await PDFDocument.create();
    const original = source.getPage(0).node.Annots()!.toString(), sourceLinks = links(source, 1).map(dict => dict.toString());
    (await copyPagesWithForms(target, source, [0, 2, 0, 2])).forEach(page => target.addPage(page));
    const pdf = await PDFDocument.load(await target.save());
    expect(targets(pdf, 1)).toMatchObject({ direct: 2, named: 2, self: 1 });
    expect(targets(pdf, 3)).toMatchObject({ direct: 2, named: 2, self: 3 });
    expect(pdf.getForm().getFields()).toHaveLength(2);
    expect(links(pdf, 1).every(dict => !links(pdf, 3).includes(dict))).toBe(true);
    expect(source.getPage(0).node.Annots()!.toString()).toBe(original);
    expect(links(source, 1).map(dict => dict.toString())).toEqual(sourceLinks);
    assertNoReachableOrphanPages(pdf);
  });

  it('clones shared Annots/actions and rewrites GoTo inside a Next action chain', async () => {
    const source = await PDFDocument.create(); source.addPage(); source.addPage();
    const action = source.context.register(source.context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/'), Next: [{ S: 'GoTo', D: [source.getPage(0).ref, name('Fit')] }] }));
    annotate(source, 1, { NM: PDFString.of('chain'), A: action });
    source.getPage(1).node.set(name('Annots'), source.getPage(0).node.Annots()!);
    const target = await PDFDocument.create(); (await copyPagesWithForms(target, source, [0, 1, 0])).forEach(page => target.addPage(page));
    const pdf = await PDFDocument.load(await target.save());
    const destinations = [1, 2, 3].map(number => {
      const a = links(pdf, number)[0], next = a.lookup(name('A'), PDFDict).lookup(name('Next'), PDFArray).lookup(0, PDFDict);
      expect(a.lookup(name('P'))).toBe(pdf.getPage(number - 1).node);
      return resolvePDFLinkDestination(pdf, next.get(name('D')))?.pageNumber;
    });
    expect(destinations).toEqual([1, 1, 3]);
    expect(new Set([1, 2, 3].map(number => links(pdf, number)[0])).size).toBe(3);
    expect(source.context.lookup(action, PDFDict).lookup(name('Next'), PDFArray).lookup(0, PDFDict).lookup(name('D'), PDFArray).get(0)).toBe(source.getPage(0).ref);
    assertNoReachableOrphanPages(pdf);
  });

  it('removes deleted targets from incoming links and nested/old name trees while preserving other entries', async () => {
    const source = await fixture();
    annotate(source, 1, { NM: PDFString.of('next'), A: { S: 'URI', URI: PDFString.of('https://example.invalid/'), Next: { S: 'GoTo', D: [source.getPage(2).ref, name('Fit')] } } });
    const bytes = await deletePages(buffer(await source.save()), [3]), pdf = await PDFDocument.load(bytes);
    expect(links(pdf, 1).map(id)).toEqual(['self', 'external']);
    expect(resolvePDFLinkDestination(pdf, name('oldTarget'))).toBeNull();
    expect(resolvePDFLinkDestination(pdf, PDFString.of('最后页'))).toBeNull();
    expect(resolvePDFLinkDestination(pdf, name('oldKeep'))?.pageNumber).toBe(2);
    expect(resolvePDFLinkDestination(pdf, PDFString.of('keep'))?.pageNumber).toBe(2);
    const leaf = pdf.catalog.lookup(name('Names'), PDFDict).lookup(name('Dests'), PDFDict).lookup(name('Kids'), PDFArray).lookup(0, PDFDict);
    expect(leaf.lookup(name('Limits'), PDFArray).toString()).toBe('[ (keep) (keep) ]');
    expect(pdf.getForm().getTextField('Name').getText()).toBe('Keep this form');
    expect(nativeTargets(bytes, 1)).toEqual([1]); assertNoReachableOrphanPages(pdf);
  });

  it.each(['reorder', 'insert', 'delete-unrelated'] as const)('%s preserves valid destinations, including legacy numeric local destinations', async operation => {
    const source = await fixture();
    annotate(source, 1, { NM: PDFString.of('numeric'), Dest: [2, name('Fit')] });
    const data = buffer(await source.save());
    const bytes = operation === 'reorder' ? await reorderPages(data, [3, 1, 2])
      : operation === 'insert' ? await insertBlankPages(data, { position: 2 }) : await deletePages(data, [2]);
    const pdf = await PDFDocument.load(bytes), sourcePage = operation === 'reorder' ? 2 : 1, destination = operation === 'reorder' ? 1 : operation === 'insert' ? 4 : 2;
    expect(targets(pdf, sourcePage)).toMatchObject({ direct: destination, goto: destination, named: destination, 'old-named': destination, numeric: destination });
    assertNoReachableOrphanPages(pdf);
  });

  it.each(['orphan', 'duplicate-name', 'cycle', 'next-cycle', 'invalid-coordinate-ref'] as const)('rejects %s before any target mutation or source changes', async kind => {
    const source = await fixture(), target = await PDFDocument.create(); target.addPage();
    const annotationsBefore = source.getPage(0).node.Annots()!.toString();
    if (kind === 'orphan') { const orphan = source.addPage(); annotate(source, 1, { Dest: [orphan.ref, name('Fit')] }); source.removePage(3); }
    if (kind === 'duplicate-name') {
      const leaf = source.catalog.lookup(name('Names'), PDFDict).lookup(name('Dests'), PDFDict).lookup(name('Kids'), PDFArray).lookup(0, PDFDict);
      leaf.lookup(name('Names'), PDFArray).push(PDFString.of('oldTarget'));
      leaf.lookup(name('Names'), PDFArray).push(source.context.obj([source.getPage(1).ref, name('Fit')]));
    }
    if (kind === 'cycle') source.catalog.lookup(name('Dests'), PDFDict).set(name('oldTarget'), name('oldTarget'));
    if (kind === 'next-cycle') { const action = source.context.obj({ S: 'GoTo', D: [source.getPage(1).ref, name('Fit')] }); action.set(name('Next'), source.context.register(action)); annotate(source, 1, { A: action }); }
    if (kind === 'invalid-coordinate-ref') annotate(source, 1, { Dest: [source.getPage(1).ref, name('XYZ'), source.getPage(2).ref, 20, null] });
    const sourceState = source.getPage(0).node.Annots()!.toString(), targetObjects = target.context.enumerateIndirectObjects().length;
    const failure = await copyPagesWithForms(target, source, [0, 1, 2]).then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error); expect(failure?.message).toContain('Cannot copy page 1');
    expect(target.getPageCount()).toBe(1); expect(target.context.enumerateIndirectObjects()).toHaveLength(targetObjects);
    expect(source.getPage(0).node.Annots()!.toString()).toBe(sourceState);
    if (kind === 'cycle' || kind === 'duplicate-name') expect(sourceState).toBe(annotationsBefore);
  });

  it('resolves only actual page refs and rejects invalid numeric destinations', async () => {
    const pdf = await PDFDocument.create(); const page = pdf.addPage(), orphan = pdf.addPage(); pdf.removePage(1);
    expect(resolvePDFLinkDestination(pdf, pdf.context.obj([page.ref, name('Fit')]))?.pageNumber).toBe(1);
    expect(resolvePDFLinkDestination(pdf, pdf.context.obj([orphan.ref, name('Fit')]))).toBeNull();
    for (const value of [-1, 1, .5]) expect(resolvePDFLinkDestination(pdf, pdf.context.obj([PDFNumber.of(value), name('Fit')]))).toBeNull();
  });

  it('resolves relative URI actions and nested URI actions against the donor base before copying', async () => {
    const source = await PDFDocument.create(); source.addPage();
    source.catalog.set(name('URI'), source.context.obj({ Base: PDFString.of('https://source.example/docs/') }));
    annotate(source, 1, { A: { S: 'URI', URI: PDFString.of('../help'), Next: { S: 'URI', URI: PDFString.of('#section') } } });
    const target = await PDFDocument.create(); target.addPage();
    target.catalog.set(name('URI'), target.context.obj({ Base: PDFString.of('https://target.example/base/') }));
    (await copyPagesWithForms(target, source, [0])).forEach(page => target.addPage(page));
    const reopened = await PDFDocument.load(await target.save()), action = links(reopened, 2)[0].lookup(name('A'), PDFDict);
    expect(action.lookup(name('URI'), PDFString).decodeText()).toBe('https://source.example/help');
    expect(action.lookup(name('Next'), PDFDict).lookup(name('URI'), PDFString).decodeText()).toBe('https://source.example/docs/#section');
    expect(links(source, 1)[0].lookup(name('A'), PDFDict).lookup(name('URI'), PDFString).decodeText()).toBe('../help');
  });

  it('rejects an unresolvable relative external link before changing the target', async () => {
    const source = await PDFDocument.create(); source.addPage(); annotate(source, 1, { A: { S: 'URI', URI: PDFString.of('../help') } });
    const target = await PDFDocument.create(); target.addPage(); const objects = target.context.enumerateIndirectObjects().length;
    const failure = await copyPagesWithForms(target, source, [0]).then(() => null, error => error);
    expect(failure?.message).toContain('relative link URI'); expect(target.context.enumerateIndirectObjects()).toHaveLength(objects);
  });
});
