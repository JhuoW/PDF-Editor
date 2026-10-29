import type { PDFLinkInspection, PDFLinkOperation } from '../../core/PDFLinkTypes';
export interface PDFLinksSource {
  data: ArrayBuffer;
  report?: PDFLinkInspection;
  preview: (operations: PDFLinkOperation[], signal: AbortSignal) => Promise<Uint8Array>;
}
export interface PDFLinksDialogProps {
  documentKey: unknown;
  revision: number;
  currentPage: number;
  readPDF: (signal: AbortSignal) => Promise<PDFLinksSource>;
  onApply: (operations: PDFLinkOperation[], signal: AbortSignal, onCommit: () => void) => Promise<void>;
  onClose: () => void;
}
