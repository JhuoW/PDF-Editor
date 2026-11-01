/**
 * Types for PDF content editing (text, images, redaction)
 */

// ============================================================================
// Text Editing Types
// ============================================================================

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  transform: number[];
}

export interface TextLine {
  items: TextItem[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
  /** Exact whitespace removed at an editor-authored automatic row break. */
  joinAfter?: string;
}

export interface TextRect { x: number; y: number; width: number; height: number }
export interface TextFontPreference { fontName: string; font?: import('../fonts/fontAsset').FontAsset }

/** Replacement layout in unrotated, CropBox-relative page coordinates. */
export interface TextLayoutOptions {
  /** Paragraph typing moves following text; object typing changes one row only. */
  flow?: 'paragraph' | 'object';
  targetRect?: TextRect;
  fontName?: string;
  fontSize?: number;
  fontColor?: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
  /** Direct edits keep the original baseline when growing into adjacent space. */
  keepBaseline?: boolean;
  /** Move the original baseline with the target region, retaining its row layout. */
  translate?: boolean;
  /** Direct typing can grow a moved region; dragging itself retains its size. */
  autoGrow?: boolean;
  /** Quick formatting fits the block into nearby clear space without moving its baseline. */
  fitToContent?: boolean;
  /** Physical source rows have been joined; remaining newlines are deliberate. */
  reflow?: boolean;
}

export interface TextBlock {
  id: string;
  /** Detection granularity, retained in drafts and undo snapshots. */
  kind?: 'paragraph' | 'line';
  /** Editor-authored source region and its selected full font program. */
  region?: string;
  /** A saved authored paragraph retains its logical wrap column after reopening. */
  authoredLayout?: boolean;
  /** Retain an authored multiline or explicitly sized paragraph's wrap width. */
  fixedWrap?: boolean;
  fontPreference?: TextFontPreference;
  pageNumber: number;
  lines: TextLine[];
  text: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  style: {
    fontName: string;
    fontSize: number;
    fontColor?: string;
    alignment: 'left' | 'center' | 'right' | 'justify';
    lineHeight: number;
  };
  editable: boolean;
  unsupportedReason?: string;
}

export const INVISIBLE_TEXT_EDIT_REASON = 'This page contains an invisible OCR text layer. Editing scanned text is not supported; use search or copy instead.';
export const CLIPPING_TEXT_EDIT_REASON = 'This page uses text as a clipping path. Editing this text is not supported safely; use search or copy instead.';
export const UNMAPPED_TEXT_EDIT_REASON = 'This text has no reliable character mapping in the PDF, so what it says cannot be read safely. Other text on this page can still be edited.';
export const TYPE3_TEXT_EDIT_REASON = 'This region uses a Type 3 drawing font that cannot be rewritten safely. Other text on this page can still be edited.';

export interface TextEditOperation {
  blockId: string;
  originalText: string;
  newText: string;
  timestamp: number;
  /** The original block rectangle remains the source removal area. */
  layout?: TextLayoutOptions;
  /** Retained with edits so removing a library entry cannot break a draft or undo. */
  font?: import('../fonts/fontAsset').FontAsset;
}

// ============================================================================
// Image Editing Types
// ============================================================================

export interface PDFImage {
  id: string;
  pageNumber: number;
  objectName: string;
  /** Stable across object renumbering; refers to one drawing occurrence. */
  source?: {
    occurrence: number;
    occurrenceCount: number;
    transform: [number, number, number, number, number, number];
    pixelWidth?: number;
    pixelHeight?: number;
    insideForm: boolean;
    /** Original-image crop retained by this editor's native content span. */
    cropRect?: TextRect;
    rawRect?: TextRect;
    /** Managed page marks are edited through their batch settings. */
    decorationInstance?: string;
  };
  unsupportedReason?: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  originalRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ImageEditOperation {
  type: 'replace' | 'delete' | 'resize' | 'move' | 'crop' | 'rotate' | 'flip';
  imageId: string;
  newImageData?: ArrayBuffer;
  newRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cropRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Absolute clockwise angle in the unrotated page; crop uses original-image UVs. */
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  timestamp: number;
}

// ============================================================================
// Redaction Types
// ============================================================================

export interface RedactionArea {
  id: string;
  pageNumber: number;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  overlayText?: string;
  overlayColor: string;
  applied: boolean;
}

export type EditingMode = 'none' | 'text' | 'image' | 'object' | 'redact';

export interface ContentEditingState {
  mode: EditingMode;
  textBlocks: Map<number, TextBlock[]>; // pageNumber -> blocks
  images: Map<number, PDFImage[]>; // pageNumber -> images
  redactions: RedactionArea[];
  pendingRedactions: RedactionArea[];
  selectedBlockId: string | null;
  selectedImageId: string | null;
  textEdits: TextEditOperation[];
  imageEdits: ImageEditOperation[];
}
