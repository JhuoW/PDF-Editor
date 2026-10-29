import {
  DEFAULT_OPTIMIZER_SETTINGS, PDF_OPTIMIZER_LIMITS,
  type OptimizerControl, type OptimizerInspection, type OptimizerProgress,
  type OptimizerResult, type OptimizerSettings,
} from './PDFOptimizerTypes';

function isProgress(value: unknown): value is OptimizerProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Partial<OptimizerProgress>;
  return ['inspect', 'images', 'save', 'verify'].includes(progress.phase ?? '')
    && Number.isInteger(progress.completed) && Number.isInteger(progress.total)
    && progress.completed! >= 0 && progress.total! >= progress.completed!;
}

function run<T extends OptimizerInspection | OptimizerResult>(
  job: 'inspect' | 'optimize', data: Uint8Array | ArrayBuffer,
  settings: OptimizerSettings | undefined, control: OptimizerControl,
): Promise<T> {
  if (control.signal?.aborted) return Promise.reject(new DOMException('PDF compression cancelled', 'AbortError'));
  if (!data.byteLength || data.byteLength > PDF_OPTIMIZER_LIMITS.inputBytes) {
    return Promise.reject(new Error('PDF compression accepts files between 1 byte and 200 MB.'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./PDFOptimizer.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      control.signal?.removeEventListener('abort', abort);
      worker.terminate();
      return true;
    };
    const fail = (error: unknown) => { if (finish()) reject(error); };
    const abort = () => fail(new DOMException('PDF compression cancelled', 'AbortError'));
    worker.onerror = event => {
      event.preventDefault();
      fail(new Error(event.message || 'Could not start the PDF compression worker.'));
    };
    worker.onmessageerror = () => fail(new Error('The PDF compression worker returned unreadable data.'));
    worker.onmessage = event => {
      if (settled) return;
      const packet = event.data;
      if (packet?.type === 'progress' && isProgress(packet.progress)) {
        try { control.onProgress?.(packet.progress); } catch (error) { fail(error); }
      } else if (packet?.type === 'result' && packet.result
        && (job === 'inspect' ? typeof packet.result.canOptimize === 'boolean' : packet.result.data instanceof Uint8Array)) {
        if (finish()) resolve(packet.result);
      } else if (packet?.type === 'error') {
        fail(new Error(typeof packet.message === 'string' && packet.message ? packet.message : 'Could not compress the PDF.'));
      } else {
        fail(new Error('The PDF compression worker returned an unexpected response.'));
      }
    };
    control.signal?.addEventListener('abort', abort, { once: true });
    // Abort may occur between the initial check and listener registration.
    if (control.signal?.aborted) { abort(); return; }
    try {
      // Copy only the supplied byte range. Never detach the active document or history.
      const privateData = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
      worker.postMessage({ job, data: privateData.buffer, settings }, [privateData.buffer]);
    } catch (error) { fail(error); }
  });
}

export function inspectPDFOptimizationInWorker(data: Uint8Array | ArrayBuffer, control: OptimizerControl = {}): Promise<OptimizerInspection> {
  return run('inspect', data, undefined, control);
}

export function optimizePDFInWorker(
  data: Uint8Array | ArrayBuffer,
  settings: OptimizerSettings = DEFAULT_OPTIMIZER_SETTINGS,
  control: OptimizerControl = {},
): Promise<OptimizerResult> {
  return run('optimize', data, settings, control);
}
