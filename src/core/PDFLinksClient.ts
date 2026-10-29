import { PDF_LINK_LIMITS, type PDFLinkControl, type PDFLinkInspection, type PDFLinkOperation } from './PDFLinkTypes';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import type { applyPDFLinksWorkspace, preparePDFLinksWorkspace } from './PDFLinksWorkspace';

type Prepared = Awaited<ReturnType<typeof preparePDFLinksWorkspace>>;
type Applied = Awaited<ReturnType<typeof applyPDFLinksWorkspace>>;
type Request = { job: 'inspect' } | { job: 'prepare'; workspace: WorkspaceSnapshot }
  | { job: 'preview' | 'apply'; workspace: WorkspaceSnapshot; operations: PDFLinkOperation[] };

function isReport(value: unknown): value is PDFLinkInspection {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<PDFLinkInspection>;
  return typeof report.revision === 'string' && typeof report.canEdit === 'boolean' && Array.isArray(report.pages) && Array.isArray(report.links);
}

function run<T>(data: ArrayBuffer | Uint8Array, request: Request, control: PDFLinkControl): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('PDF links cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > PDF_LINK_LIMITS.inputBytes) return Promise.reject(new Error('Link editing accepts PDFs between 1 byte and 200 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./PDFLinks.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', abort); worker.terminate();
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('PDF links cancelled', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the PDF links worker.')); };
    worker.onmessageerror = () => fail(new Error('The PDF links worker returned unreadable data.'));
    worker.onmessage = event => {
      if (settled) return;
      const packet = event.data;
      if (packet?.type === 'progress' && Number.isInteger(packet.progress?.completed) && Number.isInteger(packet.progress?.total)
        && packet.progress.completed >= 0 && packet.progress.total >= packet.progress.completed) {
        try { control.onProgress?.(packet.progress); } catch (error) { fail(error); }
        return;
      }
      const result = packet?.result;
      const valid = request.job === 'inspect' ? isReport(result)
        : request.job === 'prepare' ? result?.data instanceof ArrayBuffer && isReport(result?.report)
        : request.job === 'preview' ? result instanceof Uint8Array
        : result?.data instanceof Uint8Array && result?.workspace?.editing?.textBlocks instanceof Map
          && result.workspace?.annotations && result.workspace?.form;
      if (packet?.type === 'result' && valid) { if (finish()) resolve(result); }
      else if (packet?.type === 'error') fail(new Error(typeof packet.message === 'string' && packet.message ? packet.message : 'Could not edit PDF links.'));
      else fail(new Error('The PDF links worker returned an unexpected response.'));
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) { abort(); return; }
    try {
      // Only this exact private PDF range transfers. Image edits and history in
      // the workspace are structured-cloned without detaching their buffers.
      const privateData = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
      worker.postMessage({ ...request, data: privateData.buffer, expectedRevision: control.expectedRevision }, [privateData.buffer]);
    } catch (error) { fail(error); }
  });
}

export function inspectPDFLinksInWorker(data: ArrayBuffer | Uint8Array, control: PDFLinkControl = {}): Promise<PDFLinkInspection> {
  return run(data, { job: 'inspect' }, control);
}
export function preparePDFLinksWorkspaceInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, control: PDFLinkControl = {}): Promise<Prepared> {
  return run(data, { job: 'prepare', workspace }, control);
}
export function previewPDFLinksInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, operations: PDFLinkOperation[], control: PDFLinkControl = {}): Promise<Uint8Array> {
  return run(data, { job: 'preview', workspace, operations }, control);
}
export function applyPDFLinksWorkspaceInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, operations: PDFLinkOperation[], control: PDFLinkControl = {}): Promise<Applied> {
  return run(data, { job: 'apply', workspace, operations }, control);
}
