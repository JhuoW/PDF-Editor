// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatePDFDialog, type CreatePDFDialogProps } from '../../src/components/Dialogs/CreatePDFDialog';
import type { PDFImageInput } from '../../src/core/ImagePDF';

const api = vi.hoisted(() => ({ validateImageCollection: vi.fn(), createPDFFromImages: vi.fn() }));
vi.mock('../../src/core/ImagePDF', async importOriginal => ({ ...await importOriginal<typeof import('../../src/core/ImagePDF')>(), ...api }));
let host: HTMLDivElement, root: Root, props: CreatePDFDialogProps;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  api.validateImageCollection.mockImplementation((images: PDFImageInput[]) => images.map(() => ({ format: 'png', width: 120, height: 80, orientation: 1 })));
  api.createPDFFromImages.mockResolvedValue(new Uint8Array([1, 2, 3]));
  props = { onCreate: vi.fn(async () => true), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(changes: Partial<CreatePDFDialogProps> = {}) {
  props = { ...props, ...changes }; await act(async () => root.render(<CreatePDFDialog {...props} />));
}
function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
function file(name = 'sample.png') {
  const image = new File(['image bytes'], name, { type: 'image/png' });
  Object.defineProperty(image, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) });
  return image;
}
async function selectFiles(files: File[]) {
  const input = host.querySelector<HTMLInputElement>('[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function fill(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function escape() {
  const event = new Event('cancel', { cancelable: true });
  await act(async () => host.querySelector('dialog')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}

describe('CreatePDFDialog', () => {
  it('opens a focused native modal and disables creation until images are selected', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    await render();
    expect(host.querySelector('dialog')?.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[type="file"]'));
    expect(button('Create PDF').disabled).toBe(true);
    await selectFiles([file()]);
    expect(button('Create PDF').disabled).toBe(false);
    expect(host.textContent).toContain('120 × 80 pixels');
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener); opener.remove();
  });

  it('checks file sizes before reading and keeps the prior selection when a new image is invalid', async () => {
    await render(); await selectFiles([file('keep.png')]);
    const oversized = file('huge.png'); Object.defineProperty(oversized, 'size', { value: 41 * 1024 * 1024 });
    await selectFiles([oversized]);
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('40 MB');
    api.validateImageCollection.mockImplementationOnce(() => { throw new Error('Invalid PNG'); });
    await selectFiles([file('valid.png'), file('broken.png')]);
    expect(host.querySelectorAll('li')).toHaveLength(1);
    expect(host.querySelector('li')?.textContent).toContain('keep.png');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid PNG');
  });

  it('creates pages in the chosen order with millimeters converted to PDF points and a PDF filename', async () => {
    await render(); await selectFiles([file('first.png'), file('second.jpg'), file('third.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Move image 2 earlier"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove image 3: third.png"]')!.click());
    await fill('Margin (mm)', '25.4'); await fill('PDF file name', '中文扫描');
    await submit();
    expect(api.createPDFFromImages.mock.calls[0][0].map((image: PDFImageInput) => image.name)).toEqual(['second.jpg', 'first.png']);
    expect(api.createPDFFromImages).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ pageSize: 'a4', orientation: 'portrait', margin: 72, signal: expect.any(AbortSignal) }));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: '中文扫描.pdf', type: 'application/pdf', size: 3 }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('validates options and keeps images available for retry when opening fails', async () => {
    await render({ onCreate: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    await selectFiles([file()]);
    await fill('Margin (mm)', '-1'); await submit();
    expect(api.createPDFFromImages).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('0 and 50.8 mm');
    await fill('Margin (mm)', '0'); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(host.querySelectorAll('li')).toHaveLength(1);
    await submit(); expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending file read without adding stale files or closing before cleanup', async () => {
    let finish!: (value: ArrayBuffer) => void;
    const pending = file(); Object.defineProperty(pending, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
    await render(); await selectFiles([pending]); await escape();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(button('Cancel').disabled).toBe(true);
    await act(async () => finish(new Uint8Array([1]).buffer));
    expect(api.validateImageCollection).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts conversion on cancel and never opens its eventual result', async () => {
    let finish!: (value: Uint8Array) => void;
    api.createPDFFromImages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render(); await selectFiles([file()]); await submit(); await submit();
    expect(api.createPDFFromImages).toHaveBeenCalledTimes(1);
    await click('Cancel');
    expect(api.createPDFFromImages.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finish(new Uint8Array([1])));
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables cancellation during atomic opening and ignores conversion after unmount', async () => {
    let opened!: (value: boolean) => void;
    await render({ onCreate: vi.fn(() => new Promise(resolve => { opened = resolve; })) });
    await selectFiles([file()]); await submit();
    expect(host.textContent).toContain('Opening the created PDF');
    await escape();
    expect(button('Cancel').disabled).toBe(true);
    expect(api.createPDFFromImages.mock.calls[0][1].signal.aborted).toBe(false);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => opened(false));
    let finish!: (value: Uint8Array) => void;
    api.createPDFFromImages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await submit();
    const count = vi.mocked(props.onCreate).mock.calls.length;
    await act(async () => root.render(null));
    expect(api.createPDFFromImages.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => finish(new Uint8Array([2])));
    expect(props.onCreate).toHaveBeenCalledTimes(count);
  });
});
