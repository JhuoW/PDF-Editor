import { create } from 'zustand';
import type { ImageEditOperation, TextEditOperation } from '../editing/types';
import { useDocumentStore } from './documentStore';

/** A pointer gesture is previewed before becoming one undoable content edit. */
export interface ObjectTransformDraft {
  pageNumber: number;
  textEdit?: TextEditOperation;
  imageEdit?: ImageEditOperation;
}

export const useObjectTransformStore = create<{
  draft: ObjectTransformDraft | null;
  setDraft: (draft: ObjectTransformDraft | null) => void;
}>(set => ({ draft: null, setDraft: draft => set({ draft }) }));

// Pointer capture may end after an open/close request. A temporary rectangle
// belongs to that document only and is never included in recovery snapshots.
useDocumentStore.subscribe((next, previous) => {
  if (next.isLoading || next.document !== previous.document || next.documentVersion !== previous.documentVersion
    || next.loadRequestId !== previous.loadRequestId) useObjectTransformStore.getState().setDraft(null);
});
