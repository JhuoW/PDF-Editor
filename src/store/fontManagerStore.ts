import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { FontAsset } from '../fonts/fontAsset';
/** The font dialog survives inspector collapse and responsive layout changes. */
export const useFontManagerStore = create<{ request: { document: PDFDocumentProxy | null; choose: (font: FontAsset) => void } | null }>(() => ({ request: null }));
