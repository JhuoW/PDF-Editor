import { PDFDocument, PDFHexString, PDFName, PDFString, rgb } from 'pdf-lib';

export async function createLinksPDF() {
  const pdf = await PDFDocument.create(), pages = Array.from({ length: 3 }, () => pdf.addPage([400, 600]));
  pages.forEach((page, index) => page.drawText(`Link document page ${index + 1}`, { x: 30, y: 560, size: 16 }));
  pages[0].drawText('Original link body', { x: 30, y: 520, size: 12 });
  const definitions = [
    { text: 'Original website', y: 470, action: pdf.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/original') }) },
    { text: 'Go to third page', y: 430, destination: pdf.context.obj([pages[2].ref, 'XYZ', 30, 520, 1.5]) },
    { text: 'Named chapter', y: 390, destination: PDFString.of('chapter-two') },
    { text: 'Unsupported action', y: 350, action: pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("must not execute")') }) },
  ];
  const refs = definitions.map(definition => {
    pages[0].drawText(definition.text, { x: 30, y: definition.y, size: 12, color: rgb(0, .2, .8) });
    const dictionary = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', P: pages[0].ref, Rect: [28, definition.y - 3, 185, definition.y + 15],
      Border: [0, 0, 1], C: [0, .2, .8], Contents: PDFHexString.fromText(definition.text), F: 4 });
    if (definition.action) dictionary.set(PDFName.of('A'), definition.action);
    if (definition.destination) dictionary.set(PDFName.of('Dest'), definition.destination);
    return pdf.context.register(dictionary);
  });
  pages[0].node.set(PDFName.of('Annots'), pdf.context.obj(refs));
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({ Dests: pdf.context.register(pdf.context.obj({ Names: [PDFString.of('chapter-two'), pdf.context.obj([pages[1].ref, 'FitH', 520])] })) }));
  const contact = pdf.getForm().createTextField('Contact'); contact.setText('Original form'); contact.addToPage(pages[1], { x: 30, y: 100, width: 220, height: 24 });
  return new Uint8Array(await pdf.save());
}
