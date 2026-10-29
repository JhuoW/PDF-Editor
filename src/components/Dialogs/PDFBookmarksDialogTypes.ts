import type { PDFBookmarkDraft, PDFBookmarkInspection } from '../../core/PDFBookmarksTypes';
export interface PDFBookmarksSource {
  data: ArrayBuffer;
  report: PDFBookmarkInspection;
  preview: (tree: PDFBookmarkDraft[], signal: AbortSignal) => Promise<Uint8Array>;
}
export interface PDFBookmarksDialogProps {
  documentKey: unknown;
  revision: number;
  currentPage: number;
  readPDF: (signal: AbortSignal) => Promise<PDFBookmarksSource>;
  onApply: (tree: PDFBookmarkDraft[], signal: AbortSignal, onCommit: () => void) => Promise<void>;
  onClose: () => void;
}
