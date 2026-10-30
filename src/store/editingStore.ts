/**
 * Zustand store for PDF content editing (text, images, redaction)
 */

import { create } from 'zustand';
import { useHistoryStore } from './historyStore';
import type {
  EditingMode,
  TextBlock,
  PDFImage,
  RedactionArea,
  TextEditOperation,
  TextLayoutOptions,
  ImageEditOperation,
} from '../editing/types';

interface EditingStore {
  // State
  mode: EditingMode;
  textBlocks: Map<number, TextBlock[]>;
  images: Map<number, PDFImage[]>;
  redactions: RedactionArea[];
  selectedBlockId: string | null;
  selectedImageId: string | null;
  selectedRedactionId: string | null;
  textEdits: TextEditOperation[];
  imageEdits: ImageEditOperation[];
  isDirty: boolean;

  // Actions
  setMode: (mode: EditingMode) => void;
  setTextBlocks: (pageNumber: number, blocks: TextBlock[]) => void;
  setImages: (pageNumber: number, images: PDFImage[]) => void;
  selectBlock: (blockId: string | null) => void;
  selectImage: (imageId: string | null) => void;
  selectRedaction: (redactionId: string | null) => void;

  // Text editing
  updateBlockText: (blockId: string, newText: string, groupKey?: string, layout?: TextLayoutOptions) => void;
  updateBlockLayout: (edit: TextEditOperation) => void;
  getBlock: (blockId: string) => TextBlock | null;

  // Image editing
  addImageEdit: (edit: ImageEditOperation) => void;
  resetImageEdits: (imageId: string) => void;

  // Redaction
  addRedaction: (redaction: Omit<RedactionArea, 'id' | 'applied'>) => void;
  removeRedaction: (redactionId: string) => void;
  updateRedaction: (redactionId: string, updates: Partial<RedactionArea>) => void;
  getRedactionsOnPage: (pageNumber: number) => RedactionArea[];
  markRedactionApplied: (redactionId: string) => void;

  // Utility
  clearAll: () => void;
  clearPage: (pageNumber: number) => void;
  hasChanges: () => boolean;
}

function recordEditingState(state: EditingStore, actionName: string, groupKey?: string) {
  const { textBlocks, images, redactions, textEdits, imageEdits, isDirty } = state;
  useHistoryStore.getState().pushWorkspaceState({ editing: { textBlocks, images, redactions, textEdits, imageEdits, isDirty } }, actionName, groupKey);
}

export const useEditingStore = create<EditingStore>((set, get) => ({
  // Initial state
  mode: 'none',
  textBlocks: new Map(),
  images: new Map(),
  redactions: [],
  selectedBlockId: null,
  selectedImageId: null,
  selectedRedactionId: null,
  textEdits: [],
  imageEdits: [],
  isDirty: false,

  setMode: (mode) => {
    set({
      mode,
      selectedBlockId: null,
      selectedImageId: null,
      selectedRedactionId: null,
    });
  },

  setTextBlocks: (pageNumber, blocks) => {
    set((state) => {
      const newBlocks = new Map(state.textBlocks);
      newBlocks.set(pageNumber, blocks);
      return { textBlocks: newBlocks };
    });
  },

  setImages: (pageNumber, images) => {
    set((state) => {
      const newImages = new Map(state.images);
      newImages.set(pageNumber, images);
      return { images: newImages };
    });
  },

  selectBlock: (blockId) => {
    set({ selectedBlockId: blockId, selectedImageId: null, selectedRedactionId: null });
  },

  selectImage: (imageId) => {
    set({ selectedImageId: imageId, selectedBlockId: null, selectedRedactionId: null });
  },

  selectRedaction: (redactionId) => {
    set({ selectedRedactionId: redactionId, selectedBlockId: null, selectedImageId: null });
  },

  updateBlockText: (blockId, newText, groupKey, inlineLayout) => {
    const state = get(), block = state.getBlock(blockId);
    if (!block || !block.editable || (block.text === newText && (!inlineLayout || JSON.stringify(state.textEdits.find(edit => edit.blockId === blockId)?.layout) === JSON.stringify(inlineLayout)))) return;
    recordEditingState(state, 'Edit original text', groupKey);
    const existing = state.textEdits.find(edit => edit.blockId === blockId);
    const layout = inlineLayout ?? existing?.layout;
    const originalText = existing?.originalText ?? block.text;
    const textEdits = state.textEdits.filter(edit => edit.blockId !== blockId);
    if (newText !== originalText || (existing?.layout && !existing.layout.keepBaseline)) textEdits.push({ blockId, originalText, newText, timestamp: Date.now(), ...(layout ? { layout } : {}) });
    const textBlocks = new Map(state.textBlocks);
    textBlocks.set(block.pageNumber, (textBlocks.get(block.pageNumber) ?? []).map(item => item.id === blockId ? { ...item, text: newText } : item));
    set({ textBlocks, textEdits, isDirty: textEdits.length > 0 || state.imageEdits.length > 0 || state.redactions.some(area => !area.applied) });
  },

  updateBlockLayout: edit => {
    const state = get(), block = state.getBlock(edit.blockId);
    if (!block?.editable) return;
    const previous = state.textEdits.find(item => item.blockId === edit.blockId);
    const originalText = previous?.originalText ?? block.text;
    const layout = edit.layout && Object.keys(edit.layout).length ? structuredClone(edit.layout) : undefined;
    if (block.text === edit.newText && JSON.stringify(previous?.layout) === JSON.stringify(layout)) return;
    recordEditingState(state, 'Change text layout');
    const textEdits = state.textEdits.filter(item => item.blockId !== edit.blockId);
    if (edit.newText !== originalText || layout) textEdits.push({
      blockId: edit.blockId, originalText, newText: edit.newText, timestamp: Date.now(), ...(layout ? { layout } : {}),
    });
    const textBlocks = new Map(state.textBlocks);
    textBlocks.set(block.pageNumber, (textBlocks.get(block.pageNumber) ?? []).map(item => item.id === block.id ? { ...item, text: edit.newText } : item));
    set({ textBlocks, textEdits, isDirty: textEdits.length > 0 || state.imageEdits.length > 0 || state.redactions.some(area => !area.applied) });
  },

  getBlock: (blockId) => {
    const state = get();
    for (const blocks of state.textBlocks.values()) {
      const block = blocks.find((b) => b.id === blockId);
      if (block) return block;
    }
    return null;
  },

  addImageEdit: (edit) => {
    recordEditingState(get(), 'Edit original image');
    set((state) => ({
      imageEdits: [...state.imageEdits, edit],
      isDirty: true,
    }));
  },

  resetImageEdits: imageId => {
    const state = get();
    if (!state.imageEdits.some(edit => edit.imageId === imageId)) return;
    recordEditingState(state, 'Reset image edits');
    const imageEdits = state.imageEdits.filter(edit => edit.imageId !== imageId);
    set({ imageEdits, isDirty: imageEdits.length > 0 || state.textEdits.length > 0 || state.redactions.some(area => !area.applied) });
  },

  addRedaction: redaction => {
    recordEditingState(get(), 'Add removal area');
    set(state => ({ redactions: [...state.redactions, { ...redaction, id: `redact-${crypto.randomUUID()}`, applied: false }], isDirty: true }));
  },

  removeRedaction: redactionId => {
    const state = get();
    if (!state.redactions.some(area => area.id === redactionId)) return;
    recordEditingState(state, 'Delete removal area');
    const redactions = state.redactions.filter(area => area.id !== redactionId);
    set({ redactions, selectedRedactionId: state.selectedRedactionId === redactionId ? null : state.selectedRedactionId,
      isDirty: state.textEdits.length > 0 || state.imageEdits.length > 0 || redactions.some(area => !area.applied) });
  },

  updateRedaction: (redactionId, updates) => {
    const state = get(), original = state.redactions.find(area => area.id === redactionId);
    if (!original || JSON.stringify({ ...original, ...updates }) === JSON.stringify(original)) return;
    recordEditingState(state, 'Edit removal area');
    set({ redactions: state.redactions.map(area => area.id === redactionId ? { ...area, ...updates } : area), isDirty: true });
  },

  getRedactionsOnPage: (pageNumber) => {
    return get().redactions.filter((r) => r.pageNumber === pageNumber);
  },

  markRedactionApplied: (redactionId) => {
    set((state) => ({
      redactions: state.redactions.map((r) =>
        r.id === redactionId ? { ...r, applied: true } : r
      ),
    }));
  },

  clearAll: () => {
    set({
      mode: 'none',
      textBlocks: new Map(),
      images: new Map(),
      redactions: [],
      selectedBlockId: null,
      selectedImageId: null,
      selectedRedactionId: null,
      textEdits: [],
      imageEdits: [],
      isDirty: false,
    });
  },

  clearPage: (pageNumber) => {
    set((state) => {
      const newTextBlocks = new Map(state.textBlocks);
      const newImages = new Map(state.images);
      newTextBlocks.delete(pageNumber);
      newImages.delete(pageNumber);
      return {
        textBlocks: newTextBlocks,
        images: newImages,
        redactions: state.redactions.filter((r) => r.pageNumber !== pageNumber),
      };
    });
  },

  hasChanges: () => {
    const state = get();
    return state.textEdits.length > 0 || state.imageEdits.length > 0 || state.redactions.some(r => !r.applied);
  },
}));
