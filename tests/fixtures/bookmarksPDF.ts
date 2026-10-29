import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { createLinksPDF } from './linksPDF';
export async function createBookmarksPDF() {
  const pdf = await PDFDocument.load(await createLinksPDF()), context = pdf.context, pages = pdf.getPages();
  const root = context.obj({ Type: 'Outlines' }), rootRef = context.register(root);
  const intro = context.obj({ Title: PDFHexString.fromText('Introduction'), Parent: rootRef, Dest: [pages[0].ref, 'Fit'], C: [0, 0, .8], F: 2 });
  const chapter = context.obj({ Title: PDFHexString.fromText('Chapter group'), Parent: rootRef, Count: -1 });
  const firstRef = context.register(intro), groupRef = context.register(chapter);
  const child = context.obj({ Title: PDFHexString.fromText('第三页'), Parent: groupRef, Dest: [pages[2].ref, 'XYZ', 30, 520, 1.5] }), childRef = context.register(child);
  intro.set(PDFName.of('Next'), groupRef); chapter.set(PDFName.of('Prev'), firstRef); chapter.set(PDFName.of('First'), childRef); chapter.set(PDFName.of('Last'), childRef);
  root.set(PDFName.of('First'), firstRef); root.set(PDFName.of('Last'), groupRef); root.set(PDFName.of('Count'), context.obj(2)); pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  return pdf.save();
}
