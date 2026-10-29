import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfjsLib, pdfDocumentOptions } from '../utils/pdfConfig';
import { resolvePDFLinkNavigation } from './PDFLinkNavigation';

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
  id: string; title: string; pageNumber?: number; dest: unknown; url?: string;
  bold: boolean; italic: boolean; color: string; expanded: boolean;
  children: Outline[]; unsupportedReason?: string;
}

export async function loadPDFDocument(
  source: string | ArrayBuffer | Uint8Array
): Promise<PDFDocumentProxy> {
  try {
    const loadingTask = pdfjsLib.getDocument({ ...pdfDocumentOptions, ...(typeof source === 'string' ? { url: source } : { data: source }) });
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

export async function getPDFOutline(doc: PDFDocumentProxy, signal?: AbortSignal): Promise<Outline[]> {
  signal?.throwIfAborted();
  const outline = await doc.getOutline(); signal?.throwIfAborted();
  if (!outline) return [];
  let count = 0;
  const process = async (items: typeof outline, prefix: string, depth: number): Promise<Outline[]> => {
    if (depth > 64) throw new Error('The bookmark tree is too deeply nested.');
    const result: Outline[] = [];
    for (const [index, item] of items.entries()) {
      signal?.throwIfAborted();
      if (++count > 10000) throw new Error('This PDF has too many bookmarks to display.');
      const id = `${prefix}${index}`, node: Outline = { id, title: item.title, dest: null,
        bold: !!item.bold, italic: !!item.italic, expanded: (item.count ?? 0) >= 0,
        color: `#${Array.from(item.color ?? [0, 0, 0], channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')).join('')}`,
        children: [] };
      if (item.dest) {
        try {
          const destination = await resolvePDFLinkNavigation(doc, item.dest, () => !signal?.aborted);
          if (destination) { node.pageNumber = destination.pageNumber; node.dest = item.dest; }
          else node.unsupportedReason = 'This bookmark does not point to an available page.';
        } catch { node.unsupportedReason = 'The bookmark destination could not be resolved.'; }
      } else if (item.url) {
        try { if (['http:', 'https:', 'mailto:'].includes(new URL(item.url).protocol)) node.url = item.url; } catch { /* Do not follow malformed addresses. */ }
        if (!node.url) node.unsupportedReason = 'This bookmark address is not supported.';
      } else if (item.unsafeUrl || ('action' in item && item.action)) node.unsupportedReason = 'This bookmark action is not supported.';
      signal?.throwIfAborted();
      node.children = item.items?.length ? await process(item.items, `${id}.`, depth + 1) : [];
      result.push(node);
    }
    return result;
  };
  return process(outline, '', 0);
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
