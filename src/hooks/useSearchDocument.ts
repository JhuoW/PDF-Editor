import { useEffect, useMemo, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { useEditingStore } from '../store/editingStore';
import { useAnnotationStore } from '../store/annotationStore';
import { useFormStore } from '../store/formStore';
import { captureWorkspace } from '../store/workspaceSnapshot';
import { exportWorkspacePDFInWorker } from '../core/PDFExportClient';
import { pdfDocumentOptions, pdfjsLib } from '../utils/pdfConfig';
import type { SearchDocumentState } from '../utils/searchDocumentContext';

/** Search the same PDF bytes that Save writes, without applying or mutating live edits. */
export function useSearchDocument(document: PDFDocumentProxy | null, enabled: boolean): SearchDocumentState {
  const texts = useEditingStore(state => state.textEdits), images = useEditingStore(state => state.imageEdits);
  const annotations = useAnnotationStore(state => state.annotations), fields = useFormStore(state => state.fields);
  const formDirty = useFormStore(state => state.isDirty);
  const [retry, setRetry] = useState(0);
  const key = useMemo(() => ({ document, texts, images, annotations, fields, formDirty, enabled, retry }), [document, texts, images, annotations, fields, formDirty, enabled, retry]);
  const needsSnapshot = enabled && !!document && (!!texts.length || !!images.length || !!annotations.size || formDirty);
  const [result, setResult] = useState<{ key: object; document?: PDFDocumentProxy; error?: unknown } | null>(null);
  useEffect(() => {
    if (!document || !needsSnapshot) return;
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    const timer = setTimeout(() => { void (async () => {
      try {
        const workspace = captureWorkspace(), source = await document.getData();
        if (controller.signal.aborted) return;
        const bytes = await exportWorkspacePDFInWorker(new Uint8Array(source).buffer, workspace, { signal: controller.signal });
        if (controller.signal.aborted) return;
        task = pdfjsLib.getDocument({ ...pdfDocumentOptions, data: bytes });
        const searchable = await task.promise;
        if (!controller.signal.aborted) setResult({ key, document: searchable });
      } catch (error) { if (!controller.signal.aborted) setResult({ key, error }); }
    })(); }, 200);
    return () => { clearTimeout(timer); controller.abort(); void task?.destroy().catch(() => {}); };
  }, [document, needsSnapshot, key]);
  const current = result?.key === key ? result : null;
  return useMemo(() => ({ document: needsSnapshot ? current?.document ?? null : document,
    ready: !needsSnapshot || !!current?.document, error: needsSnapshot ? current?.error : undefined,
    retry: () => setRetry(value => value + 1) }), [current, document, needsSnapshot]);
}
