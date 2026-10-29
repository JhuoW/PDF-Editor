// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanVisibleCopyPanel } from '../../src/components/Dialogs/CleanVisibleCopyPanel';
import type { VisibleCopyInspection, VisibleCopyResult } from '../../src/core/VisibleCopyTypes';
const api = vi.hoisted(() => ({ inspect: vi.fn(), create: vi.fn() }));
vi.mock('../../src/core/VisibleCopyClient', () => ({ inspectVisibleCopyInWorker: api.inspect, createVisibleCopyInWorker: api.create }));
vi.mock('../../src/components/Dialogs/DecorationPDFPreview', () => ({ DecorationPDFPreview: ({ data, pageNumber }: { data: Uint8Array; pageNumber: number }) => <div data-preview>{[...data].join(',')} page {pageNumber}</div> }));
let root: Root, host: HTMLDivElement, props: ComponentProps<typeof CleanVisibleCopyPanel>, inspected: VisibleCopyInspection, result: VisibleCopyResult;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:copy') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  inspected = { pageCount: 2, pages: [1, 2].map(pageNumber => ({ pageNumber, width: 400, height: 600, pixelWidth: 800, pixelHeight: 1200, pixels: 960000 })), totalPixels: 1920000, hasSignatures: true,
    warnings: [{ pageNumber: 2, fontName: 'Missing Font', message: 'A substitute font will be used.' }], warningsTruncated: false };
  result = { data: new Uint8Array([2]), pageCount: 1, sourcePageCount: 2, pages: [2], dpi: 150, compression: 'lossless', encodedImageBytes: 10000, warnings: inspected.warnings, warningsTruncated: false };
  api.inspect.mockResolvedValue(inspected); api.create.mockImplementation(async (_data, _settings, control) => control.previewPage ? result : { ...result, data: new Uint8Array([3, 4]), pageCount: 2, pages: [1, 2] });
  props = { source: { data: new Uint8Array([1]).buffer, fileName: 'private.pdf', workspaceAnnotations: { count: 0, pages: [] }, pendingRedactions: 0, preparePreview: vi.fn(async value => value), readVisiblePDF: vi.fn(async () => new Uint8Array([7]).buffer) }, currentPage: 2, active: true, onClose: vi.fn(), onBusy: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<typeof props> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<CleanVisibleCopyPanel {...props} />)); }
async function preview() { await act(async () => vi.advanceTimersByTimeAsync(250)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
async function select(label: string, value: string) {
  const element = [...host.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('select')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('CleanVisibleCopyPanel', () => {
  it('shows raster limitations, uses a real single-page sample, and downloads all pages without changing the open document', async () => {
    await render(); await preview();
    expect(host.textContent).toContain('Text cannot be searched or copied'); expect(host.textContent).toContain('digital signatures are not retained');
    expect(api.create.mock.calls[0][1]).toEqual({ dpi: 150, compression: 'lossless' }); expect(api.create.mock.calls[0][2]).toMatchObject({ previewPage: 2 });
    expect(host.querySelector('[data-preview]')?.textContent).toBe('2 page 1'); expect(host.textContent).toContain('Rough total estimate'); expect(host.textContent).toContain('Font substitutions (1)');
    await click('Download image-only PDF'); expect(api.create.mock.calls[1][2].previewPage).toBeUndefined(); expect(URL.createObjectURL).toHaveBeenCalledTimes(1); expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Downloaded 2 pages'); expect(host.textContent).toContain('open document is unchanged'); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1100)); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:copy');
  });
  it('does not prepare or download while marked content areas remain pending', async () => {
    props.source.pendingRedactions = 2; await render(); await preview();
    expect(host.textContent).toContain('Apply or discard the 2 marked content areas'); expect(props.source.readVisiblePDF).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled(); expect(button('Download image-only PDF').disabled).toBe(true);
  });
  it('honors resolution and JPEG settings while discarding obsolete preview results', async () => {
    let finish!: (value: VisibleCopyResult) => void; api.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await preview(); const oldSignal = api.create.mock.calls[0][2].signal;
    await select('Resolution', '300'); await select('Image compression', 'jpeg'); await preview();
    expect(oldSignal.aborted).toBe(true); expect(api.create.mock.calls.at(-1)[1]).toEqual({ dpi: 300, compression: 'jpeg', quality: 90 });
    await act(async () => finish({ ...result, data: new Uint8Array([99]) })); expect(host.querySelector('[data-preview]')?.textContent).toBe('2 page 1');
  });
  it('blocks duplicate downloads and cancels a running generation before any file is created', async () => {
    let finish!: (value: VisibleCopyResult) => void;
    await render(); await preview(); api.create.mockImplementationOnce((_data, _settings, control) => {
      control.onProgress({ phase: 'render', completed: 1, total: 2 }); return new Promise(resolve => { finish = resolve; });
    });
    await click('Download image-only PDF'); await click('Download image-only PDF'); expect(api.create).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('Rendering 1 of 2 pages');
    await click('Cancel generation'); expect(api.create.mock.calls[1][2].signal.aborted).toBe(true); await act(async () => finish(result));
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(host.textContent).toContain('No file was downloaded'); expect(props.onBusy).toHaveBeenLastCalledWith(false);
  });
  it('aborts a pending read and does not start workers after unmount', async () => {
    let finish!: (value: ArrayBuffer) => void;
    props.source.readVisiblePDF = vi.fn(() => new Promise(resolve => { finish = resolve; })); await render();
    const signal = vi.mocked(props.source.readVisiblePDF).mock.calls[0][0]; await act(async () => root.render(null)); await act(async () => finish(new Uint8Array([1]).buffer)); await preview();
    expect(signal.aborted).toBe(true); expect(api.inspect).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  });
  it('does not download a worker result arriving after unmount', async () => {
    let finish!: (value: VisibleCopyResult) => void;
    await render(); await preview(); api.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await click('Download image-only PDF');
    await act(async () => root.render(null)); await act(async () => finish(result)); expect(api.create.mock.calls[1][2].signal.aborted).toBe(true); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('reports resource or rendering failures and leaves settings available for retry', async () => {
    api.inspect.mockRejectedValueOnce(new Error('Reduce the resolution to fit the pixel limit.')); await render(); await preview();
    expect(host.textContent).toContain('Reduce the resolution'); expect(button('Download image-only PDF').disabled).toBe(true);
    await select('Resolution', '300'); await preview(); api.create.mockRejectedValueOnce(new Error('A page image could not be decoded.')); await click('Download image-only PDF');
    expect(host.textContent).toContain('could not be decoded'); expect(button('Download image-only PDF').disabled).toBe(false); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('retries source preparation failures without creating stale downloads', async () => {
    props.source.readVisiblePDF = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(new Uint8Array([7]).buffer);
    await render(); expect(host.textContent).toContain('Read failed'); await click('Retry'); await preview(); expect(button('Download image-only PDF').disabled).toBe(false); expect(props.source.readVisiblePDF).toHaveBeenCalledTimes(2);
  });
});
