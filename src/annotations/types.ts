/**
 * Annotation types for PDF Editor
 * Based on PDF annotation standards with extensions for editing
 */

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'freetext'
  | 'ink'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'sticky-note'
  | 'stamp';

export interface BaseAnnotation {
  id: string;
  type: AnnotationType;
  pageNumber: number;
  createdAt: Date;
  modifiedAt: Date;
  author?: string;
  color: string;
  opacity: number;
}

// Text markup annotations (highlight, underline, strikeout)
export interface TextMarkupAnnotation extends BaseAnnotation {
  type: 'highlight' | 'underline' | 'strikeout';
  quadPoints: number[][]; // Array of quads, each quad is [x1,y1,x2,y2,x3,y3,x4,y4]
  selectedText?: string;
}

// Text style for freetext annotations
export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline' | 'line-through';
  textAlign: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'middle' | 'bottom';
  color: string;
  lineHeight: number;
  letterSpacing: number;
  // Legacy - kept for backward compatibility, use BoxStyle instead
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
}

// Box styling for text boxes
export interface BoxStyle {
  backgroundColor: string;
  backgroundOpacity: number;
  borderColor: string;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed' | 'dotted' | 'none';
  borderRadius: number;
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  shadow?: {
    offsetX: number;
    offsetY: number;
    blur: number;
    color: string;
  };
}

// Rich text segment for mixed formatting within one text box
export interface RichTextSegment {
  text: string;
  startIndex?: number;  // Optional - computed dynamically when needed
  endIndex?: number;    // Optional - computed dynamically when needed
  style: Partial<TextStyle>;
}

// Free text annotation (text box)
export interface FreeTextAnnotation extends BaseAnnotation {
  type: 'freetext';
  rect: [number, number, number, number]; // [x, y, width, height] in PDF coordinates
  content: string;
  style: TextStyle;
  boxStyle?: BoxStyle;
  richContent?: RichTextSegment[]; // For mixed formatting within one text box
  rotation?: number; // Rotation in degrees
  isLocked?: boolean; // Prevent editing/moving
  zIndex?: number; // For layering
  // Legacy fields for backward compatibility
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
}

// Default text style
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Helvetica',
  fontSize: 14,
  fontWeight: 'normal',
  fontStyle: 'normal',
  textDecoration: 'none',
  textAlign: 'left',
  verticalAlign: 'top',
  color: '#000000',
  lineHeight: 1.4,
  letterSpacing: 0,
  // Legacy fields
  backgroundColor: 'transparent',
  borderColor: '#0066FF',
  borderWidth: 0,
};

// Default box style
export const DEFAULT_BOX_STYLE: BoxStyle = {
  backgroundColor: 'transparent',
  backgroundOpacity: 1,
  borderColor: '#000000',
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 0,
  padding: { top: 8, right: 8, bottom: 8, left: 8 },
};

// Available fonts for text boxes
export const AVAILABLE_FONTS = [
  'Helvetica',
  'Times-Roman',
  'Courier',
  'Arial',
  'Georgia',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Impact',
  'Comic Sans MS',
] as const;

// Font size presets
export const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

// Ink annotation (freehand drawing)
export interface InkAnnotation extends BaseAnnotation {
  type: 'ink';
  paths: number[][][]; // Array of paths, each path is array of [x, y] points
  strokeWidth: number;
}

// Shape annotations
export interface RectangleAnnotation extends BaseAnnotation {
  type: 'rectangle';
  rect: [number, number, number, number]; // [x, y, width, height]
  fillColor?: string;
  strokeColor: string;
  strokeWidth: number;
  borderRadius?: number;
}

export interface EllipseAnnotation extends BaseAnnotation {
  type: 'ellipse';
  rect: [number, number, number, number]; // Bounding box [x, y, width, height]
  fillColor?: string;
  strokeColor: string;
  strokeWidth: number;
}

export interface LineAnnotation extends BaseAnnotation {
  type: 'line' | 'arrow';
  start: [number, number];
  end: [number, number];
  strokeWidth: number;
  startArrow?: boolean;
  endArrow?: boolean;
}

// Sticky note annotation
export interface StickyNoteAnnotation extends BaseAnnotation {
  type: 'sticky-note';
  position: { x: number; y: number }; // Position in PDF coordinates
  iconType: 'comment' | 'key' | 'note' | 'help' | 'newparagraph' | 'paragraph' | 'insert';
  content: string;
  isOpen: boolean;
  replies?: StickyNoteReply[];
}

export interface StickyNoteReply {
  id: string;
  author?: string;
  content: string;
  createdAt: Date;
}

// Stamp annotation
export interface StampAnnotation extends BaseAnnotation {
  type: 'stamp';
  rect: [number, number, number, number]; // [x, y, width, height]
  stampType: 'predefined' | 'custom';
  stampName: string; // For predefined: 'Approved', 'Rejected', etc. For custom: custom name
  customImageData?: string; // Base64 image data for custom stamps
}

// Union type for all annotations
export type Annotation =
  | TextMarkupAnnotation
  | FreeTextAnnotation
  | InkAnnotation
  | RectangleAnnotation
  | EllipseAnnotation
  | LineAnnotation
  | StickyNoteAnnotation
  | StampAnnotation;

// Predefined stamp types
export const PREDEFINED_STAMPS = [
  'Approved',
  'Rejected',
  'Draft',
  'Confidential',
  'Final',
  'For Review',
  'Void',
  'Completed',
] as const;

export type PredefinedStampName = typeof PREDEFINED_STAMPS[number];

// Tool modes for the annotation toolbar
export type AnnotationTool =
  | 'select'
  | 'pan'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'freetext'
  | 'ink'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'sticky-note'
  | 'stamp';

// Default colors for annotations
export const DEFAULT_COLORS = {
  highlight: '#FFFF00',
  underline: '#00FF00',
  strikeout: '#FF0000',
  ink: '#000000',
  rectangle: '#0000FF',
  ellipse: '#0000FF',
  line: '#000000',
  arrow: '#000000',
  'sticky-note': '#FFFF00',
  freetext: '#000000',
  stamp: '#FF0000',
} as const;
