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
}

export interface TextRect { x: number; y: number; width: number; height: number }

/** Replacement layout in unrotated, CropBox-relative page coordinates. */
export interface TextLayoutOptions {
  targetRect?: TextRect;
  fontName?: string;
  fontSize?: number;
  fontColor?: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;
}

export interface TextBlock {
  id: string;
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

export interface TextEditOperation {
  blockId: string;
  originalText: string;
  newText: string;
  timestamp: number;
  /** The original block rectangle remains the source removal area. */
  layout?: TextLayoutOptions;
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
  type: 'replace' | 'delete' | 'resize' | 'move' | 'crop';
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

export type EditingMode = 'none' | 'text' | 'image' | 'redact';

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
