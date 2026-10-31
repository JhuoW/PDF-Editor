import type { FontAsset } from './fontAsset';
import { MAX_FONT_BYTES, MAX_LIBRARY_BYTES } from './fontAsset';

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-fonts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('fonts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open the local font library.'));
  });
}
/** Check the budget and write in the same transaction, including across tabs. */
export async function fontLibrary(action?: { add: FontAsset } | { remove: string }): Promise<FontAsset[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('fonts', action ? 'readwrite' : 'readonly'), store = tx.objectStore('fonts');
    let result: FontAsset[] = [], failure: Error | undefined;
    const request = store.getAll();
    request.onsuccess = () => {
      result = request.result;
      if (action && 'add' in action) {
        result = result.filter(asset => asset.id !== action.add.id);
        if (result.reduce((total, asset) => total + asset.data.byteLength, action.add.data.byteLength) > MAX_LIBRARY_BYTES) {
          failure = new Error('The font library is limited to 64 MB. Remove unused fonts before importing more.'); tx.abort(); return;
        }
        result.push(action.add); store.put(action.add);
      } else if (action) { result = result.filter(asset => asset.id !== action.remove); store.delete(action.remove); }
    };
    tx.oncomplete = () => { db.close(); resolve(result.sort((a, b) => a.name.localeCompare(b.name))); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? new Error('Could not save the local font library. Check browser storage permissions and free space.')); };
  });
}
export async function importFontFile(file: File, signal?: AbortSignal): Promise<FontAsset> {
  if (file.size > MAX_FONT_BYTES) throw new Error('A font file must be no larger than 32 MB.');
  const data = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Font import cancelled.', 'AbortError');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./FontImport.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('Font import cancelled.', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(); reject(new Error('Could not read this font file.')); };
    worker.onmessageerror = () => { finish(); reject(new Error('Could not read this font file.')); };
    worker.onmessage = event => {
      finish();
      if (event.data?.asset?.data instanceof ArrayBuffer) resolve(event.data.asset);
      else reject(new Error(event.data?.error || 'Could not read this font file.'));
    };
    try { worker.postMessage({ data, fileName: file.name }, [data]); } catch (error) { finish(); reject(error); }
  });
}
