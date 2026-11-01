import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import type { PreparedTextEditLayout, TextLayoutContext } from './TextEditApplier';
import type { TextLayoutControl } from './TextLayout';
import type { TextBlock, TextEditOperation } from './types';

const MAX_INPUT_BYTES = 200 * 1024 * 1024;
type Request = { job: 'prepare'; block: TextBlock; edit?: TextEditOperation; context?: TextLayoutContext }
  | { job: 'preview'; workspace: WorkspaceSnapshot; edit: TextEditOperation };

function run<T extends PreparedTextEditLayout | Uint8Array>(data: ArrayBuffer | Uint8Array, request: Request, control: TextLayoutControl): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('Text layout cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > MAX_INPUT_BYTES) return Promise.reject(new Error('Text layout accepts PDFs between 1 byte and 200 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./TextLayout.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', abort); worker.terminate();
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('Text layout cancelled', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the text layout worker.')); };
    worker.onmessageerror = () => fail(new Error('The text layout worker returned unreadable data.'));
    worker.onmessage = event => {
      if (settled) return;
      const packet = event.data;
      const validResult = request.job === 'preview' ? packet?.result instanceof Uint8Array
        : packet?.result?.input && typeof packet?.result?.layout?.fits === 'boolean'
          && Number.isFinite(packet?.result?.page?.width) && Number.isFinite(packet?.result?.page?.height);
      if (packet?.type === 'result' && validResult) { if (finish()) resolve(packet.result); }
      else if (packet?.type === 'error') fail(new Error(typeof packet.message === 'string' && packet.message ? packet.message : 'Could not prepare the text layout.'));
      else fail(new Error('The text layout worker returned an unexpected response.'));
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) { abort(); return; }
    try {
      // The workspace is structured-cloned by postMessage. Only this private PDF
      // buffer is transferred: neither source history nor image-edit data detach.
      const privateData = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
      worker.postMessage({ ...request, data: privateData.buffer }, [privateData.buffer]);
    } catch (error) { fail(error); }
  });
}

export function prepareTextEditLayoutInWorker(
  data: ArrayBuffer | Uint8Array, block: TextBlock, edit?: TextEditOperation, control: TextLayoutControl = {}, context?: TextLayoutContext,
): Promise<PreparedTextEditLayout> {
  return run(data, { job: 'prepare', block, edit, ...(context ? { context } : {}) }, control);
}

export function previewTextEditInWorker(
  data: ArrayBuffer | Uint8Array, workspace: WorkspaceSnapshot, edit: TextEditOperation, control: TextLayoutControl = {},
): Promise<Uint8Array> {
  return run(data, { job: 'preview', workspace, edit }, control);
}
