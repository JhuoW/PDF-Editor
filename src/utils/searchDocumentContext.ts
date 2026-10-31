import { createContext } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
export interface SearchDocumentState {
  document: PDFDocumentProxy | null; ready: boolean; error?: unknown; retry: () => void;
}
export const SearchDocumentContext = createContext<SearchDocumentState | null>(null);
