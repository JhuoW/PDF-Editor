import { PDFDocument, PDFName, PDFString, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import { createCleanupPDF } from './cleanupPDF';

/** A real, compressible PDF with editable text, native form, note, link and attachment. */
export async function createOptimizationPDF() {
  const pdf = await PDFDocument.load(await createCleanupPDF(), { updateMetadata: false });
  pdf.setTitle('Compression sample');
  const page = pdf.getPage(0), width = 960, height = 640;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = Math.round(x * 255 / (width - 1));
    pixels[offset + 1] = Math.round(y * 255 / (height - 1));
    pixels[offset + 2] = 90 + ((x * 13 + y * 7) % 40);
  }
  const image = pdf.context.register(pdf.context.stream(pixels, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  const name = page.node.newXObject('CompressionSample', image);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(216, 0, 0, 144, 30, 50), drawObject(name), popGraphicsState());
  page.node.addContentStream(pdf.context.register(pdf.context.stream('q Q\n'.repeat(30_000))));
  const outline = pdf.context.obj({ Type: 'Outlines', Count: 1 }), outlineRef = pdf.context.register(outline);
  const bookmark = pdf.context.register(pdf.context.obj({ Title: PDFString.of('Second page bookmark'), Parent: outlineRef, Dest: [pdf.getPage(1).ref, 'Fit'] }));
  outline.set(PDFName.of('First'), bookmark); outline.set(PDFName.of('Last'), bookmark);
  pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}
