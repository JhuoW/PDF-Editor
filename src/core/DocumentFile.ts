/** File handles are capabilities kept only in the current browser runtime. */
export interface PDFFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{
    write(data: Uint8Array<ArrayBuffer>): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}
interface PDFPickerWindow extends Window {
  showOpenFilePicker?: (options: unknown) => Promise<PDFFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<PDFFileHandle>;
}
const pdfTypes = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];
const pickerWindow = () => window as PDFPickerWindow;
const cancelled = (error: unknown) => Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
export const canUseNativeOpenPicker = () => typeof pickerWindow().showOpenFilePicker === 'function';
export const canUseNativeSavePicker = () => typeof pickerWindow().showSaveFilePicker === 'function';

export async function ensurePDFWritePermission(handle: PDFFileHandle): Promise<void> {
  if (!handle.queryPermission || await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return;
  if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) === 'granted') return;
  throw new Error('Permission to save this PDF was denied. Choose Save As to save a copy.');
}

export async function openPDFFile(): Promise<{ file: File; handle?: PDFFileHandle } | null> {
  const picker = pickerWindow().showOpenFilePicker;
  if (!picker) return null;
  try {
    const [handle] = await picker.call(window, { multiple: false, types: pdfTypes, excludeAcceptAllOption: true });
    return handle ? { file: await handle.getFile(), handle } : null;
  } catch (error) { if (cancelled(error)) return null; throw error; }
}

/** Invoke from the click handler, before preparing a PDF can consume user activation. */
export async function selectSavePDFHandle(fileName: string): Promise<PDFFileHandle | null> {
  const picker = pickerWindow().showSaveFilePicker;
  if (!picker) return null;
  try { return await picker.call(window, { suggestedName: fileName, types: pdfTypes, excludeAcceptAllOption: true }); }
  catch (error) { if (cancelled(error)) return null; throw error; }
}

export async function savePDFFile(
  data: Uint8Array | ArrayBuffer,
  fileName: string,
  options: { saveAs?: boolean; handle?: PDFFileHandle } = {},
): Promise<{ saved: boolean; handle?: PDFFileHandle; fileName: string }> {
  let handle = options.saveAs ? undefined : options.handle;
  if (!handle && canUseNativeSavePicker()) {
    const selected = await selectSavePDFHandle(fileName);
    if (!selected) return { saved: false, fileName };
    handle = selected;
  }
  if (handle) {
    let writable: Awaited<ReturnType<PDFFileHandle['createWritable']>> | undefined;
    try {
      await ensurePDFWritePermission(handle);
      writable = await handle.createWritable();
      await writable.write(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)));
      await writable.close();
      return { saved: true, handle, fileName: handle.name || fileName };
    } catch (error) {
      try { await writable?.abort?.(); } catch { /* Keep the original write error. */ }
      if (cancelled(error)) return { saved: false, fileName };
      throw error;
    }
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data))], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = fileName;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true, fileName };
}
