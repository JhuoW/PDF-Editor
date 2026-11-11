import type { FreeTextAnnotation } from './types';
interface Preview { png: Uint8Array<ArrayBuffer>; width: number; height: number; contentHeight: number }
let worker: Worker | undefined, nextId = 0, idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve: (preview: Preview) => void; reject: (error: Error) => void }>();
function stop(error?: Error) {
  worker?.terminate(); worker = undefined; clearTimeout(idle);
  for (const item of pending.values()) item.reject(error ?? new Error('Text preview stopped'));
  pending.clear();
}
export function requestFreeTextPreview(annotation: FreeTextAnnotation, scale: number, signal: AbortSignal): Promise<Preview> {
  if (signal.aborted) return Promise.reject(new DOMException('Preview cancelled', 'AbortError'));
  clearTimeout(idle);
  if (!worker) {
    worker = new Worker(new URL('./FreeTextPreview.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = event => { event.preventDefault(); stop(new Error('Could not prepare the text box preview')); };
    worker.onmessageerror = () => stop(new Error('Could not read the text box preview'));
    worker.onmessage = event => {
      const item = pending.get(event.data.id); if (!item) return;
      pending.delete(event.data.id);
      if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data);
      if (!pending.size) idle = setTimeout(() => stop(), 30_000);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const abort = () => { pending.delete(id); reject(new DOMException('Preview cancelled', 'AbortError')); if (!pending.size) stop(); };
    pending.set(id, { resolve: result => { signal.removeEventListener('abort', abort); resolve(result); }, reject: error => { signal.removeEventListener('abort', abort); reject(error); } });
    signal.addEventListener('abort', abort, { once: true });
    worker!.postMessage({ id, annotation, scale });
  });
}
