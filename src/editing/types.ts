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
}

export interface TextEditOperation {
  blockId: string;
  originalText: string;
  newText: string;
  timestamp: number;
}

// ============================================================================
// Image Editing Types
// ============================================================================

export interface PDFImage {
  id: string;
  pageNumber: number;
  objectName: string;
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
  type: 'replace' | 'delete' | 'resize' | 'crop';
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
