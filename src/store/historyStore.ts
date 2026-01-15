import { create } from 'zustand';

/**
 * Document snapshot for undo/redo
 * Stores the complete PDF state at a point in time
 */
interface DocumentSnapshot {
  data: ArrayBuffer;
  fileName: string;
  timestamp: number;
  actionName: string;
}

interface HistoryState {
  // The original PDF as loaded (for "Reset to Original" feature)
  originalDocument: DocumentSnapshot | null;

  // Undo stack - past states that can be undone to
  undoStack: DocumentSnapshot[];

  // Redo stack - states that were undone and can be redone
  redoStack: DocumentSnapshot[];

  // Maximum number of states to keep in history
  maxHistory: number;

  // Flag to prevent re-entry during undo/redo operations
  isUndoRedoInProgress: boolean;

  // Actions
  setOriginalDocument: (data: ArrayBuffer, fileName: string) => void;
  getOriginalDocument: () => DocumentSnapshot | null;
  pushState: (data: ArrayBuffer, fileName: string, actionName: string) => void;
  undo: () => DocumentSnapshot | null;
  redo: () => DocumentSnapshot | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clearHistory: () => void;
  getUndoActionName: () => string | null;
  getRedoActionName: () => string | null;
  setUndoRedoInProgress: (inProgress: boolean) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  originalDocument: null,
  undoStack: [],
  redoStack: [],
  maxHistory: 20,
  isUndoRedoInProgress: false,

  setOriginalDocument: (data: ArrayBuffer, fileName: string) => {
    set({
      originalDocument: {
        data: data.slice(0), // Clone to prevent detachment issues
        fileName,
        timestamp: Date.now(),
        actionName: 'Original',
      },
    });
  },

  getOriginalDocument: () => {
    return get().originalDocument;
  },

  pushState: (data: ArrayBuffer, fileName: string, actionName: string) => {
    const { undoStack, maxHistory, isUndoRedoInProgress } = get();

    // Don't record history during undo/redo operations
    if (isUndoRedoInProgress) {
      return;
    }

    const newSnapshot: DocumentSnapshot = {
      data: data.slice(0), // Clone the ArrayBuffer
      fileName,
      timestamp: Date.now(),
      actionName,
    };

    // Trim undo stack if it exceeds max
    const newUndoStack = [...undoStack, newSnapshot].slice(-maxHistory);

    set({
      undoStack: newUndoStack,
      redoStack: [], // Clear redo stack when new action is performed
    });
  },

  undo: () => {
    const { undoStack, redoStack } = get();

    if (undoStack.length === 0) {
      return null;
    }

    // Pop the last state from undo stack
    const stateToRestore = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);

    set({
      undoStack: newUndoStack,
      redoStack: [...redoStack, stateToRestore],
    });

    // Return the state BEFORE the undone action (or original if at beginning)
    if (newUndoStack.length > 0) {
      return newUndoStack[newUndoStack.length - 1];
    }

    // If undo stack is now empty, return the original document
    const { originalDocument } = get();
    return originalDocument;
  },

  redo: () => {
    const { undoStack, redoStack } = get();

    if (redoStack.length === 0) {
      return null;
    }

    // Pop the last state from redo stack (most recently undone)
    const stateToRestore = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);

    set({
      undoStack: [...undoStack, stateToRestore],
      redoStack: newRedoStack,
    });

    return stateToRestore;
  },

  canUndo: () => {
    return get().undoStack.length > 0;
  },

  canRedo: () => {
    return get().redoStack.length > 0;
  },

  clearHistory: () => {
    set({
      originalDocument: null,
      undoStack: [],
      redoStack: [],
      isUndoRedoInProgress: false,
    });
  },

  getUndoActionName: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return null;
    return undoStack[undoStack.length - 1].actionName;
  },

  getRedoActionName: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return null;
    return redoStack[redoStack.length - 1].actionName;
  },

  setUndoRedoInProgress: (inProgress: boolean) => {
    set({ isUndoRedoInProgress: inProgress });
  },
}));
