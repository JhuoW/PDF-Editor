// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignatureDialog, type SignatureDialogProps } from '../../src/components/Dialogs/SignatureDialog';
import type { PendingImageData } from '../../src/components/Toolbar/CombinedToolbar';
const api = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), paint: vi.fn() }));
vi.mock('../../src/components/Dialogs/signatureImage', () => ({ readSignatureImage: api.read, createDrawnSignature: api.create, paintSignature: api.paint, SIGNATURE_PAD: { width: 800, height: 260 }, SIGNATURE_LIMITS: { strokes: 200, points: 20_000 } }));
let root: Root, host: HTMLDivElement, props: SignatureDialogProps;
const image: PendingImageData = { imageData: 'data:image/png;base64,c2ln', originalWidth: 200, originalHeight: 70, filename: 'signature.png', fileSize: 3, mimeType: 'image/png' };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ clearRect() {}, save() {}, scale() {}, restore() {} }) });
  for (const method of ['setPointerCapture', 'releasePointerCapture']) Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 260 } as DOMRect);
  api.create.mockReturnValue(image); api.read.mockResolvedValue(image);
  props = { documentKey: {}, revision: 1, onInsert: vi.fn(), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<SignatureDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<SignatureDialog {...props} />)); }
function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function pointer(type: string, x: number, y: number, id = 1, button = 0) { const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }); Object.defineProperty(event, 'pointerId', { value: id }); await act(async () => host.querySelector('canvas')!.dispatchEvent(event)); }
async function choose(name: string) { const input = host.querySelector<HTMLInputElement>('input[type=file]')!; const file = new File(['signature'], name, { type: 'image/png' }); Object.defineProperty(input, 'files', { configurable: true, value: [file] }); await act(async () => input.dispatchEvent(new Event('change', { bubbles: true }))); return file; }
async function stroke() { await pointer('pointerdown', 20, 30); await pointer('pointermove', 70, 40); await pointer('pointerup', 100, 35); }

describe('signature dialog', () => {
  it('draws pen strokes with undo and clear, then places only once through the image insertion contract', async () => {
    await render(); expect(button('Place signature').disabled).toBe(true);
    const color = host.querySelector('select')!; await act(async () => { color.value = '#174ea6'; color.dispatchEvent(new Event('change', { bubbles: true })); });
    await stroke(); expect(button('Place signature').disabled).toBe(false); expect(api.paint.mock.calls.at(-1)![1][0].color).toBe('#174ea6');
    await pointer('pointerdown', 30, 50); expect(button('Place signature').disabled).toBe(true); await pointer('pointerup', 30, 50);
    await click('Undo stroke'); expect(api.paint.mock.calls.at(-1)![1]).toHaveLength(1);
    await click('Clear'); expect(button('Place signature').disabled).toBe(true); await stroke();
    await act(async () => { button('Place signature').click(); button('Place signature').click(); });
    expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(image); expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0][0][0].points).toEqual([{ x: 20, y: 30 }, { x: 70, y: 40 }, { x: 100, y: 35 }]);
  });
  it('ignores right clicks and other pointers, discards canceled strokes, and keeps completed strokes', async () => {
    await render(); await pointer('pointerdown', 10, 10, 1, 2); expect(button('Undo stroke').disabled).toBe(true);
    await stroke(); await pointer('pointerdown', 10, 10, 1); await pointer('pointermove', 70, 70, 2); await pointer('pointerup', 70, 70, 2); expect(button('Place signature').disabled).toBe(true);
    await pointer('pointercancel', 20, 20, 1); expect(api.paint.mock.calls.at(-1)![1]).toHaveLength(1); expect(button('Place signature').disabled).toBe(false);
  });
  it('previews the chosen image and reprocesses background removal before allowing placement', async () => {
    await render(); await click('Upload image'); expect(button('Place signature').disabled).toBe(true);
    const file = await choose('ink.png'); expect(api.read).toHaveBeenCalledWith(file, false, expect.any(AbortSignal)); expect(host.querySelector('img')?.src).toBe(image.imageData);
    let finish!: (image: PendingImageData) => void; api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); expect(button('Place signature').disabled).toBe(true); expect(host.querySelector('img')).toBeNull();
    expect(api.read.mock.calls.at(-1)![1]).toBe(true); await act(async () => finish({ ...image, filename: 'transparent.png' }));
    await click('Place signature'); expect(props.onInsert).toHaveBeenCalledWith({ ...image, filename: 'transparent.png' });
  });
  it('rejects invalid uploads visibly and ignores an older read after choosing another image', async () => {
    await render(); await click('Upload image'); api.read.mockRejectedValueOnce(new Error('Only PNG or JPEG is supported.')); await choose('invalid.svg');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('Only PNG'); expect(button('Place signature').disabled).toBe(true);
    let finish!: (image: PendingImageData) => void; api.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await choose('old.png'); const oldSignal = api.read.mock.calls.at(-1)![2];
    await choose('new.png'); expect(oldSignal.aborted).toBe(true); await act(async () => finish({ ...image, imageData: 'data:image/png;base64,b2xk' }));
    expect(host.querySelector('img')?.src).toBe(image.imageData); expect(host.querySelector('[role=alert]')).toBeNull();
  });
  it('cancels upload on mode change, Escape and document revision without a placement', async () => {
    await render(); await click('Upload image'); api.read.mockImplementation(() => new Promise(() => {})); await choose('pending.png'); const signal = api.read.mock.calls.at(-1)![2];
    await click('Draw'); expect(signal.aborted).toBe(true); await stroke();
    await render({ revision: 2 }); expect(button('Place signature').disabled).toBe(true); expect(api.paint.mock.calls.at(-1)![1]).toHaveLength(0);
    await click('Upload image'); await choose('second.png'); const second = api.read.mock.calls.at(-1)![2];
    await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(second.aborted).toBe(true); expect(props.onClose).toHaveBeenCalledTimes(1); expect(props.onInsert).not.toHaveBeenCalled();
  });
  it('reports image creation failure and permits a corrected attempt without closing', async () => {
    await render(); await stroke(); api.create.mockImplementationOnce(() => { throw new Error('Canvas unavailable'); }); await click('Place signature');
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Canvas unavailable'); expect(props.onClose).not.toHaveBeenCalled();
    await click('Place signature'); expect(props.onInsert).toHaveBeenCalledTimes(1); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
