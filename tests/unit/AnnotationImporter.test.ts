import { describe, expect, it } from 'vitest';
import { AnnotationFlags, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';
import { serializeAnnotationsToPDF } from '../../src/annotations/AnnotationSerializer';
import type { StickyNoteAnnotation } from '../../src/annotations/types';

function addNote(document: PDFDocument, pageIndex: number, options: Record<string, unknown> = {}) {
  const page = document.getPage(pageIndex);
  const dictionary = document.context.obj({
    Type: 'Annot', Subtype: 'Text', P: page.ref, Rect: [40, 670, 64, 694],
    Contents: PDFHexString.fromText('原始便签 😀'), T: PDFHexString.fromText('Zoë 作者'),
    NM: PDFString.of('source-note'), C: [0.1234, 0.5, 0.9],
    CreationDate: PDFString.of("D:20261029120000+08'00'"),
    M: PDFString.of('D:20261029050000Z'),
    F: AnnotationFlags.Print | AnnotationFlags.NoZoom | AnnotationFlags.NoRotate,
    Name: 'Comment', CA: 0.75, ...options,
  });
  const reference = document.context.register(dictionary);
  page.node.addAnnot(reference);
  return { dictionary, reference };
}

async function blankDocument(pages = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage([600, 800]);
  return document;
}

async function bytes(document: PDFDocument) {
  return new Uint8Array(await document.save({ updateFieldAppearances: false })).buffer;
}

function notes(result: Awaited<ReturnType<typeof importEditableAnnotations>>) {
  return [...result.annotations.values()].flat() as StickyNoteAnnotation[];
}

function rect(dictionary: PDFDict) {
  return dictionary.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber());
}

describe('editable native Text annotation import', () => {
  it('imports Unicode threads and popup metadata, strips only those objects, and round-trips edits once', async () => {
    const document = await blankDocument();
    const root = addNote(document, 0, { Subj: PDFHexString.fromText('审阅意见'), Open: true });
    const reply = addNote(document, 0, {
      IRT: root.reference, RT: 'R', NM: PDFString.of('source-reply'),
      Rect: [80, 600, 104, 624], Name: 'Help', Contents: PDFHexString.fromText('回复 Ελληνικά'),
      T: PDFHexString.fromText('回复作者'), C: [1, 0, 0], CA: 0.4,
    });
    const popup = document.context.register(document.context.obj({
      Type: 'Annot', Subtype: 'Popup', P: document.getPage(0).ref, Parent: root.reference,
      Rect: [90, 400, 300, 650], Open: true, F: 0,
    }));
    root.dictionary.set(PDFName.of('Popup'), popup);
    document.getPage(0).node.addAnnot(popup);
    const link = document.context.register(document.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 20, 20],
      A: { S: 'URI', URI: PDFString.of('https://example.com') },
    }));
    document.getPage(0).node.addAnnot(link);
    const original = await bytes(document);
    const preservedOriginal = original.slice(0);
    const imported = await importEditableAnnotations(original);
    expect(original).toEqual(preservedOriginal);
    const [note] = notes(imported);
    expect(note).toMatchObject({
      type: 'sticky-note', sourceNM: 'source-note', content: '原始便签 😀', author: 'Zoë 作者',
      position: { x: 40, y: 694 }, iconType: 'comment', isOpen: true, color: '#1f80e6', opacity: 0.75,
    });
    expect(note.id).not.toBe('source-note');
    expect(note.createdAt.toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(note.replies).toHaveLength(1);
    expect(note.replies![0]).toMatchObject({ content: '回复 Ελληνικά', author: '回复作者', sourceNM: 'source-reply', iconType: 'help' });
    expect(structuredClone(imported.annotations)).toEqual(imported.annotations);
    const base = await PDFDocument.load(imported.data);
    const remaining = base.getPage(0).node.Annots()!;
    expect(remaining.size()).toBe(1);
    expect(remaining.lookup(0, PDFDict).lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    // Removed native objects cannot resurrect the old text later.
    expect(base.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFDict
      && object.lookup(PDFName.of('Subtype')) === PDFName.of('Text'))).toBe(false);

    note.content = '修改后的正文 ✓';
    note.modifiedAt = new Date('2026-10-30T00:00:00Z');
    note.position = { x: 50, y: 714 };
    note.replies![0].content = '更新回复';
    const output = await serializeAnnotationsToPDF(imported.data, imported.annotations);
    const exported = await PDFDocument.load(output);
    const annots = exported.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(4); // link + parent + popup + reply
    const rootOutput = annots.lookup(1, PDFDict);
    expect(rect(rootOutput)).toEqual([50, 690, 74, 714]);
    expect(rootOutput.lookup(PDFName.of('Subj'), PDFHexString).decodeText()).toBe('审阅意见');
    expect(rootOutput.lookup(PDFName.of('C'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber())).toEqual([0.1234, 0.5, 0.9]);
    expect(rect(annots.lookup(2, PDFDict))).toEqual([100, 420, 310, 670]);
    expect(rect(annots.lookup(3, PDFDict))).toEqual([90, 620, 114, 644]);
    expect(annots.lookup(3, PDFDict).get(PDFName.of('IRT'))).toBe(annots.get(1));
    expect(reply.reference).not.toBeUndefined();

    const reopened = await importEditableAnnotations(output);
    expect(notes(reopened)).toHaveLength(1);
    expect(notes(reopened)[0].content).toBe('修改后的正文 ✓');
    expect(notes(reopened)[0].replies?.map(item => item.content)).toEqual(['更新回复']);
    const again = await serializeAnnotationsToPDF(reopened.data, reopened.annotations);
    expect((await PDFDocument.load(again)).getPage(0).node.Annots()!.size()).toBe(4);
    const reader = new mupdf.PDFDocument(again);
    const page = reader.loadPage(0);
    const nativeNotes = page.getAnnotations();
    try {
      expect(nativeNotes.filter(item => item.getType() === 'Text').map(item => item.getContents()))
        .toEqual(['修改后的正文 ✓', '更新回复']);
    } finally { nativeNotes.forEach(item => item.destroy()); page.destroy(); reader.destroy(); }

    // Deletion is an ordinary workspace removal, with no stale source note.
    const deleted = await serializeAnnotationsToPDF(reopened.data, new Map());
    expect(notes(await importEditableAnnotations(deleted))).toHaveLength(0);
    expect((await PDFDocument.load(deleted)).getPage(0).node.Annots()!.size()).toBe(1);
  });

  it('assigns distinct internal IDs to duplicate NM values across pages and replies', async () => {
    const document = await blankDocument(2);
    const first = addNote(document, 0);
    addNote(document, 0, { IRT: first.reference, RT: 'R' });
    addNote(document, 1);
    const imported = await importEditableAnnotations(await bytes(document));
    const all = notes(imported).flatMap(note => [note, ...(note.replies ?? [])]);
    expect(all).toHaveLength(3);
    expect(new Set(all.map(item => item.id)).size).toBe(3);
    expect(all.map(item => item.sourceNM)).toEqual(['source-note', 'source-note', 'source-note']);
  });

  it('retains missing dates and default nonprinting flags without manufacturing dates or colors', async () => {
    const document = await blankDocument();
    const { dictionary } = addNote(document, 0);
    for (const key of ['CreationDate', 'M', 'F', 'C', 'T', 'NM', 'Name']) dictionary.delete(PDFName.of(key));
    const imported = await importEditableAnnotations(await bytes(document));
    expect(notes(imported)[0].iconType).toBe('note');
    const exported = await PDFDocument.load(await serializeAnnotationsToPDF(imported.data, imported.annotations));
    const output = exported.getPage(0).node.Annots()!.lookup(0, PDFDict);
    for (const key of ['CreationDate', 'M', 'C', 'T']) expect(output.has(PDFName.of(key))).toBe(false);
    expect(output.lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(0);
  });

  it.each(['AP', 'RC', 'State', 'UnknownExtension'])('keeps a whole thread with unsupported %s metadata unchanged', async key => {
    const document = await blankDocument();
    const root = addNote(document, 0);
    addNote(document, 0, { IRT: root.reference, RT: 'R', [key]: PDFString.of('must survive') });
    const original = await bytes(document);
    const imported = await importEditableAnnotations(original);
    expect(imported.data).toBe(original);
    expect(imported.annotations.size).toBe(0);
  });

  it.each(['locked', 'cross-page', 'nested', 'non-text', 'group', 'popup-extension'])('leaves %s note threads native', async scenario => {
    const document = await blankDocument(2);
    const root = addNote(document, 0, scenario === 'locked' ? { F: AnnotationFlags.Locked } : {});
    const reply = addNote(document, scenario === 'cross-page' ? 1 : 0, {
      IRT: root.reference, RT: scenario === 'group' ? 'Group' : 'R',
      Subtype: scenario === 'non-text' ? 'FreeText' : 'Text',
    });
    if (scenario === 'nested') addNote(document, 0, { IRT: reply.reference, RT: 'R' });
    if (scenario === 'popup-extension') {
      const popup = document.context.register(document.context.obj({
        Type: 'Annot', Subtype: 'Popup', Parent: root.reference, Rect: [0, 0, 40, 40], CustomData: 'Keep',
      }));
      root.dictionary.set(PDFName.of('Popup'), popup);
      document.getPage(0).node.addAnnot(popup);
    }
    const original = await bytes(document);
    const imported = await importEditableAnnotations(original);
    expect(imported.data).toBe(original);
    expect(imported.annotations.size).toBe(0);
  });

  it('retains Stamp and other native annotations even when a nearby Text note is imported', async () => {
    const document = await blankDocument();
    addNote(document, 0);
    addNote(document, 0, { Subtype: 'Stamp', Name: 'Approved' });
    addNote(document, 0, { Subtype: 'Square' });
    const imported = await importEditableAnnotations(await bytes(document));
    expect(notes(imported)).toHaveLength(1);
    const native = (await PDFDocument.load(imported.data)).getPage(0).node.Annots()!;
    expect(native.asArray().map((_, index) => native.lookup(index, PDFDict).lookup(PDFName.of('Subtype'))))
      .toEqual([PDFName.of('Stamp'), PDFName.of('Square')]);
  });

  it('does not strip a popup referenced by an unsupported second thread', async () => {
    const document = await blankDocument();
    const first = addNote(document, 0);
    const second = addNote(document, 0, { RC: PDFString.of('Unsupported rich text') });
    const popup = document.context.register(document.context.obj({
      Type: 'Annot', Subtype: 'Popup', Parent: first.reference, Rect: [100, 100, 200, 200],
    }));
    first.dictionary.set(PDFName.of('Popup'), popup);
    second.dictionary.set(PDFName.of('Popup'), popup);
    document.getPage(0).node.addAnnot(popup);
    const original = await bytes(document);
    expect((await importEditableAnnotations(original)).data).toBe(original);
  });

  it('preserves the native icon appearance and anchor when imported and immediately exported', async () => {
    const document = await blankDocument();
    addNote(document, 0, { Name: 'Key' });
    const original = await bytes(document);
    const imported = await importEditableAnnotations(original);
    const output = await serializeAnnotationsToPDF(imported.data, imported.annotations);
    const render = (data: ArrayBuffer) => {
      const pdf = new mupdf.PDFDocument(data);
      const page = pdf.loadPage(0);
      const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
      try { return new Uint8Array(pixmap.getPixels()); }
      finally { pixmap.destroy(); page.destroy(); pdf.destroy(); }
    };
    const before = render(original);
    const after = render(output);
    expect(after.length).toBe(before.length);
    expect(after.every((channel, index) => channel === before[index])).toBe(true);
  });

  it('returns original bytes unchanged when the document has no editable notes', async () => {
    const document = await blankDocument();
    document.getPage(0).drawText('Original page content');
    const original = await bytes(document);
    const imported = await importEditableAnnotations(original);
    expect(imported.data).toBe(original);
    expect(imported.annotations.size).toBe(0);
  });
});
