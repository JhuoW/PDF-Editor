/** PDF.js scale=1, rotation=0, CropBox-relative coordinates including UserUnit. */
export interface PDFLinkRect { x: number; y: number; width: number; height: number }
export type PDFLinkView = 'XYZ' | 'Fit' | 'FitB' | 'FitH' | 'FitBH' | 'FitV' | 'FitBV' | 'FitR';
export type PDFLinkTarget = { type: 'url'; url: string } | {
  type: 'page'; pageNumber: number; view: PDFLinkView;
  /** XYZ uses x/y/zoom; null retains the viewer's current value. Zoom is a ratio. */
  x?: number | null; y?: number | null; zoom?: number | null;
  /** FitR uses the unrotated target-page rectangle. */
  rect?: PDFLinkRect;
};
export interface PDFLinkBorder { width: number; color: string; style: 'solid' | 'dashed' | 'underline' }
export interface PDFLinkDefinition {
  pageNumber: number; rect: PDFLinkRect; target: PDFLinkTarget;
  description?: string;
  /** Width 0 produces an invisible clickable region. Defaults to width 0. */
  border?: PDFLinkBorder;
}
export interface PDFLinkInfo {
  /** Scoped to the inspected PDF revision and one page/Annots occurrence. */
  id: string; pageNumber: number; rect: PDFLinkRect | null;
  definition?: PDFLinkDefinition;
  editable: boolean; removable: boolean; unsupportedReason?: string;
  namedDestination?: string; summary: string;
}
export interface PDFLinkInspection {
  revision: string;
  pages: Array<{ pageNumber: number; width: number; height: number; rotation: number }>;
  links: PDFLinkInfo[];
  canEdit: boolean; unsupportedReason?: string;
}
export type PDFLinksInspection = PDFLinkInspection;
export type PDFLinkOperation = { type: 'create'; definition: PDFLinkDefinition }
  | { type: 'update'; id: string; definition: PDFLinkDefinition }
  | { type: 'remove'; id: string };
export interface PDFLinkControl {
  signal?: AbortSignal;
  expectedRevision?: string;
  onProgress?: (progress: { completed: number; total: number }) => void;
}
export const PDF_LINK_LIMITS = { inputBytes: 200 * 1024 * 1024, pages: 2000, links: 20_000, operations: 20_000, urlCharacters: 4096, descriptionCharacters: 4096, borderWidth: 100 };
