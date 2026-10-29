import { create } from 'zustand';
import type { Annotation } from '../annotations/types';
import { useHistoryStore } from './historyStore';
import { useAnnotationStore } from './annotationStore';

/**
 * History entry for annotation operations
 */
export interface HistoryEntry {
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
  recordUpdate: (annotation: Annotation, previousState: Annotation, groupKey?: string) => void;
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

  // Existing annotation controls report semantic operations here. All new
  // entries join the document timeline; past/future remain for legacy recovery.
  recordAdd: annotation => {
    const annotations = new Map(useAnnotationStore.getState().annotations);
    annotations.set(annotation.pageNumber, (annotations.get(annotation.pageNumber) ?? []).filter(item => item.id !== annotation.id));
    useHistoryStore.getState().pushWorkspaceState({ annotations }, 'Add annotation');
  },

  recordUpdate: (annotation, previousState, groupKey) => {
    const withoutDate = (item: Annotation) => ({ ...item, modifiedAt: undefined });
    if (JSON.stringify(withoutDate(annotation)) === JSON.stringify(withoutDate(previousState))) return;
    const annotations = new Map(useAnnotationStore.getState().annotations);
    const page = annotations.get(previousState.pageNumber) ?? [];
    annotations.set(previousState.pageNumber, page.some(item => item.id === previousState.id)
      ? page.map(item => item.id === previousState.id ? previousState : item) : [...page, previousState]);
    useHistoryStore.getState().pushWorkspaceState({ annotations }, 'Edit annotation', groupKey);
  },

  recordDelete: annotation => {
    const annotations = new Map(useAnnotationStore.getState().annotations);
    const page = annotations.get(annotation.pageNumber) ?? [];
    if (!page.some(item => item.id === annotation.id)) annotations.set(annotation.pageNumber, [...page, annotation]);
    useHistoryStore.getState().pushWorkspaceState({ annotations }, 'Delete annotation');
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
