import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useDocumentStore } from '../../store/documentStore';
import { useFormStore } from '../../store/formStore';
import { useEditingStore } from '../../store/editingStore';
import { useObjectTransformStore } from '../../store/objectTransformStore';
import { InlineTextPreviewClient, type InlineTextPreviewResult } from '../../editing/InlineTextPreviewClient';
import type { PDFImage, TextBlock, TextEditOperation } from '../../editing/types';
import type { PreparedTextEditLayout } from '../../editing/TextEditApplier';

const EMPTY_IMAGES: PDFImage[] = [];

export function useInlineTextPreview(page: PDFPageProxy, pageNumber: number, blocks: TextBlock[], edits: TextEditOperation[], activeId: string | null, scale: number, rotation: number) {
  const [preview, setPreview] = useState<(InlineTextPreviewResult & { page: PDFPageProxy; geometry: Map<string, PreparedTextEditLayout>; signatures: Map<string, string> }) | null>(null);
  const client = useRef<InlineTextPreviewClient | null>(null), sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contexts = useRef(new Map<number, object>());
  const images = useEditingStore(state => state.images.get(pageNumber) ?? EMPTY_IMAGES);
  const allImageEdits = useEditingStore(state => state.imageEdits);
  const draft = useObjectTransformStore(state => state.draft?.pageNumber === pageNumber ? state.draft : null);
  const imageEdits = useMemo(() => {
    const ids = new Set(images.map(image => image.id));
    return allImageEdits.filter(edit => ids.has(edit.imageId));
  }, [images, allImageEdits]);
  const previewEdits = useMemo(() => {
    const pending = draft?.textEdits ?? (draft?.textEdit ? [draft.textEdit] : []);
    return pending.length ? [...edits.filter(edit => !pending.some(item => item.blockId === edit.blockId)), ...pending] : edits;
  }, [edits, draft]);
  const previewImageEdits = useMemo(() => {
    const pending = draft?.imageEdits ?? (draft?.imageEdit ? [draft.imageEdit] : []);
    return pending.length ? [...imageEdits, ...pending] : imageEdits;
  }, [imageEdits, draft]);
  const htmlForms = useFormStore(state => state.fields.some(field => field.pageNumber === pageNumber && !field.hidden && !field.readOnly
    && ['text', 'checkbox', 'radio', 'dropdown', 'listbox'].includes(field.type)));
  // In-flight frames are useful while a pointer continues moving. A mode,
  // committed edit, selection or gesture change invalidates their old context.
  const draftIds = draft ? [...(draft.textEdits ?? (draft.textEdit ? [draft.textEdit] : [])).map(edit => edit.blockId), ...(draft.imageEdits ?? (draft.imageEdit ? [draft.imageEdit] : [])).map(edit => edit.imageId)].join('|') : '';
  const context = useMemo(() => ({ page, blocks, edits, images, imageEdits, draftIds, activeId, scale, rotation, htmlForms }),
  [page, blocks, edits, images, imageEdits, draftIds, activeId, scale, rotation, htmlForms]);
  const latest = useRef({ pageNumber, blocks, edits: previewEdits, images, imageEdits: previewImageEdits, activeId, scale, rotation, htmlForms, context });
  useEffect(() => { latest.current = { pageNumber, blocks, edits: previewEdits, images, imageEdits: previewImageEdits, activeId, scale, rotation, htmlForms, context }; });
  const needed = !!activeId || previewEdits.length > 0 || previewImageEdits.length > 0;
  const requestPreview = useCallback((data?: ArrayBuffer) => {
    const worker = client.current;
    if (!worker) return;
    const current = latest.current, id = ++sequence.current;
    contexts.current.set(id, current.context);
    worker.request({ id, ...(data ? { data } : {}), pageNumber: current.pageNumber, blocks: current.blocks, edits: current.edits,
      images: current.images, imageEdits: current.imageEdits, activeId: current.activeId,
      scale: Math.min(3, current.scale * (window.devicePixelRatio || 1)), rotation: current.rotation, htmlForms: current.htmlForms });
  }, []);
  useEffect(() => {
    if (!needed) return;
    const document = useDocumentStore.getState().document;
    if (!document) return;
    let canceled = false;
    const ownedContexts = contexts.current;
    const worker = new InlineTextPreviewClient(result => {
      const resultContext = ownedContexts.get(result.id);
      for (const id of ownedContexts.keys()) if (id <= result.id) ownedContexts.delete(id);
      if (canceled || (result.id !== -1 && resultContext !== latest.current.context)) return;
      if (result.textGeometry?.length) useObjectTransformStore.getState().setTextGeometry(result.textGeometry);
      setPreview(previous => {
        const geometry = new Map(previous?.page === page ? previous.geometry : []);
        const signatures = new Map(previous?.page === page ? previous.signatures : []);
        if (result.activeId && result.prepared) {
          geometry.set(result.activeId, result.prepared);
          const edit = latest.current.edits.find(edit => edit.blockId === result.activeId);
          signatures.set(result.activeId, result.textGeometry?.find(item => item.id === result.activeId)?.signature
            ?? JSON.stringify([result.prepared.input.text, edit?.layout]));
        }
        return { ...result, page, geometry, signatures };
      });
    });
    // Read the current proxy, never another browser tab's recovery cache.
    void document.getData().then(data => {
      if (canceled) return;
      client.current = worker;
      requestPreview(new Uint8Array(data).buffer);
    }).catch(cause => { if (!canceled) setPreview({ id: -1, page, geometry: new Map(), signatures: new Map(), error: cause instanceof Error ? cause.message : 'Could not read the PDF.' }); });
    return () => { canceled = true; worker.destroy(); ownedContexts.clear(); if (client.current === worker) client.current = null; };
  }, [page, pageNumber, needed, requestPreview]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, [page, pageNumber, needed]);
  useEffect(() => {
    if (!needed || timer.current !== null) return;
    // Throttle instead of debounce: a continuous drag still gets PDF frames.
    timer.current = setTimeout(() => { timer.current = null; requestPreview(); }, 35);
  }, [pageNumber, blocks, previewEdits, images, previewImageEdits, activeId, scale, rotation, htmlForms, needed, requestPreview]);
  if (!needed || preview?.page !== page) return null;
  // Text alone is insufficient: changing font, size or bounds also invalidates
  // caret positions. Never revive geometry from an older layout.
  const geometry = new Map([...preview.geometry].filter(([id]) => {
    const edit = previewEdits.find(edit => edit.blockId === id);
    const text = edit?.newText ?? blocks.find(block => block.id === id)?.text;
    return preview.signatures.get(id) === JSON.stringify([text, edit?.layout]);
  }));
  const prepared = activeId ? geometry.get(activeId) : undefined;
  return { ...preview, geometry, activeId, prepared, availableRect: prepared?.availableRect };
}
