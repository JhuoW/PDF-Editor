import { useCallback, useEffect, useRef, useState } from 'react';
import { exportWorkspacePDFInWorker } from '../core/PDFExportClient';
import type { PDFExportProgress } from '../core/PDFExportTypes';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { useDocumentStore } from '../store/documentStore';

export function usePDFExportJob() {
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<PDFExportProgress | null>(null);
  const cancel = useCallback(() => { active.current?.abort(); }, []);
  useEffect(() => {
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.document !== previous.document || next.documentVersion !== previous.documentVersion || next.loadRequestId !== previous.loadRequestId) cancel();
    });
    return () => { unsubscribe(); active.current?.abort(); active.current = null; };
  }, [cancel]);
  const run = useCallback(async (data: ArrayBuffer, workspace: WorkspaceSnapshot, options: { signal?: AbortSignal; showProgress?: boolean } = {}) => {
    options.signal?.throwIfAborted();
    if (active.current) throw new Error('Wait for the current PDF export to finish.');
    const controller = new AbortController(); active.current = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const showProgress = options.showProgress !== false;
    setProgress(showProgress ? { stage: 'prepare', progress: 0 } : null);
    try {
      return await exportWorkspacePDFInWorker(data, workspace, { signal: controller.signal,
        onProgress: value => { if (showProgress && active.current === controller) setProgress(value); } });
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (active.current === controller) { active.current = null; setProgress(null); }
    }
  }, []);
  return { run, progress, cancel };
}
