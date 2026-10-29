import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const LAYOUT_ORIGINAL = 'Original title';
export const LAYOUT_NEIGHBOR = 'Neighbor content stays';

export async function createTextLayoutPDF() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([400, 600]);
  page.drawText(LAYOUT_ORIGINAL, { x: 30, y: 520, size: 12, font, color: rgb(.2, .1, .6) });
  page.drawText(LAYOUT_NEIGHBOR, { x: 30, y: 420, size: 12 });
  page.drawRectangle({ x: 230, y: 280, width: 100, height: 35, color: rgb(.7, .9, 1) });
  const field = pdf.getForm().createTextField('Contact');
  field.setText('Original form value'); field.addToPage(page, { x: 30, y: 100, width: 200, height: 20 });
  pdf.addPage([400, 600]).drawText('Second page remains unchanged', { x: 30, y: 520, size: 12 });
  return new Uint8Array(await pdf.save());
}
