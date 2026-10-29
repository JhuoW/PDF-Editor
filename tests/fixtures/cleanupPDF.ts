import { PDFDocument, PDFName, PDFString, PDFHexString, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream, type PDFObject } from 'pdf-lib';

export const CLEANUP_SECRETS = {
  author: 'PRIVATE_AUTHOR_739251', metadata: 'PRIVATE_XMP_739251', attachment: 'PRIVATE_ATTACHMENT_739251',
  script: 'PRIVATE_SCRIPT_739251', comment: 'PRIVATE_COMMENT_739251', form: 'PRIVATE_FORM_739251', defaultValue: 'PRIVATE_DEFAULT_739251',
};

export async function createCleanupPDF() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Cleanup sample'); pdf.setAuthor(CLEANUP_SECRETS.author);
  const page = pdf.addPage([400, 600]); page.drawText('Original body text', { x: 30, y: 520, size: 12 });
  pdf.addPage([400, 600]).drawText('Second page content', { x: 30, y: 520, size: 12 });
  const field = pdf.getForm().createTextField('Contact'); field.setText(CLEANUP_SECRETS.form);
  field.addToPage(page, { x: 30, y: 400, width: 300, height: 28 });
  field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(CLEANUP_SECRETS.defaultValue));
  const metadata = pdf.context.register(pdf.context.flateStream(`<x:xmpmeta xmlns:x="adobe:ns:meta/">${CLEANUP_SECRETS.metadata}</x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' }));
  pdf.catalog.set(PDFName.of('Metadata'), metadata);
  await pdf.attach(new TextEncoder().encode(CLEANUP_SECRETS.attachment), 'private.txt', { mimeType: 'text/plain', description: 'Private attachment' });
  pdf.addJavaScript('Startup', `app.alert('${CLEANUP_SECRETS.script}');`);
  const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [330, 300, 350, 320],
    Contents: PDFHexString.fromText(CLEANUP_SECRETS.comment), T: PDFString.of('Reviewer'), Name: 'Note', C: [1, 1, 0], P: page.ref }));
  const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 250, 200, 270], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.com/review') }, P: page.ref }));
  page.node.addAnnot(note); page.node.addAnnot(link);
  return new Uint8Array(await pdf.save());
}

/** Independent test inspection includes every stored object, not only the catalog graph. */
export async function decodedPDFStrings(data: Uint8Array | ArrayBuffer) {
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  const seen = new Set<PDFObject>(), values: string[] = [];
  const walk = (input: PDFObject) => {
    const object = pdf.context.lookup(input); if (!object || seen.has(object)) return; seen.add(object);
    if (object instanceof PDFString || object instanceof PDFHexString) values.push(object.decodeText());
    else if (object instanceof PDFDict) for (const [, child] of object.entries()) walk(child);
    else if (object instanceof PDFArray) for (const child of object.asArray()) walk(child);
    else if (object instanceof PDFRawStream) {
      walk(object.dict);
      try { values.push(new TextDecoder().decode(decodePDFRawStream(object).decode())); }
      catch { values.push(new TextDecoder().decode(object.contents)); }
    }
  };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) walk(object);
  return values.join('\n');
}
