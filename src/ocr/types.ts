export type OCRLanguage = 'eng' | 'chi_sim+eng';

export interface OCRProgress {
  phase: 'initializing' | 'rendering' | 'recognizing' | 'writing';
  pageNumber: number | null;
  completedPages: number;
  totalPages: number;
  progress: number;
  status: string;
}

export interface OCRPageResult {
  pageNumber: number;
  status: 'recognized' | 'skipped-existing-text' | 'no-text';
  wordCount: number;
  text: string;
  confidence: number | null;
}

export interface OCROptions {
  pages?: number[];
  language?: OCRLanguage;
  skipExistingText?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: OCRProgress) => void;
}

export interface OCRWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export function abortError() { return new DOMException('OCR was cancelled.', 'AbortError'); }
export function checkAborted(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
