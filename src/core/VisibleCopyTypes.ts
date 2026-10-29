export const VISIBLE_COPY_LIMITS = {
  inputBytes: 256 * 1024 * 1024,
  pagePixels: 40_000_000,
  totalPixels: 500_000_000,
  dimension: 16_384,
  encodedBytes: 120 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024,
  pages: 2_000,
};
export interface VisibleCopySettings {
  dpi: 150 | 300;
  compression: 'lossless' | 'jpeg';
  /** JPEG quality 1–100. Defaults to 90; ignored for lossless output. */
  quality?: number;
}
export const DEFAULT_VISIBLE_COPY_SETTINGS: VisibleCopySettings = { dpi: 150, compression: 'lossless', quality: 90 };
export interface VisibleCopyPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  pixels: number;
}
export interface VisibleCopyInspection {
  pageCount: number;
  pages: VisibleCopyPageInfo[];
  totalPixels: number;
  /** The new copy contains no signatures; this does not validate source signatures. */
  hasSignatures: boolean;
  warnings: VisibleCopyWarning[];
  warningsTruncated: boolean;
}
export interface VisibleCopyWarning { pageNumber: number; fontName: string; message: string }
export interface VisibleCopyProgress { phase: 'inspect' | 'render' | 'verify' | 'save'; completed: number; total: number }
export interface VisibleCopyControl {
  signal?: AbortSignal;
  onProgress?: (progress: VisibleCopyProgress) => void;
  /** Only the preview page is rendered and output. Omit for the complete copy. */
  previewPage?: number;
}
export interface VisibleCopyResult {
  data: Uint8Array;
  pageCount: number;
  sourcePageCount: number;
  pages: number[];
  dpi: 150 | 300;
  compression: 'lossless' | 'jpeg';
  /** Sum of the newly encoded page images, not an estimate of the final PDF. */
  encodedImageBytes: number;
  warnings: VisibleCopyWarning[];
  warningsTruncated: boolean;
}
