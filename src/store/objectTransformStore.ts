import { create } from 'zustand';
import type { ImageEditOperation, TextEditOperation, TextRect } from '../editing/types';
import { useDocumentStore } from './documentStore';

/** A pointer gesture is previewed before becoming one undoable content edit. */
export interface ObjectTransformDraft {
  pageNumber: number;
  textEdit?: TextEditOperation;
  imageEdit?: ImageEditOperation;
  textEdits?: TextEditOperation[];
  imageEdits?: ImageEditOperation[];
}

export const useObjectTransformStore = create<{
  draft: ObjectTransformDraft | null;
  setDraft: (draft: ObjectTransformDraft | null) => void;
  snappingEnabled: boolean;
  setSnappingEnabled: (enabled: boolean) => void;
  multiSelectEnabled: boolean;
  setMultiSelectEnabled: (enabled: boolean) => void;
  textGeometry: Map<string, { signature: string; rect: TextRect }>;
  setTextGeometry: (geometry: { id: string; signature: string; rect: TextRect }[]) => void;
}>(set => ({ draft: null, setDraft: draft => set({ draft }), snappingEnabled: true, setSnappingEnabled: snappingEnabled => set({ snappingEnabled }), multiSelectEnabled: false, setMultiSelectEnabled: multiSelectEnabled => set({ multiSelectEnabled }),
  textGeometry: new Map(), setTextGeometry: geometry => set(state => {
    const next = new Map(state.textGeometry);
    for (const entry of geometry) next.set(entry.id, { signature: entry.signature, rect: entry.rect });
    return { textGeometry: next };
  }),
}));

// Pointer capture may end after an open/close request. A temporary rectangle
// belongs to that document only and is never included in recovery snapshots.
useDocumentStore.subscribe((next, previous) => {
  if (next.isLoading || next.document !== previous.document || next.documentVersion !== previous.documentVersion
    || next.loadRequestId !== previous.loadRequestId) useObjectTransformStore.setState({ draft: null, textGeometry: new Map() });
});
