import { PDF_BOOKMARK_LIMITS, type PDFBookmarkControl, type PDFBookmarkInspection, type PDFBookmarkDraft } from './PDFBookmarksTypes';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import type { applyPDFBookmarksWorkspace, preparePDFBookmarksWorkspace } from './PDFBookmarksWorkspace';

type Prepared = Awaited<ReturnType<typeof preparePDFBookmarksWorkspace>>;
type Applied = Awaited<ReturnType<typeof applyPDFBookmarksWorkspace>>;
type Request = { job: 'inspect' } | { job: 'prepare'; workspace: WorkspaceSnapshot }
  | { job: 'preview' | 'apply'; workspace: WorkspaceSnapshot; tree: PDFBookmarkDraft[] };

function isReport(value: unknown): value is PDFBookmarkInspection {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<PDFBookmarkInspection>;
  return typeof report.revision === 'string' && typeof report.canEdit === 'boolean' && Array.isArray(report.pages) && Array.isArray(report.bookmarks);
}

function run<T>(data: ArrayBuffer | Uint8Array, request: Request, control: PDFBookmarkControl): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('PDF bookmarks cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > PDF_BOOKMARK_LIMITS.inputBytes) return Promise.reject(new Error('Bookmark editing accepts PDFs between 1 byte and 200 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./PDFBookmarks.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', abort); worker.terminate();
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('PDF bookmarks cancelled', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the PDF bookmarks worker.')); };
    worker.onmessageerror = () => fail(new Error('The PDF bookmarks worker returned unreadable data.'));
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
      else if (packet?.type === 'error') fail(new Error(typeof packet.message === 'string' && packet.message ? packet.message : 'Could not edit PDF bookmarks.'));
      else fail(new Error('The PDF bookmarks worker returned an unexpected response.'));
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

export function inspectPDFBookmarksInWorker(data: ArrayBuffer | Uint8Array, control: PDFBookmarkControl = {}): Promise<PDFBookmarkInspection> {
  return run(data, { job: 'inspect' }, control);
}
export function preparePDFBookmarksWorkspaceInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, control: PDFBookmarkControl = {}): Promise<Prepared> {
  return run(data, { job: 'prepare', workspace }, control);
}
export function previewPDFBookmarksInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, tree: PDFBookmarkDraft[], control: PDFBookmarkControl = {}): Promise<Uint8Array> {
  return run(data, { job: 'preview', workspace, tree }, control);
}
export function applyPDFBookmarksWorkspaceInWorker(data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, tree: PDFBookmarkDraft[], control: PDFBookmarkControl = {}): Promise<Applied> {
  return run(data, { job: 'apply', workspace, tree }, control);
}
