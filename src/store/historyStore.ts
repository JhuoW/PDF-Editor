import { create } from 'zustand';
import type { WorkspaceSnapshot } from './workspaceSnapshot';

/**
 * Document snapshot for undo/redo
 * Stores the complete PDF state at a point in time
 */
export interface DocumentSnapshot {
  data: ArrayBuffer;
  fileName: string;
  timestamp: number;
  actionName: string;
  workspace?: WorkspaceSnapshot;
  workspaceOnly?: boolean;
}

export type WorkspacePatch = Partial<Pick<WorkspaceSnapshot, 'annotations' | 'form' | 'editing'>>;
export interface WorkspaceHistoryEntry {
  kind: 'workspace';
  actionName: string;
  timestamp: number;
  patch: WorkspacePatch;
}
export type HistorySnapshot = DocumentSnapshot | WorkspaceHistoryEntry;
export interface HistoryTimeline { undoStack: HistorySnapshot[]; redoStack: HistorySnapshot[] }
export const isWorkspaceEntry = (entry: HistorySnapshot): entry is WorkspaceHistoryEntry => 'kind' in entry && entry.kind === 'workspace';

export function appendDocumentCheckpoint(timeline: HistoryTimeline, snapshot: DocumentSnapshot, maxHistory: number): HistoryTimeline {
  return { undoStack: [...timeline.undoStack, snapshot].slice(-maxHistory), redoStack: [] };
}

function inversePatch(current: WorkspacePatch, target: WorkspacePatch): WorkspacePatch {
  return structuredClone(Object.fromEntries(Object.keys(target).map(key => [key, current[key as keyof WorkspacePatch]])));
}

interface HistoryState {
  // The original PDF as loaded (for "Reset to Original" feature)
  originalDocument: DocumentSnapshot | null;

  // Undo stack - past states that can be undone to
  undoStack: HistorySnapshot[];

  // Redo stack - states that were undone and can be redone
  redoStack: HistorySnapshot[];

  // Maximum number of states to keep in history
  maxHistory: number;

  // Flag to prevent re-entry during undo/redo operations
  isUndoRedoInProgress: boolean;
  coalescingKey: string | null;
  groupRedo: HistorySnapshot[] | null;
  groupUndo: HistorySnapshot[] | null;

  // Actions
  setOriginalDocument: (data: ArrayBuffer, fileName: string) => void;
  getOriginalDocument: () => DocumentSnapshot | null;
  pushState: (data: ArrayBuffer, fileName: string, actionName: string, workspace?: WorkspaceSnapshot) => void;
  pushWorkspaceState: (patch: WorkspacePatch, actionName: string, groupKey?: string) => void;
  restoreWorkspaceStep: (direction: 'undo' | 'redo', current: WorkspacePatch) => WorkspacePatch | null;
  cancelWorkspaceGroup: (key: string) => WorkspacePatch | null;
  endGroup: () => void;
  undo: (currentData: ArrayBuffer, currentFileName: string, currentWorkspace?: WorkspaceSnapshot) => DocumentSnapshot | null;
  redo: (currentData: ArrayBuffer, currentFileName: string, currentWorkspace?: WorkspaceSnapshot) => DocumentSnapshot | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clearHistory: () => void;
  discardRedo: () => void;
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
  coalescingKey: null,
  groupRedo: null, groupUndo: null,

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

  pushState: (data: ArrayBuffer, fileName: string, actionName: string, workspace?: WorkspaceSnapshot) => {
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
      ...(workspace ? { workspace: structuredClone(workspace) } : {}),
    };

    // Trim undo stack if it exceeds max
    const newUndoStack = [...undoStack, newSnapshot].slice(-maxHistory);

    set({
      undoStack: newUndoStack,
      redoStack: [], // Clear redo stack when new action is performed
      coalescingKey: null,
      groupRedo: null, groupUndo: null,
    });
  },

  pushWorkspaceState: (patch, actionName, groupKey) => {
    const state = get();
    if (state.isUndoRedoInProgress) return;
    // The first state of one focus/drag session is the undo target. Subsequent
    // keystrokes need no additional clone and retain that original target.
    if (groupKey && state.coalescingKey === groupKey && state.undoStack.at(-1) && isWorkspaceEntry(state.undoStack.at(-1)!)) return;
    const entry: WorkspaceHistoryEntry = { kind: 'workspace', actionName, timestamp: Date.now(), patch: structuredClone(patch) };
    set({ undoStack: [...state.undoStack, entry].slice(-state.maxHistory), redoStack: [], coalescingKey: groupKey ?? null,
      groupRedo: groupKey ? state.redoStack : null, groupUndo: groupKey ? state.undoStack : null });
  },

  restoreWorkspaceStep: (direction, current) => {
    const state = get();
    if (state.isUndoRedoInProgress) return null;
    const source = direction === 'undo' ? state.undoStack : state.redoStack;
    const target = source.at(-1);
    if (!target || !isWorkspaceEntry(target)) return null;
    const inverse = { ...target, patch: inversePatch(current, target.patch), timestamp: Date.now() };
    set(direction === 'undo'
      ? { undoStack: source.slice(0, -1), redoStack: [...state.redoStack, inverse].slice(-state.maxHistory), coalescingKey: null, groupRedo: null, groupUndo: null }
      : { undoStack: [...state.undoStack, inverse].slice(-state.maxHistory), redoStack: source.slice(0, -1), coalescingKey: null, groupRedo: null, groupUndo: null });
    return structuredClone(target.patch);
  },

  cancelWorkspaceGroup: key => {
    const state = get(), target = state.undoStack.at(-1);
    if (state.coalescingKey !== key || !target || !isWorkspaceEntry(target)) return null;
    set({ undoStack: state.groupUndo ?? state.undoStack.slice(0, -1), redoStack: state.groupRedo ?? [], coalescingKey: null, groupRedo: null, groupUndo: null });
    return structuredClone(target.patch);
  },
  endGroup: () => { if (get().coalescingKey !== null) set({ coalescingKey: null, groupRedo: null, groupUndo: null }); },

  undo: (currentData, currentFileName, currentWorkspace) => {
    const { undoStack, redoStack, maxHistory, isUndoRedoInProgress } = get();

    if (undoStack.length === 0 || isUndoRedoInProgress) {
      return null;
    }

    // Entries contain the state BEFORE an action. Preserve the current state
    // for redo, then restore the popped entry itself.
    const stateToRestore = undoStack[undoStack.length - 1];
    if (isWorkspaceEntry(stateToRestore)) {
      if (!currentWorkspace) throw new Error('A workspace is required to undo this edit');
      const patch = get().restoreWorkspaceStep('undo', currentWorkspace)!;
      return { data: currentData, fileName: currentFileName, timestamp: stateToRestore.timestamp,
        actionName: stateToRestore.actionName, workspace: { ...structuredClone(currentWorkspace), ...patch }, workspaceOnly: true };
    }
    const currentSnapshot: DocumentSnapshot = {
      data: currentData.slice(0),
      fileName: currentFileName,
      timestamp: Date.now(),
      actionName: stateToRestore.actionName,
      ...(currentWorkspace ? { workspace: structuredClone(currentWorkspace) } : {}),
    };

    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, currentSnapshot].slice(-maxHistory),
      coalescingKey: null,
    });

    return structuredClone(stateToRestore);
  },

  redo: (currentData, currentFileName, currentWorkspace) => {
    const { undoStack, redoStack, maxHistory, isUndoRedoInProgress } = get();

    if (redoStack.length === 0 || isUndoRedoInProgress) {
      return null;
    }

    const stateToRestore = redoStack[redoStack.length - 1];
    if (isWorkspaceEntry(stateToRestore)) {
      if (!currentWorkspace) throw new Error('A workspace is required to redo this edit');
      const patch = get().restoreWorkspaceStep('redo', currentWorkspace)!;
      return { data: currentData, fileName: currentFileName, timestamp: stateToRestore.timestamp,
        actionName: stateToRestore.actionName, workspace: { ...structuredClone(currentWorkspace), ...patch }, workspaceOnly: true };
    }
    const currentSnapshot: DocumentSnapshot = {
      data: currentData.slice(0),
      fileName: currentFileName,
      timestamp: Date.now(),
      actionName: stateToRestore.actionName,
      ...(currentWorkspace ? { workspace: structuredClone(currentWorkspace) } : {}),
    };

    set({
      undoStack: [...undoStack, currentSnapshot].slice(-maxHistory),
      redoStack: redoStack.slice(0, -1),
      coalescingKey: null,
    });

    return structuredClone(stateToRestore);
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
      coalescingKey: null,
      groupRedo: null, groupUndo: null,
    });
  },

  discardRedo: () => {
    if (get().redoStack.length) set({ redoStack: [] });
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
