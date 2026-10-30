import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRadioGroup, PDFCheckBox, degrees, type PDFObject } from 'pdf-lib';
import { deletionPageMap, insertionPageMap, reorderedPageMap } from './pageMapping';
import { copyPagesWithForms } from './copyPagesWithForms';
import { removePDFLinksToPages, stabilizePDFLinkPageReferences } from './PDFLinkDestinations';

import { removePDFBookmarksToPages, stabilizePDFBookmarkPageReferences } from './PDFBookmarkPageOperations';

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
    const pages = await copyPagesWithForms(mergedPdf, pdf, pdf.getPageIndices());
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

      const pages = await copyPagesWithForms(newPdf, sourcePdf, pageIndices);
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
      const pages = await copyPagesWithForms(newPdf, sourcePdf, pageIndices);
      pages.forEach(page => newPdf.addPage(page));
      results.push(await newPdf.save());
    }
  } else if (options.mode === 'extract-pages' && options.pages) {
    const newPdf = await PDFDocument.create();
    const pageIndices = options.pages
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages);
    const pages = await copyPagesWithForms(newPdf, sourcePdf, pageIndices);
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
  const pdf = await PDFDocument.load(source);
  reorderedPageMap(pdf.getPageCount(), newOrder);
  stabilizePDFLinkPageReferences(pdf);
  stabilizePDFBookmarkPageReferences(pdf);
  const pages = pdf.getPages();
  // Reuse the original page objects and catalog so forms, links and metadata survive.
  for (let index = pages.length - 1; index >= 0; index--) pdf.removePage(index);
  for (const pageNumber of newOrder) pdf.addPage(pages[pageNumber - 1]);
  return pdf.save();
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
  const pdf = await PDFDocument.load(source);
  const pageMap = deletionPageMap(pdf.getPageCount(), pageNumbers);
  stabilizePDFLinkPageReferences(pdf);
  stabilizePDFBookmarkPageReferences(pdf);
  const pages = pdf.getPages();
  const deletedPages = pages.filter((_, index) => !pageMap.has(index + 1));
  removePDFBookmarksToPages(pdf, new Set(pages.flatMap((_, index) => pageMap.has(index + 1) ? [] : [index + 1])));
  removePDFLinksToPages(pdf, new Set(pages.flatMap((_, index) => pageMap.has(index + 1) ? [] : [index + 1])));
  const deletedRefs = new Set(deletedPages.map(page => page.ref));
  const deletedAnnotations = new Set<PDFDict>();
  const removedFields = new Set<PDFObject>();
  for (const page of deletedPages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index++) {
      const annotation = annots.lookup(index);
      if (annotation instanceof PDFDict) deletedAnnotations.add(annotation);
    }
  }
  // Remove deleted widgets without removing a shared field's surviving widgets.
  const form = pdf.getForm();
  for (const field of form.getFields()) {
    const selected = field instanceof PDFRadioGroup ? field.getSelected() : undefined;
    const widgets = field.acroField.getWidgets();
    for (let index = widgets.length - 1; index >= 0; index--) {
      const widget = widgets[index];
      if (deletedRefs.has(widget.P()!) || deletedAnnotations.has(widget.dict)) {
        if (field instanceof PDFRadioGroup || field instanceof PDFCheckBox) {
          field.acroField.removeExportValue(index);
        }
        field.acroField.removeWidget(index);
      }
    }
    if (field.acroField.getWidgets().length === 0) {
      removedFields.add(field.ref); removedFields.add(field.acroField.dict);
      form.removeField(field);
    }
    else if (field instanceof PDFRadioGroup && selected && !field.getOptions().includes(selected)) field.clear();
  }
  const acro = pdf.catalog.getAcroForm(), order = acro?.dict.lookup(PDFName.of('CO'));
  if (order instanceof PDFArray && removedFields.size) {
    const retained = order.asArray().filter(raw => !removedFields.has(raw) && !removedFields.has(pdf.context.lookup(raw)!));
    if (retained.length) acro!.dict.set(PDFName.of('CO'), pdf.context.obj(retained));
    else acro!.dict.delete(PDFName.of('CO'));
  }
  for (let index = pages.length - 1; index >= 0; index--) {
    if (!pageMap.has(index + 1)) pdf.removePage(index);
  }
  return pdf.save();
}

/**
 * Insert blank pages into a PDF
 */
export async function insertBlankPages(
  source: ArrayBuffer,
  options: InsertOptions
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source);
  const count = options.count ?? 1;
  insertionPageMap(pdf.getPageCount(), options.position, count);
  stabilizePDFLinkPageReferences(pdf);
  stabilizePDFBookmarkPageReferences(pdf);
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

  insertionPageMap(targetPdf.getPageCount(), position, pageIndices.length);
  stabilizePDFLinkPageReferences(targetPdf);
  stabilizePDFBookmarkPageReferences(targetPdf);
  const pages = await copyPagesWithForms(targetPdf, sourcePdf, pageIndices);

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
