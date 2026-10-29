// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressPDFDialog, type CompressPDFDialogProps, type CompressPDFSource } from '../../src/components/Dialogs/CompressPDFDialog';
import type { OptimizerInspection, OptimizerResult } from '../../src/core/PDFOptimizerTypes';

const api = vi.hoisted(() => ({ inspect: vi.fn(), optimize: vi.fn(), preview: vi.fn() }));
vi.mock('../../src/core/PDFOptimizerClient', () => ({ inspectPDFOptimizationInWorker: api.inspect, optimizePDFInWorker: api.optimize }));
vi.mock('../../src/components/Dialogs/DecorationPDFPreview', () => ({ DecorationPDFPreview: ({ data, pageNumber, onError, scale }: { data: Uint8Array; pageNumber: number; onError: (message: string) => void; scale?: number }) => {
  api.preview(data, pageNumber, onError, scale); return <div data-preview data-scale={scale ?? 'fit'}>{[...data].join(',')} page {pageNumber}</div>;
} }));
let root: Root, host: HTMLDivElement, props: CompressPDFDialogProps, source: CompressPDFSource, inspection: OptimizerInspection, result: OptimizerResult;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:compressed') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  inspection = { inputBytes: 5000, pageCount: 2, imageCount: 4, eligibleImageCount: 2, canOptimize: true, warnings: ['Transparent images stay unchanged.'] };
  result = { data: new Uint8Array([7, 8, 9]), inputBytes: 5000, outputBytes: 3000, candidateBytes: 3000, pageCount: 2, imagesOptimized: 1, imagesSkipped: 2, imagesDeduplicated: 1, changed: true, warnings: ['Transparent images stay unchanged.', 'One decoration image was preserved.'] };
  source = { data: new Uint8Array([1, 2]).buffer, fileName: 'document.pdf' };
  api.inspect.mockResolvedValue(inspection); api.optimize.mockResolvedValue(result);
  props = { documentKey: 'one', revision: 1, currentPage: 2, readPDF: vi.fn(async () => source), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<CompressPDFDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<CompressPDFDialog {...props} />)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
async function radio(value: string) { await act(async () => (host.querySelector(`input[type=radio][value="${value}"]`)! as HTMLInputElement).click()); }
async function select(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('select')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function quality(value: number) {
  const input = host.querySelector('input[aria-label="JPEG quality"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function escape() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }

describe('CompressPDFDialog', () => {
  it('analyzes the prepared source, defaults to lossless, and downloads exactly the previewed result', async () => {
    await render(); expect(host.querySelector('dialog')?.open).toBe(true);
    expect(api.inspect.mock.calls[0][0]).toBe(source.data); expect(api.inspect.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect((host.querySelector('input[value="lossless"]') as HTMLInputElement).checked).toBe(true); expect(button('Download PDF').disabled).toBe(true);
    expect(host.textContent).toContain('4 image resources · 2 eligible'); expect(host.textContent).toContain('Text remains searchable');
    await click('Compress PDF'); expect(api.optimize.mock.calls[0][1]).toEqual({ mode: 'lossless', dpi: 150, quality: 80 });
    expect(host.textContent).toContain('Compression ready'); expect(host.textContent).toContain('40.0% smaller'); expect(host.textContent).toContain('3,000 bytes');
    expect([...host.querySelectorAll('[data-preview]')].map(element => element.textContent)).toEqual(['1,2 page 2', '7,8,9 page 2']);
    await click('Download PDF'); expect(api.optimize).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ size: result.data.length, type: 'application/pdf' });
    expect(host.textContent).toContain('Your open document and its history are unchanged'); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1100)); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:compressed');
  });
  it('uses image settings and invalidates a result immediately when those settings change', async () => {
    await render(); await radio('images'); await select('Image resolution', '200'); await quality(65); await click('Compress PDF');
    expect(api.optimize.mock.calls[0][1]).toEqual({ mode: 'images', dpi: 200, quality: 65 });
    expect(host.textContent).toContain('Fine details and image quality may change'); expect(host.textContent).toContain('Compression notes (2)');
    expect(button('Download PDF').disabled).toBe(false); await quality(75);
    expect(button('Download PDF').disabled).toBe(true); expect(host.querySelectorAll('[data-preview]')).toHaveLength(1);
    await click('Download PDF'); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('keeps both previews on the same selected page without recompressing', async () => {
    await render(); await click('Compress PDF'); await select('Preview page', '1');
    expect([...host.querySelectorAll('[data-preview]')].map(element => element.textContent)).toEqual(['1,2 page 1', '7,8,9 page 1']);
    expect(api.optimize).toHaveBeenCalledTimes(1); expect(api.inspect).toHaveBeenCalledTimes(1);
  });
  it('shares preview zoom across both PDFs and page changes without invalidating the compressed result', async () => {
    await render(); await click('Compress PDF');
    const scales = () => [...host.querySelectorAll('[data-preview]')].map(element => element.getAttribute('data-scale'));
    expect(scales()).toEqual(['fit', 'fit']);
    await select('Preview zoom', '1'); expect(scales()).toEqual(['1', '1']);
    await select('Preview zoom', '2'); await select('Preview page', '1'); expect(scales()).toEqual(['2', '2']);
    expect([...host.querySelectorAll('[data-preview]')].every(element => element.textContent?.endsWith('page 1'))).toBe(true);
    expect(button('Download PDF').disabled).toBe(false); expect(api.optimize).toHaveBeenCalledTimes(1); expect(api.inspect).toHaveBeenCalledTimes(1);
    await select('Preview zoom', 'fit'); expect(scales()).toEqual(['fit', 'fit']);
    await click('Download PDF'); expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ size: result.data.length });
  });
  it('explains a no-benefit result and offers the non-enlarged copy', async () => {
    api.optimize.mockResolvedValue({ ...result, data: new Uint8Array(source.data), outputBytes: 5000, candidateBytes: 6200, changed: false });
    await render(); await click('Compress PDF');
    expect(host.textContent).toContain('No size reduction with these settings'); expect(host.textContent).toContain('without increasing its size'); expect(host.textContent).not.toContain('smaller · saved');
    expect(button('Download PDF').disabled).toBe(false); await click('Download PDF'); expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ size: source.data.byteLength });
  });
  it('shows worker progress, prevents duplicate submissions, and cancels without publishing a late result', async () => {
    let finish!: (value: OptimizerResult) => void;
    api.optimize.mockImplementationOnce((_data, _settings, control) => { control.onProgress({ phase: 'images', completed: 1, total: 4 }); return new Promise(resolve => { finish = resolve; }); });
    await render(); const start = button('Compress PDF'); await act(async () => { start.click(); start.click(); });
    expect(api.optimize).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Optimizing images: 1 / 4');
    await click('Cancel compression'); expect(api.optimize.mock.calls[0][2].signal.aborted).toBe(true); await act(async () => finish(result));
    expect(host.textContent).toContain('Compression canceled'); expect(host.textContent).not.toContain('Compression ready'); expect(button('Download PDF').disabled).toBe(true); expect(props.onClose).not.toHaveBeenCalled();
    await click('Compress PDF'); expect(host.textContent).toContain('Compression ready');
  });
  it('aborts source preparation on Escape and never starts analysis for a late source', async () => {
    let finish!: (value: CompressPDFSource) => void;
    await render({ readPDF: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const signal = vi.mocked(props.readPDF).mock.calls[0][0]; await escape(); expect(signal.aborted).toBe(true); expect(props.onClose).toHaveBeenCalledTimes(1);
    await act(async () => finish(source)); expect(api.inspect).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('discards an old revision\'s compression and progress when the document is replaced', async () => {
    let finish!: (value: OptimizerResult) => void;
    api.optimize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('Compress PDF'); const control = api.optimize.mock.calls[0][2];
    await render({ revision: 2, readPDF: vi.fn(async () => ({ ...source, fileName: 'new.pdf' })) }); expect(control.signal.aborted).toBe(true);
    await act(async () => { control.onProgress({ phase: 'images', completed: 99, total: 100 }); finish(result); });
    expect(host.textContent).not.toContain('99 / 100'); expect(host.textContent).not.toContain('Compression ready'); expect(button('Download PDF').disabled).toBe(true);
    expect((host.querySelector('input:not([type])') as HTMLInputElement).value).toBe('new-compressed.pdf'); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects old analysis on a document identity change and clamps the current page', async () => {
    let finish!: (value: OptimizerInspection) => void;
    api.inspect.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await render();
    const oldSignal = api.inspect.mock.calls[0][1].signal; api.inspect.mockResolvedValue({ ...inspection, pageCount: 1 });
    await render({ documentKey: 'two' }); await act(async () => finish({ ...inspection, canOptimize: false, unsupportedReason: 'OLD FILE' }));
    expect(oldSignal.aborted).toBe(true); expect(host.textContent).not.toContain('OLD FILE'); expect(host.querySelector('[data-preview]')?.textContent).toBe('1,2 page 1');
  });
  it('shows restrictions without enabling compression or downloading', async () => {
    api.inspect.mockResolvedValue({ ...inspection, canOptimize: false, unsupportedReason: 'Signed PDFs cannot be compressed safely.' }); await render();
    expect(host.textContent).toContain('Signed PDFs cannot be compressed safely'); expect(button('Compress PDF').disabled).toBe(true); expect(button('Download PDF').disabled).toBe(true); expect(api.optimize).not.toHaveBeenCalled();
  });
  it('allows retries after source and compression failures without losing the source PDF', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Apply or discard pending areas.')).mockResolvedValue(source) });
    expect(host.textContent).toContain('Apply or discard'); await click('Retry analysis');
    api.optimize.mockRejectedValueOnce(new Error('The compressed PDF could not be verified.')); await click('Compress PDF');
    expect(host.textContent).toContain('could not be verified'); expect(button('Download PDF').disabled).toBe(true); expect(host.querySelector('[data-preview]')?.textContent).toBe('1,2 page 2');
    await click('Compress PDF'); expect(button('Download PDF').disabled).toBe(false);
  });
  it('blocks downloads when rendering the generated PDF fails', async () => {
    await render(); await click('Compress PDF');
    const failed = api.preview.mock.calls.findLast(call => call[0] === result.data)!;
    await act(async () => failed[2]('Could not render this compressed page.'));
    expect(host.textContent).toContain('Could not render this compressed page'); expect(button('Download PDF').disabled).toBe(true); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('contains keyboard shortcuts, downloads on Ctrl+S only when ready, and restores focus on unmount', async () => {
    const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
    const backgroundShortcut = vi.fn(); document.addEventListener('keydown', backgroundShortcut);
    await render(); const modal = host.querySelector('dialog')!;
    const shortcut = () => new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    const early = shortcut(); await act(async () => modal.dispatchEvent(early)); expect(early.defaultPrevented).toBe(true); expect(URL.createObjectURL).not.toHaveBeenCalled();
    await click('Compress PDF'); await act(async () => modal.dispatchEvent(shortcut())); expect(URL.createObjectURL).toHaveBeenCalledTimes(1); expect(backgroundShortcut).not.toHaveBeenCalled();
    await act(async () => root.render(null)); expect(document.activeElement).toBe(launcher); launcher.remove(); document.removeEventListener('keydown', backgroundShortcut);
  });
  it('aborts compression on external unmount and never downloads its late result', async () => {
    let finish!: (value: OptimizerResult) => void; api.optimize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('Compress PDF'); const signal = api.optimize.mock.calls[0][2].signal;
    await act(async () => root.render(null)); await act(async () => finish(result)); expect(signal.aborted).toBe(true); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
