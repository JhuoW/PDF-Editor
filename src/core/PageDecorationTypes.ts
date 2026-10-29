export type DecorationFontFamily = 'Helvetica' | 'Times' | 'Courier';
export type DecorationAnchor = 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type DecorationLayer = 'foreground' | 'background';
export type HeaderFooterSlot = 'headerLeft' | 'headerCenter' | 'headerRight' | 'footerLeft' | 'footerCenter' | 'footerRight';
export interface DecorationPosition { anchor: DecorationAnchor; offsetX: number; offsetY: number }
export interface BatesSettings { start: number; digits: number; prefix: string; suffix: string }
interface DecorationBase {
  name: string;
  /** Unique 1-based pages, in Bates numbering order; UI resolves ranges/parity. */
  pages: number[];
  opacity: number;
}
export interface TextWatermarkContent {
  type: 'text'; text: string; fontFamily: DecorationFontFamily; fontSize: number; color: string;
}
export interface ImageWatermarkContent {
  type: 'image'; name: string; data: Uint8Array; width: number; height: number;
}
export interface WatermarkDecoration extends DecorationBase {
  kind: 'watermark'; content: TextWatermarkContent | ImageWatermarkContent;
  /** Clockwise degrees in the displayed page, after native page rotation. */
  angle: number;
  position: DecorationPosition;
  layer: DecorationLayer;
}
export interface HeaderFooterDecoration extends DecorationBase {
  kind: 'header-footer'; slots: Partial<Record<HeaderFooterSlot, string>>;
  fontFamily: DecorationFontFamily; fontSize: number; color: string;
  marginX: number; marginTop: number; marginBottom: number;
  /** {page} = actual current page number + pageNumberStart - 1. */
  pageNumberStart: number;
  /** {bates} = prefix + padded(start + selected-page ordinal) + suffix. */
  bates: BatesSettings;
  layer: DecorationLayer;
}
export interface BackgroundDecoration extends DecorationBase {
  kind: 'background';
  fill: { type: 'color'; color: string } | { type: 'image'; name: string; data: Uint8Array; fit: 'contain' | 'cover' | 'stretch' };
}
export type PageDecorationDefinition = WatermarkDecoration | HeaderFooterDecoration | BackgroundDecoration;
export interface ManagedPageDecoration {
  id: string;
  definition: PageDecorationDefinition;
  /** Actual pages on which owned marks were found, regardless of copied indices. */
  pages: number[];
  managed: boolean;
  reason?: string;
  /** Numbering/page geometry changed since rendering; Update refreshes tokens. */
  needsRefresh: boolean;
  /** Top-left coordinates in the actually displayed, natively rotated page. */
  placements: Array<{ pageNumber: number; bounds: { x: number; y: number; width: number; height: number } }>;
}
export interface PageDecorationInspection {
  pages: Array<{ pageNumber: number; width: number; height: number }>;
  decorations: ManagedPageDecoration[];
  canEdit: boolean;
  unsupportedReason?: string;
}
export type PageDecorationOperation =
  | { type: 'create'; definition: PageDecorationDefinition }
  | { type: 'update'; id: string; definition: PageDecorationDefinition }
  | { type: 'remove'; id: string };
export interface PageDecorationControl {
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Preview only: render changed marks for one page, retaining full-document numbering. */
  previewPage?: number;
}
