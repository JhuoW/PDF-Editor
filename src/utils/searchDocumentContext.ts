import { createContext } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
export interface SearchDocumentState {
  document: PDFDocumentProxy | null; ready: boolean; error?: unknown; warning?: unknown; skippedPages?: number[]; retry: () => void;
}
export const SearchDocumentContext = createContext<SearchDocumentState | null>(null);
