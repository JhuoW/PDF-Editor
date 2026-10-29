import { describe, expect, it } from 'vitest';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream,
} from 'pdf-lib';
import * as mupdf from 'mupdf';
import {
  addDocumentAttachment, clearDocumentMetadata, extractDocumentAttachment,
  inspectDocumentAssets, removeDocumentAttachment, updateDocumentMetadata,
} from '../../src/core/DocumentAssets';

const k = PDFName.of;
const binary = (value: string) => new TextEncoder().encode(value);
const asBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const removedSecret = 'REMOVED_ATTACHMENT_PRIVATE_BYTES_821741';
const keptSecret = 'KEEP_OTHER_SAME_NAME_ATTACHMENT_928157';
const pageXmp = '<x:xmpmeta>PAGE_METADATA_INTENTIONALLY_REMAINS</x:xmpmeta>';

async function blank() {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]).drawText('PAGE ONE CONTENT', { x: 50, y: 700, size: 14 });
  pdf.addPage([400, 600]).drawText('PAGE TWO CONTENT', { x: 50, y: 500, size: 14 });
  return pdf;
}

function embedded(pdf: PDFDocument, name: string, contents: string, description = '') {
  const stream = pdf.context.flateStream(binary(contents), { Type: 'EmbeddedFile', Subtype: 'text/plain', Params: { Size: contents.length } });
  const streamRef = pdf.context.register(stream);
  const dictionary = pdf.context.obj({ Type: 'Filespec', F: PDFString.of('legacy-filename.txt'),
    UF: PDFHexString.fromText(name), Desc: PDFHexString.fromText(description), EF: { F: streamRef, UF: streamRef } });
  const reference = pdf.context.register(dictionary);
  return { dictionary, reference, stream, streamRef };
}

async function complexFixture() {
  const pdf = await blank();
  pdf.setTitle('OLD_PRIVATE_TITLE_2317');
  pdf.setAuthor('OLD_PRIVATE_AUTHOR_7219');
  pdf.setSubject('Original subject');
  pdf.setKeywords(['one', 'two']);
  pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict).set(k('PrivateCustom'), PDFString.of('PRIVATE_INFO_CUSTOM_62891'));
  const xmp = pdf.context.register(pdf.context.stream('<x:xmpmeta>OLD_CATALOG_XMP_PRIVATE_51832</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
  pdf.catalog.set(k('Metadata'), xmp);
  pdf.getPage(0).node.set(k('Metadata'), pdf.context.register(pdf.context.stream(pageXmp, { Type: 'Metadata', Subtype: 'XML' })));
  const form = pdf.getForm().createTextField('Customer');
  form.setText('Preserved form value');
  for (const page of pdf.getPages()) form.addToPage(page, { x: 60, y: 300, width: 200, height: 30 });
  pdf.getPage(0).node.addAnnot(pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [50, 400, 74, 424], Contents: PDFHexString.fromText('保留便签'), P: pdf.getPage(0).ref,
  })));
  const remove = embedded(pdf, '报告 😀.txt', removedSecret, 'Remove this logical attachment');
  const keep = embedded(pdf, '报告 😀.txt', keptSecret, 'Same filename, different content');
  const afOnly = embedded(pdf, 'AF-only.txt', 'ONLY_AF_CONTENT');
  const annotationOnly = embedded(pdf, 'note-only.txt', 'ONLY_ANNOTATION_CONTENT');
  const firstLeaf = pdf.context.register(pdf.context.obj({ Names: [PDFString.of('first-name'), remove.reference, PDFString.of('keep-name'), keep.reference], Limits: ['first-name', 'keep-name'] }));
  const secondLeaf = pdf.context.register(pdf.context.obj({ Names: [PDFString.of('second-alias'), remove.reference], Limits: ['second-alias', 'second-alias'] }));
  pdf.catalog.set(k('Names'), pdf.context.obj({ EmbeddedFiles: { Kids: [firstLeaf, secondLeaf] }, Dests: { Names: [PDFString.of('section'), [pdf.getPage(0).ref, 'Fit']] } }));
  pdf.catalog.set(k('AF'), pdf.context.obj([remove.reference, keep.reference]));
  pdf.getPage(1).node.set(k('AF'), pdf.context.obj([remove.reference, afOnly.reference]));
  // AF is also valid in structures and XObjects, not only on the catalog.
  pdf.catalog.set(k('StructTreeRoot'), pdf.context.obj({ Type: 'StructTreeRoot', K: { Type: 'StructElem', S: 'Document', AF: [remove.reference] } }));
  const object = pdf.context.register(pdf.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], AF: [remove.reference] }));
  pdf.getPage(0).node.newXObject('AssociatedFile', object);
  const attachmentAnnotation = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [50, 200, 74, 224], FS: remove.reference, Contents: PDFString.of('Attached file') }));
  const popup = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [50, 50, 200, 200], Parent: attachmentAnnotation }));
  pdf.context.lookup(attachmentAnnotation, PDFDict).set(k('Popup'), popup);
  pdf.getPage(1).node.addAnnot(attachmentAnnotation);
  pdf.getPage(1).node.addAnnot(popup);
  pdf.getPage(0).node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [100, 200, 124, 224], FS: annotationOnly.reference })));
  pdf.context.register(pdf.context.stream('ORPHAN_OLD_REVISION_SECRET_329178'));
  return { pdf, remove, keep };
}

async function save(pdf: PDFDocument) { return asBuffer(await pdf.save({ updateFieldAppearances: false, useObjectStreams: false })); }

function decodedStreams(bytes: ArrayBuffer | Uint8Array) {
  const document = new mupdf.PDFDocument(bytes);
  const streams: string[] = [];
  try {
    for (let number = 1; number < document.countObjects(); number++) {
      const object = document.newIndirect(number);
      try {
        if (object.isStream()) {
          const stream = object.readStream();
          try { streams.push(new TextDecoder().decode(stream.asUint8Array())); }
          finally { stream.destroy(); }
        }
      } finally { object.destroy(); }
    }
    return streams.join('\n');
  } finally { document.destroy(); }
}

async function assertDocumentContent(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(pdf.getPageCount()).toBe(2);
  expect(pdf.getForm().getTextField('Customer').getText()).toBe('Preserved form value');
  expect(pdf.getForm().getTextField('Customer').acroField.getWidgets()).toHaveLength(2);
  const notes = pdf.getPage(0).node.Annots()!;
  expect(notes.asArray().some((_, index) => notes.lookup(index, PDFDict).lookup(k('Subtype')) === k('Text'))).toBe(true);
  const reader = new mupdf.PDFDocument(bytes);
  try {
    for (let index = 0; index < 2; index++) {
      const page = reader.loadPage(index);
      const text = page.toStructuredText('');
      try { expect(text.asText()).toContain(index === 0 ? 'PAGE ONE CONTENT' : 'PAGE TWO CONTENT'); }
      finally { text.destroy(); page.destroy(); }
    }
  } finally { reader.destroy(); }
}

describe('DocumentAssets metadata', () => {
  it('reads Unicode Info and catalog XMP without modifying the input or manufacturing Info', async () => {
    const pdf = await blank();
    pdf.context.trailerInfo.Info = undefined;
    const input = await save(pdf);
    const before = input.slice(0);
    expect(await inspectDocumentAssets(input)).toEqual({ metadata: { title: '', author: '', subject: '', keywords: '' }, hasXmp: false, attachments: [] });
    expect(input).toEqual(before);
    const changed = await updateDocumentMetadata(input, { title: '文档 😀', author: 'Zoë 作者', subject: '审阅', keywords: 'alpha, 中文; beta' });
    expect((await inspectDocumentAssets(asBuffer(changed))).metadata)
      .toEqual({ title: '文档 😀', author: 'Zoë 作者', subject: '审阅', keywords: 'alpha, 中文; beta' });
  });

  it('updates Info, removes stale catalog XMP, and preserves pages, forms, annotations, and attachments', async () => {
    const { pdf } = await complexFixture();
    const source = await save(pdf);
    const before = source.slice(0);
    expect((await inspectDocumentAssets(source)).hasXmp).toBe(true);
    const output = await updateDocumentMetadata(source, { title: '新的标题', author: '新作者', subject: '', keywords: 'x,y' });
    const inspected = await inspectDocumentAssets(asBuffer(output));
    expect(inspected.metadata).toEqual({ title: '新的标题', author: '新作者', subject: '', keywords: 'x,y' });
    expect(inspected.hasXmp).toBe(false);
    expect(inspected.attachments).toHaveLength(4);
    expect(decodedStreams(output)).not.toContain('OLD_CATALOG_XMP_PRIVATE_51832');
    expect(decodedStreams(output)).toContain(pageXmp);
    const saved = await PDFDocument.load(output, { updateMetadata: false });
    expect(saved.context.lookup(saved.context.trailerInfo.Info, PDFDict).lookup(k('PrivateCustom'), PDFString).decodeText()).toBe('PRIVATE_INFO_CUSTOM_62891');
    await assertDocumentContent(output);
    expect(source).toEqual(before);
  });

  it('clears all document Info and catalog XMP with garbage collection, without claiming page metadata removal', async () => {
    const { pdf } = await complexFixture();
    const output = await clearDocumentMetadata(await save(pdf));
    const result = await inspectDocumentAssets(asBuffer(output));
    expect(result.metadata).toEqual({ title: '', author: '', subject: '', keywords: '' });
    expect(result.hasXmp).toBe(false);
    expect(result.attachments).toHaveLength(4);
    const saved = await PDFDocument.load(output, { updateMetadata: false });
    expect(saved.context.trailerInfo.Info).toBeUndefined();
    expect(saved.catalog.has(k('Metadata'))).toBe(false);
    expect(decodedStreams(output)).not.toContain('OLD_CATALOG_XMP_PRIVATE_51832');
    expect(decodedStreams(output)).not.toContain('ORPHAN_OLD_REVISION_SECRET_329178');
    expect(decodedStreams(output)).toContain(pageXmp);
    expect(saved.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFDict && object.has(k('PrivateCustom')))).toBe(false);
    await assertDocumentContent(output);
  });

  it('preserves widget object references through every asset mutation while garbage-collecting removed objects', async () => {
    const { pdf } = await complexFixture();
    let data = await save(pdf);
    const widgetRefs = async (input: ArrayBuffer) => {
      const document = await PDFDocument.load(input, { updateMetadata: false });
      return document.getForm().getFields().flatMap(field => field.acroField.getWidgets()
        .map(widget => document.context.getObjectRef(widget.dict)!.toString()));
    };
    const originalRefs = await widgetRefs(data);
    data = asBuffer(await updateDocumentMetadata(data, { title: 'New title', author: '', subject: '', keywords: '' }));
    expect(await widgetRefs(data)).toEqual(originalRefs);
    data = asBuffer(await clearDocumentMetadata(data));
    expect(await widgetRefs(data)).toEqual(originalRefs);
    data = asBuffer(await addDocumentAttachment(data, { name: 'later.txt', data: binary('LATER_ATTACHMENT') }));
    expect(await widgetRefs(data)).toEqual(originalRefs);
    const remove = (await inspectDocumentAssets(data)).attachments.find(item => item.description.startsWith('Remove'))!;
    data = asBuffer(await removeDocumentAttachment(data, remove.id));
    expect(await widgetRefs(data)).toEqual(originalRefs);
    expect(decodedStreams(data)).not.toContain(removedSecret);
    expect(decodedStreams(data)).not.toContain('ORPHAN_OLD_REVISION_SECRET_329178');
    expect(decodedStreams(data)).toContain(keptSecret);
  });
});

describe('DocumentAssets embedded files', () => {
  it('lists name-tree, AF, and annotation-only attachments once per Filespec while distinguishing identical filenames', async () => {
    const { pdf } = await complexFixture();
    const data = await save(pdf);
    const { attachments } = await inspectDocumentAssets(data);
    expect(attachments).toHaveLength(4);
    expect(new Set(attachments.map(item => item.id)).size).toBe(4);
    expect(attachments.filter(item => item.name === '报告 😀.txt')).toHaveLength(2);
    for (const attachment of attachments) {
      const extracted = await extractDocumentAttachment(data, attachment.id);
      expect(extracted.name).toBe(attachment.name);
      expect(extracted.mimeType).toBe('text/plain');
      expect(extracted.data.byteLength).toBe(attachment.size);
    }
    const remove = attachments.find(item => item.description.startsWith('Remove'))!;
    expect(new TextDecoder().decode((await extractDocumentAttachment(data, remove.id)).data)).toBe(removedSecret);
    const other = attachments.find(item => item.description.startsWith('Same'))!;
    expect(new TextDecoder().decode((await extractDocumentAttachment(data, other.id)).data)).toBe(keptSecret);
  });

  it('adds binary Unicode-named files without overwriting an existing attachment with the same filename', async () => {
    const input = await save(await blank());
    const bytes = new Uint8Array([99, 0, 1, 2, 255, 88]).subarray(1, 5);
    const first = await addDocumentAttachment(input, { name: '资料💾.bin', description: '描述', mimeType: 'application/octet-stream', data: bytes });
    const originalId = (await inspectDocumentAssets(asBuffer(first))).attachments[0].id;
    const output = await addDocumentAttachment(asBuffer(first), { name: '资料💾.bin', data: binary('SECOND_BINARY') });
    const list = (await inspectDocumentAssets(asBuffer(output))).attachments;
    expect(list.map(item => item.name)).toEqual(['资料💾.bin', '资料💾.bin']);
    expect(list.map(item => item.size).sort((a, b) => a - b)).toEqual([4, 13]);
    expect((await extractDocumentAttachment(asBuffer(output), list.find(item => item.size === 4)!.id)).data).toEqual(bytes);
    await expect(extractDocumentAttachment(asBuffer(output), originalId)).rejects.toThrow('Refresh the attachment list');
    const reader = new mupdf.PDFDocument(output);
    try {
      const files = reader.getEmbeddedFiles();
      expect(Object.keys(files)).toHaveLength(2);
      const contents = Object.values(files).map(specification => {
        try {
          expect(reader.getFilespecParams(specification).filename).toBe('资料💾.bin');
          const content = reader.getEmbeddedFileContents(specification)!;
          try { return Array.from(content.asUint8Array()); }
          finally { content.destroy(); }
        } finally { specification.destroy(); }
      });
      expect(contents).toContainEqual(Array.from(bytes));
      expect(contents).toContainEqual(Array.from(binary('SECOND_BINARY')));
    } finally { reader.destroy(); }
  });

  it('removes every reference to one attachment, including aliases, nested AF and annotation Popup, then drops its unreachable bytes', async () => {
    const { pdf } = await complexFixture();
    const source = await save(pdf);
    const copy = source.slice(0);
    const target = (await inspectDocumentAssets(source)).attachments.find(item => item.description.startsWith('Remove'))!;
    const output = await removeDocumentAttachment(source, target.id);
    const list = (await inspectDocumentAssets(asBuffer(output))).attachments;
    expect(list).toHaveLength(3);
    expect(list.some(item => item.description.startsWith('Remove'))).toBe(false);
    expect(list.find(item => item.name === '报告 😀.txt')?.description).toBe('Same filename, different content');
    const allStreams = decodedStreams(output);
    expect(allStreams).not.toContain(removedSecret);
    expect(allStreams).not.toContain('ORPHAN_OLD_REVISION_SECRET_329178');
    expect(allStreams).toContain(keptSecret);
    expect(allStreams).toContain('ONLY_AF_CONTENT');
    expect(allStreams).toContain('ONLY_ANNOTATION_CONTENT');
    const saved = await PDFDocument.load(output, { updateMetadata: false });
    const secondAnnots = saved.getPage(1).node.Annots()!;
    expect(secondAnnots.asArray().map((_, index) => secondAnnots.lookup(index, PDFDict).lookup(k('Subtype')))).toEqual([k('Widget')]);
    expect(saved.catalog.lookup(k('Names'), PDFDict).has(k('Dests'))).toBe(true);
    await assertDocumentContent(output);
    expect(source).toEqual(copy);
  });

  it('supports inline Filespec dictionaries and attachments that exist only in a page AF array', async () => {
    const pdf = await blank();
    const file = embedded(pdf, 'inline.txt', 'INLINE_CONTENT');
    pdf.getPage(1).node.set(k('AF'), pdf.context.obj([file.dictionary]));
    pdf.context.delete(file.reference);
    const source = await save(pdf);
    const [item] = (await inspectDocumentAssets(source)).attachments;
    expect(item.id).toContain(':inline:');
    expect(new TextDecoder().decode((await extractDocumentAttachment(source, item.id)).data)).toBe('INLINE_CONTENT');
    const output = await removeDocumentAttachment(source, item.id);
    expect((await inspectDocumentAssets(asBuffer(output))).attachments).toEqual([]);
    expect(decodedStreams(output)).not.toContain('INLINE_CONTENT');
  });

  it('writes one fresh revision so removed attachment and obsolete stream bytes do not survive in incremental history', async () => {
    const { pdf } = await complexFixture();
    const source = await save(pdf);
    const edited = new mupdf.PDFDocument(source);
    let incremental: ArrayBuffer;
    try {
      edited.setMetaData('info:Title', 'A later incremental version');
      const buffer = edited.saveToBuffer({ incremental: true });
      try { incremental = asBuffer(buffer.asUint8Array()); }
      finally { buffer.destroy(); }
    } finally { edited.destroy(); }
    const before = new mupdf.PDFDocument(incremental);
    try { expect(before.countVersions()).toBeGreaterThan(1); }
    finally { before.destroy(); }
    expect(new TextDecoder().decode(incremental)).toContain('ORPHAN_OLD_REVISION_SECRET_329178');
    const target = (await inspectDocumentAssets(incremental)).attachments.find(item => item.description.startsWith('Remove'))!;
    const output = await removeDocumentAttachment(incremental, target.id);
    const after = new mupdf.PDFDocument(output);
    try { expect(after.countVersions()).toBe(1); }
    finally { after.destroy(); }
    expect(decodedStreams(output)).not.toContain(removedSecret);
    expect(decodedStreams(output)).not.toContain('ORPHAN_OLD_REVISION_SECRET_329178');
    expect(decodedStreams(output)).toContain(keptSecret);
  });

  it('keeps a shared embedded stream needed by another distinct attachment', async () => {
    const pdf = await blank();
    const first = embedded(pdf, 'first.txt', 'INTENTIONALLY_SHARED_CONTENT');
    const second = pdf.context.register(pdf.context.obj({ Type: 'Filespec', F: PDFString.of('second.txt'), EF: { F: first.streamRef } }));
    pdf.catalog.set(k('AF'), pdf.context.obj([first.reference, second]));
    const source = await save(pdf);
    const target = (await inspectDocumentAssets(source)).attachments.find(item => item.name === 'first.txt')!;
    const output = await removeDocumentAttachment(source, target.id);
    const [remaining] = (await inspectDocumentAssets(asBuffer(output))).attachments;
    expect(remaining.name).toBe('second.txt');
    expect(new TextDecoder().decode((await extractDocumentAttachment(asBuffer(output), remaining.id)).data)).toBe('INTENTIONALLY_SHARED_CONTENT');
  });

  it.each(['filespec', 'stream'])('rejects deletion with an unsupported surviving %s reference instead of partially removing it', async referenceType => {
    const { pdf, remove } = await complexFixture();
    pdf.catalog.set(k('UnrecognizedAttachmentUse'), referenceType === 'filespec' ? remove.reference : remove.streamRef);
    const source = await save(pdf);
    const original = source.slice(0);
    const target = (await inspectDocumentAssets(source)).attachments.find(item => item.description.startsWith('Remove'))!;
    await expect(removeDocumentAttachment(source, target.id)).rejects.toThrow(/additional references|referenced outside/);
    expect(source).toEqual(original);
    expect((await inspectDocumentAssets(source)).attachments).toHaveLength(4);
  });

  it('does not mutate a shared AF array through an unrecognized alias', async () => {
    const pdf = await blank();
    const attachment = embedded(pdf, 'aliased.txt', 'MUST_NOT_SILENTLY_REMOVE_UNKNOWN_ALIAS');
    const array = pdf.context.register(pdf.context.obj([attachment.reference]));
    pdf.catalog.set(k('AF'), array);
    pdf.catalog.set(k('PrivateAssociatedFiles'), array);
    const input = await save(pdf);
    const [target] = (await inspectDocumentAssets(input)).attachments;
    await expect(removeDocumentAttachment(input, target.id)).rejects.toThrow('additional references');
  });

  it('rejects cyclic name trees, malformed streams, missing attachments, and damaged PDFs', async () => {
    const pdf = await blank();
    const tree = pdf.context.obj({});
    const treeRef = pdf.context.register(tree);
    tree.set(k('Kids'), pdf.context.obj([treeRef]));
    pdf.catalog.set(k('Names'), pdf.context.obj({ EmbeddedFiles: treeRef }));
    await expect(inspectDocumentAssets(await save(pdf))).rejects.toThrow('cyclic');
    const malformed = await blank();
    malformed.catalog.set(k('AF'), malformed.context.obj([{ Type: 'Filespec', F: PDFString.of('bad.bin'), EF: { F: PDFNumber.of(4) } }]));
    await expect(inspectDocumentAssets(await save(malformed))).rejects.toThrow('invalid embedded stream');
    const clean = await save(await blank());
    await expect(removeDocumentAttachment(clean, 'stale-id')).rejects.toThrow('Refresh');
    await expect(inspectDocumentAssets(binary('not a PDF').buffer)).rejects.toThrow();
  });

  it('refuses encrypted input rather than treating ignored encryption as decoded attachment content', async () => {
    const { pdf } = await complexFixture();
    const source = new mupdf.PDFDocument(await save(pdf));
    let encrypted: ArrayBuffer;
    try {
      const buffer = source.saveToBuffer({ encrypt: 'aes-256', 'user-password': 'secret', 'owner-password': 'owner' });
      try { encrypted = asBuffer(buffer.asUint8Array()); }
      finally { buffer.destroy(); }
    } finally { source.destroy(); }
    await expect(inspectDocumentAssets(encrypted)).rejects.toThrow(/encrypted/i);
    await expect(clearDocumentMetadata(encrypted)).rejects.toThrow(/encrypted/i);
  });

  it('reports unsupported stream filters and size mismatches instead of extracting incomplete files', async () => {
    for (const kind of ['filter', 'size']) {
      const pdf = await blank();
      const attachment = embedded(pdf, 'corrupt.bin', 'CONTENT');
      pdf.catalog.set(k('AF'), pdf.context.obj([attachment.reference]));
      if (kind === 'filter') attachment.stream.dict.set(k('Filter'), k('UnsupportedAttachmentFilter'));
      else attachment.stream.dict.lookup(k('Params'), PDFDict).set(k('Size'), PDFNumber.of(10000));
      const input = await save(pdf);
      await expect(inspectDocumentAssets(input)).rejects.toThrow(kind === 'filter' ? 'Cannot decode' : 'declared size');
      await expect(clearDocumentMetadata(input)).rejects.toThrow();
    }
  });

  it('produces independently readable embedded stream dictionaries with valid MIME types and decoded sizes', async () => {
    const output = await addDocumentAttachment(await save(await blank()), { name: 'script.js', mimeType: 'text/javascript', data: binary('alert("never execute attachments")') });
    const pdf = await PDFDocument.load(output, { updateMetadata: false });
    const names = pdf.catalog.lookup(k('Names'), PDFDict).lookup(k('EmbeddedFiles'), PDFDict).lookup(k('Names'), PDFArray);
    const specification = names.lookup(1, PDFDict);
    const stream = specification.lookup(k('EF'), PDFDict).lookup(k('UF'), PDFRawStream);
    expect(stream.dict.lookup(k('Subtype'), PDFName).decodeText()).toBe('text/javascript');
    expect(new TextDecoder().decode(decodePDFRawStream(stream).decode())).toBe('alert("never execute attachments")');
    expect(stream.dict.lookup(k('Params'), PDFDict).lookup(k('Size'), PDFNumber).asNumber()).toBe(34);
  });
});
