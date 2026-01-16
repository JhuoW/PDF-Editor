import { create } from 'zustand';
import type { TextStyle, BoxStyle, RichTextSegment } from '../annotations/types';
import { DEFAULT_TEXT_STYLE, DEFAULT_BOX_STYLE } from '../annotations/types';

// Cursor state for text editing
export interface CursorState {
  position: number; // Character index in content
  selectionStart: number | null;
  selectionEnd: number | null;
  isBlinking: boolean;
}

// Creation state for click/drag to create
export interface TextBoxCreationState {
  isCreating: boolean;
  startPoint: { x: number; y: number } | null;
  currentPoint: { x: number; y: number } | null;
  pageNumber: number | null;
}

// Clipboard for text box operations
export interface TextBoxClipboard {
  text: string;
  style?: Partial<TextStyle>;
  richContent?: RichTextSegment[];
}

// Format painter state
export interface FormatPainterState {
  isActive: boolean;
  style: Partial<TextStyle> | null;
}

interface TextBoxState {
  // Currently editing text box
  editingTextBoxId: string | null;

  // Cursor state
  cursor: CursorState;

  // Creation state
  creation: TextBoxCreationState;

  // Internal clipboard for text
  clipboard: TextBoxClipboard | null;

  // Format painter
  formatPainter: FormatPainterState;

  // Default styles for new text boxes
  defaultTextStyle: TextStyle;
  defaultBoxStyle: BoxStyle;

  // Undo batch tracking for text edits
  editBatchId: string | null;
  lastEditTime: number;

  // Actions
  startEditing: (textBoxId: string) => void;
  stopEditing: () => void;

  setCursor: (cursor: Partial<CursorState>) => void;
  setCursorPosition: (position: number) => void;
  setSelection: (start: number | null, end: number | null) => void;
  clearSelection: () => void;

  startCreation: (pageNumber: number, startPoint: { x: number; y: number }) => void;
  updateCreation: (currentPoint: { x: number; y: number }) => void;
  finishCreation: () => { pageNumber: number; rect: [number, number, number, number] } | null;
  cancelCreation: () => void;

  setClipboard: (clipboard: TextBoxClipboard | null) => void;

  startFormatPainter: (style: Partial<TextStyle>) => void;
  applyFormatPainter: () => Partial<TextStyle> | null;
  cancelFormatPainter: () => void;

  setDefaultTextStyle: (style: Partial<TextStyle>) => void;
  setDefaultBoxStyle: (style: Partial<BoxStyle>) => void;

  // Edit batching for undo
  startEditBatch: () => string;
  shouldContinueBatch: () => boolean;
  endEditBatch: () => void;
}

// Generate unique batch ID
function generateBatchId(): string {
  return `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Minimum size for text boxes (in PDF coordinates)
const MIN_TEXT_BOX_WIDTH = 50;
const MIN_TEXT_BOX_HEIGHT = 30;
const DEFAULT_TEXT_BOX_WIDTH = 200;
const DEFAULT_TEXT_BOX_HEIGHT = 100;

export const useTextBoxStore = create<TextBoxState>((set, get) => ({
  editingTextBoxId: null,

  cursor: {
    position: 0,
    selectionStart: null,
    selectionEnd: null,
    isBlinking: true,
  },

  creation: {
    isCreating: false,
    startPoint: null,
    currentPoint: null,
    pageNumber: null,
  },

  clipboard: null,

  formatPainter: {
    isActive: false,
    style: null,
  },

  defaultTextStyle: { ...DEFAULT_TEXT_STYLE },
  defaultBoxStyle: { ...DEFAULT_BOX_STYLE },

  editBatchId: null,
  lastEditTime: 0,

  startEditing: (textBoxId) => {
    set({
      editingTextBoxId: textBoxId,
      cursor: {
        position: 0,
        selectionStart: null,
        selectionEnd: null,
        isBlinking: true,
      },
    });
  },

  stopEditing: () => {
    const state = get();
    if (state.editBatchId) {
      state.endEditBatch();
    }
    set({
      editingTextBoxId: null,
      cursor: {
        position: 0,
        selectionStart: null,
        selectionEnd: null,
        isBlinking: true,
      },
    });
  },

  setCursor: (cursor) => {
    set((state) => ({
      cursor: { ...state.cursor, ...cursor },
    }));
  },

  setCursorPosition: (position) => {
    set((state) => ({
      cursor: { ...state.cursor, position, selectionStart: null, selectionEnd: null },
    }));
  },

  setSelection: (start, end) => {
    set((state) => ({
      cursor: {
        ...state.cursor,
        selectionStart: start,
        selectionEnd: end,
        position: end ?? state.cursor.position,
      },
    }));
  },

  clearSelection: () => {
    set((state) => ({
      cursor: { ...state.cursor, selectionStart: null, selectionEnd: null },
    }));
  },

  startCreation: (pageNumber, startPoint) => {
    set({
      creation: {
        isCreating: true,
        startPoint,
        currentPoint: startPoint,
        pageNumber,
      },
    });
  },

  updateCreation: (currentPoint) => {
    set((state) => ({
      creation: { ...state.creation, currentPoint },
    }));
  },

  finishCreation: () => {
    const state = get();
    const { creation } = state;

    if (!creation.isCreating || !creation.startPoint || !creation.pageNumber) {
      return null;
    }

    const { startPoint, currentPoint, pageNumber } = creation;
    const endPoint = currentPoint || startPoint;

    // Calculate rectangle
    let x = Math.min(startPoint.x, endPoint.x);
    let y = Math.min(startPoint.y, endPoint.y);
    let width = Math.abs(endPoint.x - startPoint.x);
    let height = Math.abs(endPoint.y - startPoint.y);

    // If it was a click (not drag), use default size
    if (width < MIN_TEXT_BOX_WIDTH || height < MIN_TEXT_BOX_HEIGHT) {
      x = startPoint.x;
      y = startPoint.y - DEFAULT_TEXT_BOX_HEIGHT; // Adjust for PDF coordinate system
      width = DEFAULT_TEXT_BOX_WIDTH;
      height = DEFAULT_TEXT_BOX_HEIGHT;
    }

    // Reset creation state
    set({
      creation: {
        isCreating: false,
        startPoint: null,
        currentPoint: null,
        pageNumber: null,
      },
    });

    return {
      pageNumber,
      rect: [x, y, width, height] as [number, number, number, number],
    };
  },

  cancelCreation: () => {
    set({
      creation: {
        isCreating: false,
        startPoint: null,
        currentPoint: null,
        pageNumber: null,
      },
    });
  },

  setClipboard: (clipboard) => {
    set({ clipboard });
  },

  startFormatPainter: (style) => {
    set({
      formatPainter: {
        isActive: true,
        style,
      },
    });
  },

  applyFormatPainter: () => {
    const state = get();
    const style = state.formatPainter.style;

    // Deactivate format painter after use
    set({
      formatPainter: {
        isActive: false,
        style: null,
      },
    });

    return style;
  },

  cancelFormatPainter: () => {
    set({
      formatPainter: {
        isActive: false,
        style: null,
      },
    });
  },

  setDefaultTextStyle: (style) => {
    set((state) => ({
      defaultTextStyle: { ...state.defaultTextStyle, ...style },
    }));
  },

  setDefaultBoxStyle: (style) => {
    set((state) => ({
      defaultBoxStyle: { ...state.defaultBoxStyle, ...style },
    }));
  },

  startEditBatch: () => {
    const batchId = generateBatchId();
    set({ editBatchId: batchId, lastEditTime: Date.now() });
    return batchId;
  },

  shouldContinueBatch: () => {
    const state = get();
    if (!state.editBatchId) return false;

    // Continue batch if less than 3 seconds since last edit
    const timeSinceLastEdit = Date.now() - state.lastEditTime;
    return timeSinceLastEdit < 3000;
  },

  endEditBatch: () => {
    set({ editBatchId: null, lastEditTime: 0 });
  },
}));

// Selector hooks for common patterns
export const useIsEditingTextBox = () => useTextBoxStore((state) => state.editingTextBoxId !== null);
export const useEditingTextBoxId = () => useTextBoxStore((state) => state.editingTextBoxId);
export const useCursor = () => useTextBoxStore((state) => state.cursor);
export const useCreation = () => useTextBoxStore((state) => state.creation);
export const useFormatPainter = () => useTextBoxStore((state) => state.formatPainter);
