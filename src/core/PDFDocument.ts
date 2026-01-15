import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib } from '../utils/pdfConfig';

export class PDFLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PDFLoadError';
  }
}

export class PDFRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PDFRenderError';
  }
}

export interface PDFMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
}

export interface Outline {
  title: string;
  pageNumber: number;
  children?: Outline[];
}

export async function loadPDFDocument(
  source: string | ArrayBuffer | Uint8Array
): Promise<PDFDocumentProxy> {
  try {
    const loadingTask = pdfjsLib.getDocument(source);
    return await loadingTask.promise;
  } catch (error) {
    throw new PDFLoadError(
      error instanceof Error ? error.message : 'Failed to load PDF document'
    );
  }
}

export async function getPDFMetadata(doc: PDFDocumentProxy): Promise<PDFMetadata> {
  const metadata = await doc.getMetadata();
  const info = metadata.info as Record<string, unknown>;

  return {
    title: info.Title as string | undefined,
    author: info.Author as string | undefined,
    subject: info.Subject as string | undefined,
    keywords: info.Keywords as string | undefined,
    creator: info.Creator as string | undefined,
    producer: info.Producer as string | undefined,
    creationDate: info.CreationDate ? new Date(info.CreationDate as string) : undefined,
    modificationDate: info.ModDate ? new Date(info.ModDate as string) : undefined,
  };
}

export async function getPDFOutline(doc: PDFDocumentProxy): Promise<Outline[]> {
  const outline = await doc.getOutline();
  if (!outline) return [];

  const processOutline = async (items: typeof outline): Promise<Outline[]> => {
    const result: Outline[] = [];
    for (const item of items) {
      const dest = item.dest;
      let pageNumber = 1;

      if (typeof dest === 'string') {
        const destination = await doc.getDestination(dest);
        if (destination) {
          const pageIndex = await doc.getPageIndex(destination[0]);
          pageNumber = pageIndex + 1;
        }
      } else if (Array.isArray(dest)) {
        const pageIndex = await doc.getPageIndex(dest[0]);
        pageNumber = pageIndex + 1;
      }

      result.push({
        title: item.title,
        pageNumber,
        children: item.items ? await processOutline(item.items) : undefined,
      });
    }
    return result;
  };

  return processOutline(outline);
}

export async function getPage(
  doc: PDFDocumentProxy,
  pageNumber: number
): Promise<PDFPageProxy> {
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PDFRenderError(`Invalid page number: ${pageNumber}`);
  }
  return doc.getPage(pageNumber);
}
