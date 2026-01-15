import { PDFDocument, degrees } from 'pdf-lib';

export interface PageRange {
  start: number;  // 1-indexed
  end: number;    // 1-indexed, inclusive
}

export interface SplitOptions {
  mode: 'ranges' | 'every-n-pages' | 'extract-pages';
  ranges?: PageRange[];
  everyN?: number;
  pages?: number[];  // For extract-pages mode
}

export interface InsertOptions {
  position: number;  // 1-indexed, insert before this page (0 = end)
  count?: number;    // For blank pages
  width?: number;    // Page width in points (default: 612 = Letter)
  height?: number;   // Page height in points (default: 792 = Letter)
}

/**
 * Merge multiple PDF files into one
 */
export async function mergePDFs(files: ArrayBuffer[]): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  for (const file of files) {
    const pdf = await PDFDocument.load(file);
    const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    pages.forEach(page => mergedPdf.addPage(page));
  }

  return mergedPdf.save();
}

/**
 * Split a PDF into multiple parts
 */
export async function splitPDF(
  source: ArrayBuffer,
  options: SplitOptions
): Promise<Uint8Array[]> {
  const sourcePdf = await PDFDocument.load(source);
  const totalPages = sourcePdf.getPageCount();
  const results: Uint8Array[] = [];

  if (options.mode === 'ranges' && options.ranges) {
    for (const range of options.ranges) {
      const newPdf = await PDFDocument.create();
      const startIdx = Math.max(0, range.start - 1);
      const endIdx = Math.min(totalPages - 1, range.end - 1);

      const pageIndices: number[] = [];
      for (let i = startIdx; i <= endIdx; i++) {
        pageIndices.push(i);
      }

      const pages = await newPdf.copyPages(sourcePdf, pageIndices);
      pages.forEach(page => newPdf.addPage(page));
      results.push(await newPdf.save());
    }
  } else if (options.mode === 'every-n-pages' && options.everyN) {
    const n = options.everyN;
    for (let i = 0; i < totalPages; i += n) {
      const newPdf = await PDFDocument.create();
      const pageIndices: number[] = [];
      for (let j = i; j < Math.min(i + n, totalPages); j++) {
        pageIndices.push(j);
      }
      const pages = await newPdf.copyPages(sourcePdf, pageIndices);
      pages.forEach(page => newPdf.addPage(page));
      results.push(await newPdf.save());
    }
  } else if (options.mode === 'extract-pages' && options.pages) {
    const newPdf = await PDFDocument.create();
    const pageIndices = options.pages
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages);
    const pages = await newPdf.copyPages(sourcePdf, pageIndices);
    pages.forEach(page => newPdf.addPage(page));
    results.push(await newPdf.save());
  }

  return results;
}

/**
 * Reorder pages in a PDF
 */
export async function reorderPages(
  source: ArrayBuffer,
  newOrder: number[]  // Array of 1-indexed page numbers in new order
): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(source);
  const newPdf = await PDFDocument.create();

  const pageIndices = newOrder.map(p => p - 1);
  const pages = await newPdf.copyPages(sourcePdf, pageIndices);
  pages.forEach(page => newPdf.addPage(page));

  return newPdf.save();
}

/**
 * Rotate specific pages in a PDF
 */
export async function rotatePages(
  source: ArrayBuffer,
  pageNumbers: number[],  // 1-indexed
  rotationDegrees: 90 | 180 | 270 | -90
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source);
  const normalizedRotation = rotationDegrees < 0 ? 360 + rotationDegrees : rotationDegrees;

  for (const pageNum of pageNumbers) {
    const pageIndex = pageNum - 1;
    if (pageIndex >= 0 && pageIndex < pdf.getPageCount()) {
      const page = pdf.getPage(pageIndex);
      const currentRotation = page.getRotation().angle;
      page.setRotation(degrees((currentRotation + normalizedRotation) % 360));
    }
  }

  return pdf.save();
}

/**
 * Delete specific pages from a PDF
 */
export async function deletePages(
  source: ArrayBuffer,
  pageNumbers: number[]  // 1-indexed pages to delete
): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(source);
  const totalPages = sourcePdf.getPageCount();
  const newPdf = await PDFDocument.create();

  const pagesToDelete = new Set(pageNumbers.map(p => p - 1));
  const pageIndicesToKeep: number[] = [];

  for (let i = 0; i < totalPages; i++) {
    if (!pagesToDelete.has(i)) {
      pageIndicesToKeep.push(i);
    }
  }

  if (pageIndicesToKeep.length === 0) {
    throw new Error('Cannot delete all pages');
  }

  const pages = await newPdf.copyPages(sourcePdf, pageIndicesToKeep);
  pages.forEach(page => newPdf.addPage(page));

  return newPdf.save();
}

/**
 * Insert blank pages into a PDF
 */
export async function insertBlankPages(
  source: ArrayBuffer,
  options: InsertOptions
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source);
  const count = options.count || 1;
  const width = options.width || 612;  // Letter width
  const height = options.height || 792; // Letter height

  // Insert position (0-indexed)
  let insertIndex = options.position === 0
    ? pdf.getPageCount()
    : options.position - 1;

  insertIndex = Math.max(0, Math.min(insertIndex, pdf.getPageCount()));

  for (let i = 0; i < count; i++) {
    pdf.insertPage(insertIndex + i, [width, height]);
  }

  return pdf.save();
}

/**
 * Insert pages from another PDF
 */
export async function insertPagesFromPDF(
  targetSource: ArrayBuffer,
  insertSource: ArrayBuffer,
  position: number,  // 1-indexed, insert before this page (0 = end)
  pageNumbers?: number[]  // 1-indexed pages from source to insert (all if undefined)
): Promise<Uint8Array> {
  const targetPdf = await PDFDocument.load(targetSource);
  const sourcePdf = await PDFDocument.load(insertSource);

  // Determine which pages to copy
  const pageIndices = pageNumbers
    ? pageNumbers.map(p => p - 1).filter(i => i >= 0 && i < sourcePdf.getPageCount())
    : sourcePdf.getPageIndices();

  const pages = await targetPdf.copyPages(sourcePdf, pageIndices);

  // Insert position (0-indexed)
  let insertIndex = position === 0
    ? targetPdf.getPageCount()
    : position - 1;

  insertIndex = Math.max(0, Math.min(insertIndex, targetPdf.getPageCount()));

  // Insert pages at position
  pages.forEach((page, i) => {
    targetPdf.insertPage(insertIndex + i, page);
  });

  return targetPdf.save();
}

/**
 * Export PDF as downloadable file with Save As dialog
 * Uses File System Access API for modern browsers, falls back to traditional download
 */
export async function downloadPDF(data: Uint8Array, fileName: string): Promise<void> {
  const blob = new Blob([new Uint8Array(data)], { type: 'application/pdf' });

  // Try to use File System Access API (modern browsers)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as Window & { showSaveFilePicker: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'PDF Document',
          accept: { 'application/pdf': ['.pdf'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User cancelled or API failed - fall back to traditional download
      if (err instanceof Error && err.name === 'AbortError') {
        // User cancelled the dialog - just return without downloading
        return;
      }
      // For other errors, fall through to traditional download
      console.warn('File System Access API failed, falling back to traditional download:', err);
    }
  }

  // Fallback: traditional download
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Type declarations for File System Access API
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: {
    description: string;
    accept: Record<string, string[]>;
  }[];
}
