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
  TextFontPreference,
  ImageEditOperation,
} from '../editing/types';

let prepareTextMode: (() => Promise<void>) | undefined;
let modeRequest = 0;
/** Bake drafts into the working PDF before changing text detection granularity.
 * The document operation owns error reporting and retains an undo checkpoint. */
export function registerTextModePreparation(prepare: () => Promise<void>) {
  prepareTextMode = prepare;
  return () => { if (prepareTextMode === prepare) { prepareTextMode = undefined; modeRequest++; } };
}

interface EditingStore {
  // State
  mode: EditingMode;
  textBlocks: Map<number, TextBlock[]>;
  textFontPreferences: Map<string, TextFontPreference>;
  images: Map<number, PDFImage[]>;
  redactions: RedactionArea[];
  selectedBlockId: string | null;
  pendingTextEditId: string | null;
  selectedImageId: string | null;
  selectedObjectIds: string[];
  selectedRedactionId: string | null;
  textEdits: TextEditOperation[];
  imageEdits: ImageEditOperation[];
  isDirty: boolean;

  // Actions
  setMode: (mode: EditingMode) => void;
  requestTextEdit: (blockId: string) => void;
  clearTextEditRequest: () => void;
  setTextBlocks: (pageNumber: number, blocks: TextBlock[]) => void;
  setImages: (pageNumber: number, images: PDFImage[]) => void;
  selectBlock: (blockId: string | null) => void;
  selectImage: (imageId: string | null) => void;
  selectRedaction: (redactionId: string | null) => void;
  selectObjects: (ids: string[], primaryId?: string) => void;
  applyObjectEdits: (edits: { textEdits?: TextEditOperation[]; imageEdits?: ImageEditOperation[] }, actionName: string) => void;

  // Text editing
  updateBlockText: (blockId: string, newText: string, groupKey?: string, layout?: TextLayoutOptions) => void;
  updateBlockLayout: (edit: TextEditOperation, groupKey?: string) => void;
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
  const { textBlocks, textFontPreferences, images, redactions, textEdits, imageEdits, isDirty } = state;
  useHistoryStore.getState().pushWorkspaceState({ editing: { textBlocks, ...(textFontPreferences.size ? { textFontPreferences } : {}), images, redactions, textEdits, imageEdits, isDirty } }, actionName, groupKey);
}

export const useEditingStore = create<EditingStore>((set, get) => ({
  // Initial state
  mode: 'none',
  textBlocks: new Map(),
  textFontPreferences: new Map(),
  images: new Map(),
  redactions: [],
  selectedBlockId: null,
  pendingTextEditId: null,
  selectedImageId: null,
  selectedObjectIds: [],
  selectedRedactionId: null,
  textEdits: [],
  imageEdits: [],
  isDirty: false,

  setMode: (mode) => {
    const request = ++modeRequest, state = get();
    let textBlocks = state.textBlocks;
    if (mode === 'text' || mode === 'object') {
      const kind = mode === 'text' ? 'paragraph' : 'line';
      const incompatible = [...textBlocks].filter(([, blocks]) => blocks.some(block => (block.kind ?? 'paragraph') !== kind));
      const ids = new Set(incompatible.flatMap(([, blocks]) => blocks.map(block => block.id)));
      if (state.textEdits.some(edit => ids.has(edit.blockId)) && prepareTextMode) {
        const prepare = prepareTextMode, session = useHistoryStore.getState().originalDocument;
        void prepare().then(() => {
          if (request === modeRequest && prepareTextMode === prepare && useHistoryStore.getState().originalDocument === session) get().setMode(mode);
        }).catch(() => { /* The document operation reports the error; drafts remain intact. */ });
        return;
      }
      if (!state.textEdits.some(edit => ids.has(edit.blockId)) && incompatible.length) {
        textBlocks = new Map(textBlocks);
        for (const [page] of incompatible) textBlocks.delete(page);
      }
    }
    set({
      mode,
      textBlocks,
      selectedBlockId: null,
      pendingTextEditId: null,
      selectedImageId: null,
      selectedObjectIds: [],
      selectedRedactionId: null,
    });
  },

  requestTextEdit: blockId => {
    const block = get().getBlock(blockId);
    if (!block?.editable) return;
    modeRequest++;
    set({ mode: block.kind === 'line' ? 'object' : 'text', selectedBlockId: blockId, pendingTextEditId: blockId, selectedImageId: null, selectedRedactionId: null, selectedObjectIds: [blockId] });
  },
  clearTextEditRequest: () => set({ pendingTextEditId: null }),

  setTextBlocks: (pageNumber, blocks) => {
    set((state) => {
      const newBlocks = new Map(state.textBlocks);
      newBlocks.set(pageNumber, blocks.map(block => {
        const fontPreference = block.region ? state.textFontPreferences.get(block.region) : undefined;
        return fontPreference ? { ...block, fontPreference } : block;
      }));
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
    set({ selectedBlockId: blockId, selectedImageId: null, selectedRedactionId: null, selectedObjectIds: blockId ? [blockId] : [] });
  },

  selectImage: (imageId) => {
    set({ selectedImageId: imageId, selectedBlockId: null, selectedRedactionId: null, selectedObjectIds: imageId ? [imageId] : [] });
  },

  selectRedaction: (redactionId) => {
    set({ selectedRedactionId: redactionId, selectedBlockId: null, selectedImageId: null, selectedObjectIds: [] });
  },

  selectObjects: (ids, primaryId) => {
    const state = get(), objects = [...state.textBlocks.values(), ...state.images.values()].flat();
    const page = objects.find(object => object.id === (primaryId ?? ids.at(-1)))?.pageNumber;
    const selected = [...new Set(ids)].filter(id => objects.some(object => object.id === id && object.pageNumber === page));
    const primary = selected.includes(primaryId ?? '') ? primaryId! : selected.at(-1);
    set({ selectedObjectIds: selected, selectedBlockId: primary && state.getBlock(primary) ? primary : null,
      selectedImageId: primary && !state.getBlock(primary) ? primary : null, selectedRedactionId: null });
  },

  applyObjectEdits: (edits, actionName) => {
    const state = get();
    const texts = (edits.textEdits ?? []).filter(edit => state.getBlock(edit.blockId)?.editable);
    const images = (edits.imageEdits ?? []).filter(edit => [...state.images.values()].some(items => items.some(image => image.id === edit.imageId && image.source && !image.unsupportedReason)));
    if (!texts.length && !images.length) return;
    recordEditingState(state, actionName);
    let textEdits = [...state.textEdits];
    const textBlocks = new Map(state.textBlocks);
    for (const edit of texts) {
      const block = state.getBlock(edit.blockId)!, previous = state.textEdits.find(item => item.blockId === edit.blockId);
      const originalText = previous?.originalText ?? block.text;
      textEdits = textEdits.filter(item => item.blockId !== edit.blockId);
      if (edit.newText !== originalText || edit.layout) textEdits.push({ ...structuredClone(edit), originalText });
      textBlocks.set(block.pageNumber, (textBlocks.get(block.pageNumber) ?? []).map(item => item.id === block.id ? { ...item, text: edit.newText } : item));
    }
    const imageEdits = [...state.imageEdits, ...structuredClone(images)];
    set({ textBlocks, textEdits, imageEdits, isDirty: !!textEdits.length || !!imageEdits.length || state.redactions.some(area => !area.applied) });
  },

  updateBlockText: (blockId, newText, groupKey, inlineLayout) => {
    const state = get(), block = state.getBlock(blockId);
    if (!block || !block.editable || (block.text === newText && (!inlineLayout || JSON.stringify(state.textEdits.find(edit => edit.blockId === blockId)?.layout) === JSON.stringify(inlineLayout)))) return;
    recordEditingState(state, 'Edit original text', groupKey);
    const existing = state.textEdits.find(edit => edit.blockId === blockId);
    const layout = inlineLayout ?? existing?.layout;
    const originalText = existing?.originalText ?? block.text;
    const textEdits = state.textEdits.filter(edit => edit.blockId !== blockId);
    const retainsFormatting = layout && (layout.fitToContent || ['fontName', 'fontSize', 'fontColor', 'alignment', 'lineHeight']
      .some(key => layout[key as keyof TextLayoutOptions] !== undefined));
    if (newText !== originalText || (layout && (layout.translate || !layout.keepBaseline || retainsFormatting))) textEdits.push({ blockId, originalText, newText, timestamp: Date.now(), ...(layout ? { layout } : {}), ...(existing?.font?.id === layout?.fontName ? { font: existing?.font } : {}) });
    const textBlocks = new Map(state.textBlocks);
    textBlocks.set(block.pageNumber, (textBlocks.get(block.pageNumber) ?? []).map(item => item.id === blockId ? { ...item, text: newText } : item));
    set({ textBlocks, textEdits, isDirty: textEdits.length > 0 || state.imageEdits.length > 0 || state.redactions.some(area => !area.applied) });
  },

  updateBlockLayout: (edit, groupKey) => {
    const state = get(), block = state.getBlock(edit.blockId);
    if (!block?.editable) return;
    const previous = state.textEdits.find(item => item.blockId === edit.blockId);
    const originalText = previous?.originalText ?? block.text;
    const layout = edit.layout && Object.keys(edit.layout).length ? structuredClone(edit.layout) : undefined;
    const font = (edit.font ?? previous?.font)?.id === layout?.fontName ? edit.font ?? previous?.font : undefined;
    if (block.text === edit.newText && JSON.stringify(previous?.layout) === JSON.stringify(layout) && previous?.font?.id === font?.id) return;
    recordEditingState(state, 'Change text layout', groupKey);
    const textEdits = state.textEdits.filter(item => item.blockId !== edit.blockId);
    if (edit.newText !== originalText || layout) textEdits.push({
      blockId: edit.blockId, originalText, newText: edit.newText, timestamp: Date.now(), ...(layout ? { layout } : {}),
      ...(font ? { font } : {}),
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
    modeRequest++;
    set({
      mode: 'none',
      pendingTextEditId: null,
      textBlocks: new Map(),
      textFontPreferences: new Map(),
      images: new Map(),
      redactions: [],
      selectedBlockId: null,
      selectedImageId: null,
      selectedObjectIds: [],
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
