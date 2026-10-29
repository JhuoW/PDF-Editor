/** Convert existing widget appearances to page content without rebuilding them. */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';

function numbers(array: unknown, length: number): number[] | undefined {
  if (!(array instanceof PDFArray) || array.size() !== length) return undefined;
  const values = Array.from({ length }, (_, index) => array.lookup(index));
  return values.every(value => value instanceof PDFNumber && Number.isFinite(value.asNumber()))
    ? values.map(value => (value as PDFNumber).asNumber()) : undefined;
}

/** Validate before baking: an orphan or missing appearance must not lose its value. */
function inspectForm(pdf: PDFDocument) {
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  // getForm() removes XFA automatically, so inspect the catalog first.
  if (acroForm?.has(PDFName.of('XFA'))) throw new Error('XFA forms cannot be flattened.');
  const widgetPages = new Map<PDFDict, number[]>();
  const annotationCounts = pdf.getPages().map((page, pageIndex) => {
    const annotations = page.node.Annots();
    let remaining = 0;
    if (annotations) for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookup(index);
      if (!(annotation instanceof PDFDict)) throw new Error(`Page ${pageIndex + 1} has an invalid annotation reference.`);
      if (annotation.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        const pages = widgetPages.get(annotation) ?? [];
        pages.push(pageIndex + 1);
        widgetPages.set(annotation, pages);
      } else remaining++;
    }
    return remaining;
  });
  const fields = pdf.getForm().getFields();
  const knownWidgets = new Set<PDFDict>();
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    if (!widgets.length) throw new Error(`Field "${field.getName()}" has no page widget.`);
    for (const widget of widgets) {
      if (widgetPages.get(widget.dict)?.length !== 1) {
        throw new Error(`Field "${field.getName()}" has a widget that does not belong to exactly one page.`);
      }
      knownWidgets.add(widget.dict);
      let appearance = widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.lookup(PDFName.of('N'));
      if (appearance instanceof PDFDict) {
        appearance = appearance.lookup(widget.getAppearanceState() ?? PDFName.of('Off'));
      }
      if (!(appearance instanceof PDFStream)) throw new Error(`Field "${field.getName()}" has no usable appearance for its current state.`);
      const box = numbers(appearance.dict.lookup(PDFName.of('BBox')), 4);
      const matrixObject = appearance.dict.lookup(PDFName.of('Matrix'));
      const matrix = matrixObject === undefined ? [1, 0, 0, 1, 0, 0] : numbers(matrixObject, 6);
      const rect = numbers(widget.dict.lookup(PDFName.of('Rect')), 4);
      if (!box || box[2] <= box[0] || box[3] <= box[1] || !rect || rect[2] <= rect[0] || rect[3] <= rect[1]
        || !matrix || matrix[0] * matrix[3] - matrix[1] * matrix[2] === 0) {
        throw new Error(`Field "${field.getName()}" has invalid appearance geometry.`);
      }
    }
  }
  if (knownWidgets.size !== widgetPages.size) throw new Error('A page widget is missing from the form field tree.');
  return { fieldCount: fields.length, annotationCounts };
}

export async function flattenForm(pdfData: ArrayBuffer): Promise<Uint8Array> {
  try {
    // Work on private bytes; no partially flattened result is ever published.
    const bytes = new Uint8Array(pdfData.slice(0));
    const source = await PDFDocument.load(bytes);
    const { fieldCount, annotationCounts } = inspectForm(source);
    if (fieldCount === 0) return bytes;
    const engine = await loadMuPDF();
    const document = new engine.PDFDocument(bytes);
    try {
      // Every current appearance has been checked. Do not let a producer's
      // NeedAppearances flag regenerate embedded Unicode or custom artwork.
      const trailer = document.getTrailer();
      const acroForm = trailer.get('Root', 'AcroForm');
      try { acroForm.put('NeedAppearances', false); }
      finally { acroForm.destroy(); trailer.destroy(); }
      // MuPDF applies the AP BBox/Matrix-to-Rect mapping and removes actual
      // widget references. pdf-lib's flatten only translates the appearance.
      document.bake(false, true);
      const saved = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
      let output: Uint8Array;
      try { output = new Uint8Array(saved.asUint8Array()); }
      finally { saved.destroy(); }
      const verified = await PDFDocument.load(output);
      const result = inspectForm(verified);
      if (result.fieldCount !== 0 || result.annotationCounts.some((count, index) => count !== annotationCounts[index])) {
        throw new Error('The flattened PDF did not retain all non-form annotations.');
      }
      return output;
    } finally { document.destroy(); }
  } catch (error) {
    throw new Error(`Could not flatten form: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Invalid or encrypted input is an error, never evidence of an empty form. */
export async function isFlattened(pdfData: ArrayBuffer): Promise<boolean> {
  return await getFormFieldCount(pdfData) === 0;
}

export async function getFormFieldCount(pdfData: ArrayBuffer): Promise<number> {
  return inspectForm(await PDFDocument.load(pdfData)).fieldCount;
}
