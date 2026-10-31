import { useAnnotationStore } from './annotationStore';
import { useAnnotationHistoryStore } from './annotationHistoryStore';
import { useEditingStore } from './editingStore';
import { useFormStore } from './formStore';
import { useHistoryStore } from './historyStore';
import { useSearchStore } from './searchStore';
import { useTextBoxStore } from './textBoxStore';
import { captureWorkspace, restoreWorkspace } from './workspaceSnapshot';
import { useDocumentStore } from './documentStore';
import type { StoredSessionState } from '../utils/pdfStorage';
import { captureDocumentFileSaveState, clearDocumentSaveState } from './documentSaveStore';

interface ActiveDocumentSession {
  sessionId: string;
  fileName: string;
}

export const useDocumentSessionStore = create<{ active: ActiveDocumentSession | null }>(() => ({ active: null }));

export function captureSessionState(): StoredSessionState {
  const { originalDocument, undoStack, redoStack } = useHistoryStore.getState();
  return {
    workspace: captureWorkspace(),
    // These buffers are immutable snapshots; IndexedDB clones them on write.
    originalDocument,
    history: { undoStack, redoStack },
    navigation: { ...useDocumentStore.getState().navigation },
    fileSaveState: captureDocumentFileSaveState(),
  };
}

export function clearDocumentSession() {
  clearDocumentSaveState();
  useDocumentSessionStore.setState({ active: null });
  useAnnotationStore.getState().clearAnnotations();
  useAnnotationStore.getState().exitCropMode();
  useAnnotationStore.getState().setCurrentTool('select');
  useAnnotationHistoryStore.getState().clear();
  useEditingStore.getState().clearAll();
  useFormStore.getState().clearForm();
  useSearchStore.getState().clearSearch();
  useTextBoxStore.setState(useTextBoxStore.getInitialState());
  useHistoryStore.getState().clearHistory();
}
import { create } from 'zustand';

/** Start a new file only after it has been parsed and stored successfully. */
export function startDocumentSession(data: ArrayBuffer, fileName: string, restored?: StoredSessionState) {
  clearDocumentSession();
  if (restored?.originalDocument) {
    useHistoryStore.setState({ originalDocument: structuredClone(restored.originalDocument) });
  } else {
    useHistoryStore.getState().setOriginalDocument(data, fileName);
  }
  if (restored?.history) {
    useHistoryStore.getState().restoreTimeline(structuredClone(restored.history));
  }
  if (restored?.workspace) restoreWorkspace(restored.workspace);
}
