import { create } from 'zustand';
import type { Annotation } from '../annotations/types';

/**
 * History entry for annotation operations
 */
interface HistoryEntry {
  type: 'add' | 'update' | 'delete';
  annotation: Annotation;
  previousState?: Annotation; // For updates, stores the previous state
}

interface AnnotationHistoryState {
  // History stack
  past: HistoryEntry[];
  future: HistoryEntry[];

  // Actions
  recordAdd: (annotation: Annotation) => void;
  recordUpdate: (annotation: Annotation, previousState: Annotation) => void;
  recordDelete: (annotation: Annotation) => void;

  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;

  canUndo: () => boolean;
  canRedo: () => boolean;

  clear: () => void;
}

export const useAnnotationHistoryStore = create<AnnotationHistoryState>((set, get) => ({
  past: [],
  future: [],

  recordAdd: (annotation) => {
    set((state) => ({
      past: [...state.past, { type: 'add', annotation }],
      future: [], // Clear redo stack on new action
    }));
  },

  recordUpdate: (annotation, previousState) => {
    set((state) => ({
      past: [...state.past, { type: 'update', annotation, previousState }],
      future: [], // Clear redo stack on new action
    }));
  },

  recordDelete: (annotation) => {
    set((state) => ({
      past: [...state.past, { type: 'delete', annotation }],
      future: [], // Clear redo stack on new action
    }));
  },

  undo: () => {
    const state = get();
    if (state.past.length === 0) return null;

    const lastEntry = state.past[state.past.length - 1];
    set({
      past: state.past.slice(0, -1),
      future: [lastEntry, ...state.future],
    });
    return lastEntry;
  },

  redo: () => {
    const state = get();
    if (state.future.length === 0) return null;

    const nextEntry = state.future[0];
    set({
      past: [...state.past, nextEntry],
      future: state.future.slice(1),
    });
    return nextEntry;
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  clear: () => set({ past: [], future: [] }),
}));
