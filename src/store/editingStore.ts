/**
 * Zustand store for PDF content editing (text, images, redaction)
 */

import { create } from 'zustand';
import type {
  EditingMode,
  TextBlock,
  PDFImage,
  RedactionArea,
  TextEditOperation,
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
  updateBlockText: (blockId: string, newText: string) => void;
  getBlock: (blockId: string) => TextBlock | null;

  // Image editing
  addImageEdit: (edit: ImageEditOperation) => void;

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

let redactionIdCounter = 0;

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

  updateBlockText: (blockId, newText) => {
    set((state) => {
      let blockFound = false;
      const newTextBlocks = new Map<number, TextBlock[]>();

      state.textBlocks.forEach((blocks, pageNumber) => {
        const updatedBlocks = blocks.map((block) => {
          if (block.id === blockId) {
            blockFound = true;
            return { ...block, text: newText };
          }
          return block;
        });
        newTextBlocks.set(pageNumber, updatedBlocks);
      });

      if (blockFound) {
        // Find the original text for the edit record
        let originalText = '';
        state.textBlocks.forEach((blocks) => {
          const block = blocks.find((b) => b.id === blockId);
          if (block) originalText = block.text;
        });

        return {
          textBlocks: newTextBlocks,
          textEdits: [
            ...state.textEdits,
            { blockId, originalText, newText, timestamp: Date.now() },
          ],
          isDirty: true,
        };
      }

      return {};
    });
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
    set((state) => ({
      imageEdits: [...state.imageEdits, edit],
      isDirty: true,
    }));
  },

  addRedaction: (redaction) => {
    const id = `redact-${++redactionIdCounter}`;
    set((state) => ({
      redactions: [
        ...state.redactions,
        { ...redaction, id, applied: false },
      ],
      isDirty: true,
    }));
  },

  removeRedaction: (redactionId) => {
    set((state) => ({
      redactions: state.redactions.filter((r) => r.id !== redactionId),
      selectedRedactionId:
        state.selectedRedactionId === redactionId ? null : state.selectedRedactionId,
    }));
  },

  updateRedaction: (redactionId, updates) => {
    set((state) => ({
      redactions: state.redactions.map((r) =>
        r.id === redactionId ? { ...r, ...updates } : r
      ),
    }));
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
    redactionIdCounter = 0;
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
