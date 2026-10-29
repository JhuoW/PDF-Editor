export interface OptimizerSettings {
  mode: 'lossless' | 'images';
  dpi: 150 | 200 | 300;
  /** JPEG encoder quality, from 1 through 100. Used only in images mode. */
  quality: number;
}

export const DEFAULT_OPTIMIZER_SETTINGS: Readonly<OptimizerSettings> = Object.freeze({ mode: 'lossless', dpi: 150, quality: 80 });

export const PDF_OPTIMIZER_LIMITS = Object.freeze({
  inputBytes: 200 * 1024 * 1024,
  pages: 2000,
  imageDimension: 16384,
  imagePixels: 40_000_000,
  totalDecodedPixels: 80_000_000,
  objects: 200000,
  streamBytes: 32 * 1024 * 1024,
  totalStreamBytes: 128 * 1024 * 1024,
});

export interface PDFOptimizationReport {
  inputBytes: number;
  pageCount: number;
  imageCount: number;
  eligibleImageCount: number;
  canOptimize: boolean;
  unsupportedReason?: string;
  warnings: string[];
}

export interface OptimizerProgress { phase: 'inspect' | 'images' | 'save' | 'verify'; completed: number; total: number }

export interface PDFOptimizerControl {
  signal?: AbortSignal;
  onProgress?: (progress: OptimizerProgress) => void;
}

export interface PDFOptimizationResult {
  data: Uint8Array;
  inputBytes: number;
  outputBytes: number;
  pageCount: number;
  imagesOptimized: number;
  imagesSkipped: number;
  /** Exact duplicate image resources merged without changing pixels. */
  imagesDeduplicated: number;
  warnings: string[];
  /** False means the original bytes were returned because no smaller result was obtained. */
  changed: boolean;
  /** Size of the verified candidate, including when the original was smaller. */
  candidateBytes: number;
}

export type OptimizerControl = PDFOptimizerControl;
export type OptimizerInspection = PDFOptimizationReport;
export type OptimizerResult = PDFOptimizationResult;
