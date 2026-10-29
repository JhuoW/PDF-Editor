import { VISIBLE_COPY_LIMITS, DEFAULT_VISIBLE_COPY_SETTINGS, type VisibleCopyControl, type VisibleCopyInspection, type VisibleCopyResult, type VisibleCopySettings } from './VisibleCopyTypes';

function run<T extends VisibleCopyInspection | VisibleCopyResult>(job: 'inspect' | 'create', data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings, control: VisibleCopyControl): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('Visible copy cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > VISIBLE_COPY_LIMITS.inputBytes) return Promise.reject(new Error('Visible copies accept PDFs between 1 byte and 256 MB.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./VisibleCopy.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate(); control.signal?.removeEventListener('abort', abort);
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('Visible copy cancelled', 'AbortError'));
    worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || 'Could not start the visible-copy renderer.')); };
    worker.onmessageerror = () => fail(new Error('The visible-copy renderer returned unreadable data.'));
    worker.onmessage = event => {
      if (settled) return;
      const packet = event.data;
      if (packet?.type === 'progress' && packet.progress) {
        try { control.onProgress?.(packet.progress); } catch (error) { fail(error); }
      } else if (packet?.type === 'result' && packet.result) { if (finish()) resolve(packet.result); }
      else if (packet?.type === 'error') fail(new Error(packet.message || 'Could not create a visible copy.'));
      else fail(new Error('The visible-copy renderer returned an unexpected response.'));
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    if (control.signal?.aborted) { abort(); return; }
    try {
      const privateData = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
      worker.postMessage({ job, data: privateData.buffer, settings, previewPage: control.previewPage }, [privateData.buffer]);
    } catch (error) { fail(error); }
  });
}

export function inspectVisibleCopyInWorker(data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings = DEFAULT_VISIBLE_COPY_SETTINGS, control: VisibleCopyControl = {}): Promise<VisibleCopyInspection> {
  return run('inspect', data, settings, control);
}
export function createVisibleCopyInWorker(data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings = DEFAULT_VISIBLE_COPY_SETTINGS, control: VisibleCopyControl = {}): Promise<VisibleCopyResult> {
  return run('create', data, settings, control);
}
