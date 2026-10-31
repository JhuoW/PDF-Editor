import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { TextCheckError, type TextCheckReport } from '../editing/TextCheckTypes';
import type { PDFExportControl, PDFExportRequest } from './PDFExportTypes';

function run<T>(data: ArrayBuffer, workspace: WorkspaceSnapshot, job: PDFExportRequest['job'], control: PDFExportControl): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('PDF operation cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./PDFExport.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true; worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', abort); worker.terminate(); return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('PDF operation cancelled', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the PDF export worker.')); };
    worker.onmessageerror = () => fail(new Error('The PDF export worker returned unreadable data.'));
    worker.onmessage = event => {
      if (settled) return;
      const packet = event.data;
      if (packet?.type === 'progress' && Number.isFinite(packet.progress?.progress) && typeof packet.progress?.stage === 'string') {
        try { control.onProgress?.(packet.progress); } catch (error) { fail(error); }
      } else if (packet?.type === 'result' && (job === 'export' ? packet.result instanceof Uint8Array : Array.isArray(packet.result?.issues) && Number.isFinite(packet.result.checked))) {
        if (finish()) resolve(packet.result);
      } else if (packet?.type === 'error') {
        fail(packet.issues?.length ? new TextCheckError(packet.issues) : new Error(packet.message || 'Could not export the PDF.'));
      } else fail(new Error('The PDF export worker returned an unexpected response.'));
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) { abort(); return; }
    try {
      // Transfer only a private source copy. Live PDF, undo and image buffers stay owned by the UI.
      const source = data.slice(0);
      worker.postMessage({ job, data: source, workspace } satisfies PDFExportRequest, [source]);
    } catch (error) { fail(error); }
  });
}
export const exportWorkspacePDFInWorker = (data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFExportControl = {}) => run<Uint8Array<ArrayBuffer>>(data, workspace, 'export', control);
export const inspectWorkspaceTextInWorker = (data: ArrayBuffer, workspace: WorkspaceSnapshot, control: PDFExportControl = {}) => run<TextCheckReport>(data, workspace, 'check', control);
