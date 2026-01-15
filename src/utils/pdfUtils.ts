import { PDFDocument, degrees } from 'pdf-lib';

export interface PageRange {
  start: number;
  end: number;
}

export async function mergePDFs(files: ArrayBuffer[]): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  for (const file of files) {
    const pdf = await PDFDocument.load(file);
    const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    pages.forEach((page) => mergedPdf.addPage(page));
  }

  return mergedPdf.save();
}

export async function splitPDF(
  file: ArrayBuffer,
  ranges: PageRange[]
): Promise<Uint8Array[]> {
  const sourcePdf = await PDFDocument.load(file);
  const results: Uint8Array[] = [];

  for (const range of ranges) {
    const newPdf = await PDFDocument.create();
    const pageIndices = Array.from(
      { length: range.end - range.start + 1 },
      (_, i) => range.start - 1 + i
    );
    const pages = await newPdf.copyPages(sourcePdf, pageIndices);
    pages.forEach((page) => newPdf.addPage(page));
    results.push(await newPdf.save());
  }

  return results;
}

export async function extractPages(
  file: ArrayBuffer,
  pageNumbers: number[]
): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(file);
  const newPdf = await PDFDocument.create();

  const pageIndices = pageNumbers.map((n) => n - 1);
  const pages = await newPdf.copyPages(sourcePdf, pageIndices);
  pages.forEach((page) => newPdf.addPage(page));

  return newPdf.save();
}

export async function rotatePage(
  file: ArrayBuffer,
  pageNumber: number,
  rotationDegrees: 90 | 180 | 270
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(file);
  const page = pdf.getPage(pageNumber - 1);
  const currentRotation = page.getRotation().angle;
  page.setRotation(degrees((currentRotation + rotationDegrees) % 360));
  return pdf.save();
}

export async function deletePage(
  file: ArrayBuffer,
  pageNumber: number
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(file);
  pdf.removePage(pageNumber - 1);
  return pdf.save();
}

export async function insertBlankPage(
  file: ArrayBuffer,
  afterPage: number,
  width: number = 612,
  height: number = 792
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(file);
  pdf.insertPage(afterPage, [width, height]);
  return pdf.save();
}

