import { create } from 'zustand';
import type {
  Annotation,
  AnnotationTool,
  TextMarkupAnnotation,
  InkAnnotation,
  RectangleAnnotation,
  EllipseAnnotation,
  LineAnnotation,
  StickyNoteAnnotation,
  StampAnnotation,
  FreeTextAnnotation,
  TextStyle,
} from '../annotations/types';
import { DEFAULT_COLORS, DEFAULT_TEXT_STYLE } from '../annotations/types';

interface AnnotationState {
  // All annotations indexed by page number
  annotations: Map<number, Annotation[]>;

  // Currently selected annotation
  selectedAnnotationId: string | null;

  // Current tool
  currentTool: AnnotationTool;

  // Tool settings
  toolSettings: {
    color: string;
    opacity: number;
    strokeWidth: number;
    textStyle: TextStyle;
  };

  // Custom stamps library
  customStamps: Array<{ name: string; imageData: string }>;

  // Actions
  addAnnotation: (annotation: Annotation) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  setCurrentTool: (tool: AnnotationTool) => void;
  setToolSettings: (settings: Partial<AnnotationState['toolSettings']>) => void;
  getAnnotationsForPage: (pageNumber: number) => Annotation[];
  getAllAnnotations: () => Annotation[];
  clearAnnotations: () => void;
  addCustomStamp: (name: string, imageData: string) => void;
  removeCustomStamp: (name: string) => void;
}

// Generate unique ID
function generateId(): string {
  return `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export const useAnnotationStore = create<AnnotationState>((set, get) => ({
  annotations: new Map(),
  selectedAnnotationId: null,
  currentTool: 'select',
  toolSettings: {
    color: DEFAULT_COLORS.highlight,
    opacity: 0.5,
    strokeWidth: 2,
    textStyle: { ...DEFAULT_TEXT_STYLE },
  },
  customStamps: [],

  addAnnotation: (annotation) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const pageAnnotations = newAnnotations.get(annotation.pageNumber) || [];

      // Ensure the annotation has an ID
      const annotationWithId = {
        ...annotation,
        id: annotation.id || generateId(),
        createdAt: annotation.createdAt || new Date(),
        modifiedAt: new Date(),
      };

      newAnnotations.set(annotation.pageNumber, [...pageAnnotations, annotationWithId]);
      return { annotations: newAnnotations };
    });
  },

  updateAnnotation: (id, updates) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);

      for (const [pageNumber, pageAnnotations] of newAnnotations) {
        const index = pageAnnotations.findIndex((a) => a.id === id);
        if (index !== -1) {
          const updated = {
            ...pageAnnotations[index],
            ...updates,
            modifiedAt: new Date(),
          } as Annotation;

          const newPageAnnotations = [...pageAnnotations];
          newPageAnnotations[index] = updated;
          newAnnotations.set(pageNumber, newPageAnnotations);
          break;
        }
      }

      return { annotations: newAnnotations };
    });
  },

  deleteAnnotation: (id) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);

      for (const [pageNumber, pageAnnotations] of newAnnotations) {
        const filtered = pageAnnotations.filter((a) => a.id !== id);
        if (filtered.length !== pageAnnotations.length) {
          newAnnotations.set(pageNumber, filtered);
          break;
        }
      }

      return {
        annotations: newAnnotations,
        selectedAnnotationId:
          state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
      };
    });
  },

  selectAnnotation: (id) => {
    set({ selectedAnnotationId: id });
  },

  setCurrentTool: (tool) => {
    // Update color based on tool type
    const color = DEFAULT_COLORS[tool as keyof typeof DEFAULT_COLORS] || get().toolSettings.color;
    set((state) => ({
      currentTool: tool,
      toolSettings: { ...state.toolSettings, color },
      selectedAnnotationId: tool !== 'select' ? null : state.selectedAnnotationId,
    }));
  },

  setToolSettings: (settings) => {
    set((state) => ({
      toolSettings: { ...state.toolSettings, ...settings },
    }));
  },

  getAnnotationsForPage: (pageNumber) => {
    return get().annotations.get(pageNumber) || [];
  },

  getAllAnnotations: () => {
    const all: Annotation[] = [];
    for (const pageAnnotations of get().annotations.values()) {
      all.push(...pageAnnotations);
    }
    return all;
  },

  clearAnnotations: () => {
    set({ annotations: new Map(), selectedAnnotationId: null });
  },

  addCustomStamp: (name, imageData) => {
    set((state) => ({
      customStamps: [...state.customStamps, { name, imageData }],
    }));
  },

  removeCustomStamp: (name) => {
    set((state) => ({
      customStamps: state.customStamps.filter((s) => s.name !== name),
    }));
  },
}));

// Helper functions for creating annotations
export function createHighlightAnnotation(
  pageNumber: number,
  quadPoints: number[][],
  color: string = DEFAULT_COLORS.highlight,
  opacity: number = 0.5,
  selectedText?: string
): TextMarkupAnnotation {
  return {
    id: generateId(),
    type: 'highlight',
    pageNumber,
    quadPoints,
    color,
    opacity,
    selectedText,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createUnderlineAnnotation(
  pageNumber: number,
  quadPoints: number[][],
  color: string = DEFAULT_COLORS.underline
): TextMarkupAnnotation {
  return {
    id: generateId(),
    type: 'underline',
    pageNumber,
    quadPoints,
    color,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createStrikeoutAnnotation(
  pageNumber: number,
  quadPoints: number[][],
  color: string = DEFAULT_COLORS.strikeout
): TextMarkupAnnotation {
  return {
    id: generateId(),
    type: 'strikeout',
    pageNumber,
    quadPoints,
    color,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createInkAnnotation(
  pageNumber: number,
  paths: number[][][],
  color: string = DEFAULT_COLORS.ink,
  strokeWidth: number = 2
): InkAnnotation {
  return {
    id: generateId(),
    type: 'ink',
    pageNumber,
    paths,
    color,
    opacity: 1,
    strokeWidth,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createRectangleAnnotation(
  pageNumber: number,
  rect: [number, number, number, number],
  strokeColor: string = DEFAULT_COLORS.rectangle,
  strokeWidth: number = 2,
  fillColor?: string
): RectangleAnnotation {
  return {
    id: generateId(),
    type: 'rectangle',
    pageNumber,
    rect,
    strokeColor,
    strokeWidth,
    fillColor,
    color: strokeColor,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createEllipseAnnotation(
  pageNumber: number,
  rect: [number, number, number, number],
  strokeColor: string = DEFAULT_COLORS.ellipse,
  strokeWidth: number = 2,
  fillColor?: string
): EllipseAnnotation {
  return {
    id: generateId(),
    type: 'ellipse',
    pageNumber,
    rect,
    strokeColor,
    strokeWidth,
    fillColor,
    color: strokeColor,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createLineAnnotation(
  pageNumber: number,
  start: [number, number],
  end: [number, number],
  color: string = DEFAULT_COLORS.line,
  strokeWidth: number = 2,
  isArrow: boolean = false
): LineAnnotation {
  return {
    id: generateId(),
    type: isArrow ? 'arrow' : 'line',
    pageNumber,
    start,
    end,
    color,
    opacity: 1,
    strokeWidth,
    endArrow: isArrow,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createStickyNoteAnnotation(
  pageNumber: number,
  position: { x: number; y: number },
  content: string = '',
  color: string = DEFAULT_COLORS['sticky-note']
): StickyNoteAnnotation {
  return {
    id: generateId(),
    type: 'sticky-note',
    pageNumber,
    position,
    iconType: 'comment',
    content,
    isOpen: true,
    color,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createStampAnnotation(
  pageNumber: number,
  rect: [number, number, number, number],
  stampName: string,
  stampType: 'predefined' | 'custom' = 'predefined',
  customImageData?: string
): StampAnnotation {
  return {
    id: generateId(),
    type: 'stamp',
    pageNumber,
    rect,
    stampType,
    stampName,
    customImageData,
    color: DEFAULT_COLORS.stamp,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}

export function createFreeTextAnnotation(
  pageNumber: number,
  rect: [number, number, number, number],
  content: string = '',
  styleOverrides: Partial<TextStyle> = {}
): FreeTextAnnotation {
  const style: TextStyle = {
    ...DEFAULT_TEXT_STYLE,
    ...styleOverrides,
  };
  return {
    id: generateId(),
    type: 'freetext',
    pageNumber,
    rect,
    content,
    style,
    color: style.color,
    opacity: 1,
    createdAt: new Date(),
    modifiedAt: new Date(),
  };
}
