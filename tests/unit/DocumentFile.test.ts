// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canUseNativeOpenPicker, ensurePDFWritePermission, openPDFFile, savePDFFile, selectSavePDFHandle, type PDFFileHandle } from '../../src/core/DocumentFile';

const data = new Uint8Array([1, 2, 3]);
function fileHandle(name = 'saved.pdf') {
  const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
  const handle = { name, getFile: vi.fn().mockResolvedValue(new File([data], name)), createWritable: vi.fn().mockResolvedValue(stream) };
  return { handle, stream };
}
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  Reflect.deleteProperty(window, 'showSaveFilePicker'); Reflect.deleteProperty(window, 'showOpenFilePicker');
});
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window, 'showSaveFilePicker'); Reflect.deleteProperty(window, 'showOpenFilePicker'); });
describe('PDF file save capabilities', () => {
  it('opens a native file and returns only its runtime handle; cancellation is distinct from unsupported UI', async () => {
    expect(canUseNativeOpenPicker()).toBe(false); expect(await openPDFFile()).toBeNull();
    const { handle } = fileHandle('opened.pdf'), picker = vi.fn().mockResolvedValue([handle]);
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: picker });
    expect(canUseNativeOpenPicker()).toBe(true); expect(await openPDFFile()).toEqual({ file: await handle.getFile(), handle });
    picker.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    expect(await openPDFFile()).toBeNull();
  });

  it('writes through an owned handle without another picker, then Save As selects a new destination', async () => {
    const original = fileHandle('original.pdf'), other = fileHandle('copy.pdf'), picker = vi.fn().mockResolvedValue(other.handle);
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    expect(await savePDFFile(data, 'original.pdf', { handle: original.handle })).toEqual({ saved: true, handle: original.handle, fileName: 'original.pdf' });
    expect(picker).not.toHaveBeenCalled(); expect(original.stream.write).toHaveBeenCalledWith(data); expect(original.stream.close).toHaveBeenCalledOnce();
    expect(await savePDFFile(data, 'original.pdf', { handle: original.handle, saveAs: true })).toEqual({ saved: true, handle: other.handle, fileName: 'copy.pdf' });
    expect(picker).toHaveBeenCalledOnce(); expect(other.stream.write).toHaveBeenCalledWith(data);
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('does not download after picker cancellation, denied permission, or an unsuccessful write', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')) });
    expect(await savePDFFile(data, 'cancelled.pdf')).toEqual({ saved: false, fileName: 'cancelled.pdf' });
    const { handle, stream } = fileHandle();
    stream.write.mockRejectedValue(new Error('disk full'));
    await expect(savePDFFile(data, 'saved.pdf', { handle })).rejects.toThrow('disk full');
    expect(stream.abort).toHaveBeenCalledOnce(); expect(stream.close).not.toHaveBeenCalled();
    const denied: PDFFileHandle = { ...handle, queryPermission: vi.fn().mockResolvedValue('prompt'), requestPermission: vi.fn().mockResolvedValue('denied') };
    await expect(ensurePDFWritePermission(denied)).rejects.toThrow('Permission');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('invokes the destination picker immediately and uses a download when the API is unsupported', async () => {
    const { handle } = fileHandle(), picker = vi.fn().mockResolvedValue(handle);
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
    const choosing = selectSavePDFHandle('new.pdf'); expect(picker).toHaveBeenCalledOnce(); expect(await choosing).toBe(handle);
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    expect(await savePDFFile(data, 'fallback.pdf')).toEqual({ saved: true, fileName: 'fallback.pdf' });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(document.querySelector('a')).toBeNull();
  });
});
