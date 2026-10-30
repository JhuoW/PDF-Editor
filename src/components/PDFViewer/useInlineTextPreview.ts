import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useDocumentStore } from '../../store/documentStore';
import { useFormStore } from '../../store/formStore';
import { InlineTextPreviewClient, type InlineTextPreviewResult } from '../../editing/InlineTextPreviewClient';
import type { TextBlock, TextEditOperation } from '../../editing/types';
import type { PreparedTextEditLayout } from '../../editing/TextEditApplier';

export function useInlineTextPreview(page: PDFPageProxy, pageNumber: number, blocks: TextBlock[], edits: TextEditOperation[], activeId: string | null, scale: number, rotation: number) {
  const [preview, setPreview] = useState<(InlineTextPreviewResult & { page: PDFPageProxy; geometry: Map<string, PreparedTextEditLayout> }) | null>(null);
  const client = useRef<InlineTextPreviewClient | null>(null), sequence = useRef(0);
  const htmlForms = useFormStore(state => state.fields.some(field => field.pageNumber === pageNumber && !field.hidden && !field.readOnly
    && ['text', 'checkbox', 'radio', 'dropdown', 'listbox'].includes(field.type)));
  const latest = useRef({ blocks, edits, activeId, scale, rotation, htmlForms });
  useEffect(() => { latest.current = { blocks, edits, activeId, scale, rotation, htmlForms }; });
  const needed = !!activeId || edits.length > 0;
  useEffect(() => {
    if (!needed) return;
    const document = useDocumentStore.getState().document;
    if (!document) return;
    let canceled = false;
    const worker = new InlineTextPreviewClient(result => {
      if (!canceled) setPreview(previous => {
        const geometry = new Map(previous?.page === page ? previous.geometry : []);
        if (result.activeId && result.prepared) geometry.set(result.activeId, result.prepared);
        return { ...result, page, geometry };
      });
    });
    // Read the current proxy, never another browser tab's recovery cache.
    void document.getData().then(data => {
      if (canceled) return;
      client.current = worker;
      worker.request({ id: ++sequence.current, data: new Uint8Array(data).buffer, pageNumber, ...latest.current, scale: Math.min(3, latest.current.scale * (window.devicePixelRatio || 1)) });
    }).catch(cause => { if (!canceled) setPreview({ id: -1, page, geometry: new Map(), error: cause instanceof Error ? cause.message : 'Could not read the PDF.' }); });
    return () => { canceled = true; worker.destroy(); if (client.current === worker) client.current = null; };
  }, [page, pageNumber, needed]);
  useEffect(() => {
    const timer = setTimeout(() => client.current?.request({ id: ++sequence.current, pageNumber, blocks, edits, activeId, scale: Math.min(3, scale * (window.devicePixelRatio || 1)), rotation, htmlForms }), 35);
    return () => clearTimeout(timer);
  }, [pageNumber, blocks, edits, activeId, scale, rotation, htmlForms]);
  if (!needed || preview?.page !== page) return null;
  const cached = activeId ? preview.geometry.get(activeId) : undefined;
  return cached?.input.text === blocks.find(block => block.id === activeId)?.text
    ? { ...preview, activeId, prepared: cached, availableRect: cached?.availableRect }
    : preview;
}
