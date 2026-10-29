// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFLinksPreview } from '../../src/components/Dialogs/PDFLinksPreview';
const api = vi.hoisted(() => ({ getDocument: vi.fn(), annotations: vi.fn(), render: vi.fn(), destroy: vi.fn(), cancel: vi.fn() }));
vi.mock('../../src/utils/pdfConfig', () => ({ pdfDocumentOptions: {}, pdfjsLib: { getDocument: api.getDocument } }));
let host: HTMLDivElement, root: Root, props: ComponentProps<typeof PDFLinksPreview>;
function viewport({ scale, rotation = 90 }: { scale: number; rotation?: number }) {
  // Native Rotate=90, CropBox origin (50,150), UserUnit=2. All geometry uses
  // a rotation=0 source viewport and maps through original PDF coordinates.
  return { scale, rotation, transform: rotation === 90 ? [0, 2 * scale, 2 * scale, 0, -300 * scale, -100 * scale] : [2 * scale, 0, 0, -2 * scale, -100 * scale, 900 * scale], width: (rotation === 90 ? 600 : 400) * scale, height: (rotation === 90 ? 400 : 600) * scale,
    convertToPdfPoint: (x: number, y: number) => rotation === 90 ? [50 + y / scale / 2, 150 + x / scale / 2] : [50 + x / scale / 2, 450 - y / scale / 2],
    convertToViewportPoint: (x: number, y: number) => rotation === 90 ? [(y - 150) * 2 * scale, (x - 50) * 2 * scale] : [(x - 50) * 2 * scale, (450 - y) * 2 * scale] };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => ({})) });
  for (const method of ['setPointerCapture', 'releasePointerCapture']) Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => true });
  api.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: api.cancel })); api.destroy.mockResolvedValue(undefined); api.annotations.mockResolvedValue([]);
  api.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ getPage: async () => ({ getViewport: viewport, render: api.render, getAnnotations: api.annotations }) }), destroy: api.destroy }));
  props = { data: new Uint8Array([1, 2]), pageNumber: 1, links: [{ id: 'link', label: 'Website', pageNumber: 1, rect: { x: 10, y: 20, width: 120, height: 30 }, editable: true }], selectedId: 'link', placing: false, disabled: false, scale: 1, showAreas: true, onSelect: vi.fn(), onCreate: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(), onInteractionChange: vi.fn(), onReady: vi.fn(), onError: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<typeof props> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<PDFLinksPreview {...props} />)); }
function area() { return host.querySelector<HTMLButtonElement>('.pdf-links-area')!; }
function overlay() { return host.querySelector<HTMLElement>('.pdf-links-overlay')!; }
async function pointer(element: Element, type: string, x: number, y: number) { const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }); Object.defineProperty(event, 'pointerId', { value: 1 }); await act(async () => element.dispatchEvent(event)); }
describe('PDFLinksPreview', () => {
  it('renders native annotation appearances without any navigable link layer, and maps CropBox/UserUnit/native rotation', async () => {
    await render(); expect(host.querySelector('a')).toBeNull(); expect(api.getDocument.mock.calls[0][0].data).not.toBe(props.data); expect(api.render.mock.calls[0][0].annotationMode).toBeUndefined(); expect(props.onReady).toHaveBeenCalled();
    expect(area().style.left).toBe('550px'); expect(area().style.top).toBe('10px'); expect(area().style.width).toBe('30px'); expect(area().style.height).toBe('120px');
    const corner = host.querySelector<HTMLButtonElement>('.pdf-links-resize')!; expect(corner.style.left).toBe('543px'); expect(corner.style.top).toBe('123px');
  });
  it('keeps native borders visible with editing areas hidden and waits for annotations before becoming ready', async () => {
    let finish!: (annotations: unknown[]) => void; api.annotations.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render({ showAreas: false }); expect(props.onReady).not.toHaveBeenCalled(); expect(host.querySelector('.pdf-links-preview')?.getAttribute('aria-busy')).toBe('true'); expect(host.querySelector('.pdf-links-area')).toBeNull();
    await act(async () => finish([{ subtype: 'Link', rect: [55, 425, 115, 440], borderStyle: { width: 2, style: 5 }, borderColor: [10, 20, 30], id: 'native-underline' }]));
    expect(props.onReady).toHaveBeenCalledTimes(1); expect(host.querySelector('.pdf-links-preview')?.getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('.native-link-border-layer line')?.getAttribute('data-annotation-id')).toBe('native-underline'); expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('.native-link-border-layer g')?.getAttribute('transform')).toBe('matrix(0 2 2 0 -300 -100)');
  });
  it('also waits for the current canvas when borders finish first', async () => {
    let finish!: () => void; api.render.mockImplementationOnce(() => ({ promise: new Promise<void>(resolve => { finish = resolve; }), cancel: api.cancel }));
    await render(); expect(props.onReady).not.toHaveBeenCalled(); expect(host.querySelector('.pdf-links-preview')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => finish()); expect(props.onReady).toHaveBeenCalledTimes(1); expect(host.querySelector('.pdf-links-preview')?.getAttribute('aria-busy')).toBe('false');
  });
  it('ignores old annotation results and blocks readiness on a current border failure', async () => {
    let failOld!: (error: Error) => void; api.annotations.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
    await render(); expect(props.onReady).not.toHaveBeenCalled(); await render({ data: new Uint8Array([3]) }); expect(props.onReady).toHaveBeenCalledTimes(1);
    await act(async () => failOld(new Error('Old annotations failed'))); expect(props.onError).not.toHaveBeenCalled(); expect(props.onReady).toHaveBeenCalledTimes(1);
    api.annotations.mockRejectedValueOnce(new Error('Native border extraction failed')); await render({ data: new Uint8Array([4]) }); expect(props.onError).toHaveBeenCalledWith('Native border extraction failed'); expect(props.onReady).toHaveBeenCalledTimes(1); expect(host.querySelector('.pdf-links-preview')?.getAttribute('aria-busy')).toBe('true');
  });
  it('maps movement, resize and cancellation through the rotated viewport', async () => {
    await render(); await pointer(area(), 'pointerdown', 560, 20); await pointer(overlay(), 'pointermove', 570, 30); expect(props.onMove).toHaveBeenLastCalledWith('link', { x: 20, y: 10, width: 120, height: 30 });
    await pointer(overlay(), 'pointercancel', 570, 30); expect(props.onMove).toHaveBeenLastCalledWith('link', props.links[0].rect); expect(props.onInteractionChange).toHaveBeenLastCalledWith(false);
    await pointer(host.querySelector('.pdf-links-resize')!, 'pointerdown', 550, 130); await pointer(overlay(), 'pointerup', 530, 160); expect(props.onMove).toHaveBeenLastCalledWith('link', { x: 10, y: 20, width: 150, height: 50 });
  });
  it('creates by dragging and moves in screen directions with keyboard arrows', async () => {
    await render({ placing: true }); await pointer(overlay(), 'pointerdown', 500, 40); await pointer(overlay(), 'pointerup', 440, 180); expect(props.onCreate).toHaveBeenCalledWith({ x: 40, y: 100, width: 140, height: 60 });
    await render({ placing: false }); await act(async () => overlay().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }))); expect(props.onMove).toHaveBeenCalledWith('link', { x: 10, y: 10, width: 120, height: 30 });
    await act(async () => overlay().dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))); expect(props.onDelete).toHaveBeenCalledWith('link');
  });
  it('does not move readonly links, aborts stale rendering, and reports actual render failures', async () => {
    await render({ links: [{ ...props.links[0], editable: false }] }); await pointer(area(), 'pointerdown', 560, 20); expect(props.onSelect).toHaveBeenCalledWith('link'); expect(props.onMove).not.toHaveBeenCalled(); expect(host.querySelector('.pdf-links-resize')).toBeNull();
    api.render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Render failed')), cancel: api.cancel })); await render({ scale: 2 }); expect(props.onError).toHaveBeenCalledWith('Render failed'); expect(api.cancel).toHaveBeenCalled();
    await render({ data: new Uint8Array([3]) }); expect(api.destroy).toHaveBeenCalled();
  });
});
