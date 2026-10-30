import type { PageExportControl, PageExportProgress, PageExportResult, PageExportSettings } from './PageExport';
import { PAGE_EXPORT_LIMITS } from './PageExport';

export function exportPagesInWorker(data: Uint8Array | ArrayBuffer, settings: PageExportSettings, control: PageExportControl = {}): Promise<PageExportResult> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > PAGE_EXPORT_LIMITS.inputBytes) return Promise.reject(new Error('Page export accepts PDFs up to 256 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./PageExport.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate(); control.signal?.removeEventListener('abort', abort);
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('Export cancelled', 'AbortError'));
    control.signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the page export worker.')); };
    worker.onmessageerror = () => fail(new Error('The page export worker returned unreadable data.'));
    worker.onmessage = (event: MessageEvent<{ type: string; progress?: PageExportProgress; result?: PageExportResult; message?: string }>) => {
      if (settled) return;
      if (event.data?.type === 'progress' && event.data.progress) {
        try { control.onProgress?.(event.data.progress); } catch (error) { fail(error); }
      }
      else if (event.data?.type === 'result' && event.data.result) { if (finish()) resolve(event.data.result); }
      else if (event.data?.type === 'error') fail(new Error(event.data.message || 'Could not export pages.'));
      else fail(new Error('The page export worker returned an unexpected response.'));
    };
    if (control.signal?.aborted) { abort(); return; }
    try {
      // Transfer a private copy, never the caller's active PDF or history buffer.
      const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
      worker.postMessage({ data: bytes.buffer, settings }, [bytes.buffer]);
    } catch (error) { fail(error); }
  });
}

export function downloadPageExport(result: PageExportResult) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(result.data)], { type: result.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = result.fileName;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
