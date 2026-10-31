import type { Annotation } from '../annotations/types';
import type {
  ImageEditOperation, PDFImage, RedactionArea, TextBlock, TextEditOperation, TextFontPreference,
} from '../editing/types';
import type { FormField } from '../forms/types';
import { useAnnotationStore } from './annotationStore';
import { useAnnotationHistoryStore, type HistoryEntry } from './annotationHistoryStore';
import { useEditingStore } from './editingStore';
import { useFormStore } from './formStore';
import { useTextBoxStore } from './textBoxStore';

/** Document edits only: every field supports structuredClone and IndexedDB. */
export interface WorkspaceSnapshot {
  annotations: Map<number, Annotation[]>;
  annotationHistory: {
    past: HistoryEntry[];
    future: HistoryEntry[];
  };
  form: {
    fields: FormField[];
    originalValues: Map<string, string | boolean | string[]>;
    isDirty: boolean;
  };
  editing: {
    textBlocks: Map<number, TextBlock[]>;
    textFontPreferences?: Map<string, TextFontPreference>;
    images: Map<number, PDFImage[]>;
    redactions: RedactionArea[];
    textEdits: TextEditOperation[];
    imageEdits: ImageEditOperation[];
    isDirty: boolean;
  };
}

export function createWorkspace(fields: FormField[] = []): WorkspaceSnapshot {
  return structuredClone({
    annotations: new Map<number, Annotation[]>(),
    annotationHistory: { past: [], future: [] },
    form: {
      fields,
      originalValues: new Map(fields.map(field => [field.id, field.value])),
      isDirty: false,
    },
    editing: {
      textBlocks: new Map<number, TextBlock[]>(),
      images: new Map<number, PDFImage[]>(),
      redactions: [],
      textEdits: [],
      imageEdits: [],
      isDirty: false,
    },
  });
}

/** Live references for synchronous read-only inspection; use captureWorkspace for owned snapshots. */
export function readWorkspace(): WorkspaceSnapshot {
  const { annotations } = useAnnotationStore.getState();
  const { past, future } = useAnnotationHistoryStore.getState();
  const { fields, originalValues, isDirty: formDirty } = useFormStore.getState();
  const { textBlocks, textFontPreferences, images, redactions, textEdits, imageEdits, isDirty } = useEditingStore.getState();

  return {
    annotations,
    annotationHistory: { past, future },
    form: { fields, originalValues, isDirty: formDirty },
    editing: { textBlocks, ...(textFontPreferences.size ? { textFontPreferences } : {}), images, redactions, textEdits, imageEdits, isDirty },
  };
}

export function captureWorkspace(): WorkspaceSnapshot { return structuredClone(readWorkspace()); }

export function restoreWorkspace(snapshot: WorkspaceSnapshot): void {
  // Restored stores must not retain references into an undo or persisted snapshot.
  const copy = structuredClone(snapshot);
  useAnnotationStore.setState({
    annotations: copy.annotations,
    selectedAnnotationId: null,
    cropModeAnnotationId: null,
    currentTool: 'select',
  });
  useAnnotationHistoryStore.setState(copy.annotationHistory);
  useFormStore.setState({
    ...copy.form,
    isFormPDF: copy.form.fields.length > 0,
    activeFieldId: null,
  });
  useEditingStore.setState({
    ...copy.editing,
    textFontPreferences: copy.editing.textFontPreferences ?? new Map(),
    mode: 'none',
    pendingTextEditId: null,
    selectedBlockId: null,
    selectedImageId: null,
    selectedObjectIds: [],
    selectedRedactionId: null,
  });
  // A selection or an editor instance belongs to the old mounted editing layer.
  useTextBoxStore.setState({
    editingTextBoxId: null,
    tiptapEditor: null,
    cursor: { position: 0, selectionStart: null, selectionEnd: null, isBlinking: true },
    creation: { isCreating: false, startPoint: null, currentPoint: null, pageNumber: null },
    formatPainter: { isActive: false, style: null },
    pendingFormat: null,
    segments: null,
    editBatchId: null,
    lastEditTime: 0,
  });
}

/** Map old, 1-based page numbers to new pages; omitted pages are deleted. */
export function remapWorkspacePages(
  snapshot: WorkspaceSnapshot,
  pageMap: Map<number, number>,
): WorkspaceSnapshot {
  const copy = structuredClone(snapshot);

  function remapItem<T extends { pageNumber: number }>(item: T): T | undefined {
    const pageNumber = pageMap.get(item.pageNumber);
    return pageNumber === undefined ? undefined : { ...item, pageNumber };
  }

  function remapItems<T extends { pageNumber: number }>(items: T[]): T[] {
    return items.flatMap(item => {
      const mapped = remapItem(item);
      return mapped ? [mapped] : [];
    });
  }

  function remapIndexedItems<T extends { pageNumber: number }>(pages: Map<number, T[]>): Map<number, T[]> {
    const mappedPages = new Map<number, T[]>();
    for (const [oldPage, items] of pages) {
      const pageNumber = pageMap.get(oldPage);
      if (pageNumber === undefined) continue;
      mappedPages.set(pageNumber, [
        ...(mappedPages.get(pageNumber) ?? []),
        ...remapItems(items),
      ]);
    }
    return mappedPages;
  }

  function remapHistory(entries: HistoryEntry[]): HistoryEntry[] {
    return entries.flatMap(entry => {
      const annotation = remapItem(entry.annotation);
      const previousState = entry.previousState && remapItem(entry.previousState);
      if (!annotation || (entry.previousState && !previousState)) return [];
      return [{ ...entry, annotation, ...(previousState ? { previousState } : {}) }];
    });
  }

  copy.annotations = remapIndexedItems(copy.annotations);
  copy.annotationHistory = {
    past: remapHistory(copy.annotationHistory.past),
    future: remapHistory(copy.annotationHistory.future),
  };

  copy.form.fields = remapItems(copy.form.fields);
  const fieldIds = new Set(copy.form.fields.map(field => field.id));
  copy.form.originalValues = new Map(
    [...copy.form.originalValues].filter(([id]) => fieldIds.has(id)),
  );
  copy.form.isDirty = copy.form.fields.some(field =>
    JSON.stringify(field.value) !== JSON.stringify(copy.form.originalValues.get(field.id)),
  );

  copy.editing.textBlocks = remapIndexedItems(copy.editing.textBlocks);
  copy.editing.images = remapIndexedItems(copy.editing.images);
  copy.editing.redactions = remapItems(copy.editing.redactions);
  const blockIds = new Set([...copy.editing.textBlocks.values()].flat().map(block => block.id));
  const imageIds = new Set([...copy.editing.images.values()].flat().map(image => image.id));
  copy.editing.textEdits = copy.editing.textEdits.filter(edit => blockIds.has(edit.blockId));
  copy.editing.imageEdits = copy.editing.imageEdits.filter(edit => imageIds.has(edit.imageId));
  copy.editing.isDirty = copy.editing.textEdits.length > 0 || copy.editing.imageEdits.length > 0
    || copy.editing.redactions.some(redaction => !redaction.applied);

  return copy;
}
