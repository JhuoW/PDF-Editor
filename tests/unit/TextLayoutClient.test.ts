import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareTextEditLayoutInWorker, previewTextEditInWorker } from '../../src/editing/TextLayoutClient';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import type { PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const block: TextBlock = { id: 'block', pageNumber: 1, text: 'Original', lines: [], rect: { x: 10, y: 20, width: 100, height: 30 },
  style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 }, editable: true };
const edit: TextEditOperation = { blockId: block.id, originalText: 'Original', newText: 'Changed', timestamp: 1, layout: { fontSize: 14 } };
const prepared: PreparedTextEditLayout = { input: { text: 'Changed', rect: block.rect, fontName: 'Helvetica', fontSize: 14, fontColor: '#000000', alignment: 'left', lineHeight: 1.2 },
  layout: { fits: true, requiredHeight: 14, lines: [], fontSize: 14, lineAdvance: 16.8, inkBounds: null, warnings: [] }, page: { width: 400, height: 600 } };
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('text layout worker lifecycle', () => {
  it('prepares a private exact byte range with the supplied block and layout without detaching the source', async () => {
    const source = new Uint8Array([9, 1, 2, 8]);
    const pending = prepareTextEditLayoutInWorker(source.subarray(1, 3), block, edit), worker = FakeWorker.instances[0];
    const [packet, transfer] = worker.postMessage.mock.calls[0];
    expect(packet).toMatchObject({ job: 'prepare', block, edit }); expect(new Uint8Array(packet.data)).toEqual(new Uint8Array([1, 2]));
    expect(transfer).toEqual([packet.data]); structuredClone(packet, { transfer });
    expect(source).toEqual(new Uint8Array([9, 1, 2, 8]));
    worker.send({ type: 'result', result: prepared }); await expect(pending).resolves.toBe(prepared);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.onmessage).toBeNull();
  });

  it('previews the full workspace and transfers no active image-edit or PDF history buffers', async () => {
    const workspace = createWorkspace(), imageData = new Uint8Array([3, 4]).buffer, source = new Uint8Array([1, 2]).buffer;
    workspace.editing.textBlocks.set(1, [block]); workspace.editing.imageEdits.push({ type: 'replace', imageId: 'image', newImageData: imageData, timestamp: 1 });
    const pending = previewTextEditInWorker(source, workspace, edit), worker = FakeWorker.instances[0];
    const [packet, transfer] = worker.postMessage.mock.calls[0], cloned = structuredClone(packet, { transfer });
    expect(packet.job).toBe('preview'); expect(transfer).toHaveLength(1); expect(cloned.workspace).not.toBe(workspace);
    expect(cloned.workspace.editing.imageEdits[0].newImageData).not.toBe(imageData);
    expect(new Uint8Array(imageData)).toEqual(new Uint8Array([3, 4])); expect(new Uint8Array(source)).toEqual(new Uint8Array([1, 2]));
    const output = new Uint8Array([7, 8]); worker.send({ type: 'result', result: output }); await expect(pending).resolves.toBe(output);
  });

  it('allows source measurement without an existing draft', async () => {
    const pending = prepareTextEditLayoutInWorker(new Uint8Array([1]), block), worker = FakeWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0].edit).toBeUndefined(); worker.send({ type: 'result', result: prepared });
    await expect(pending).resolves.toBe(prepared);
  });

  it('hard-cancels an obsolete revision while a newer independent preview still completes', async () => {
    const firstController = new AbortController(), workspace = createWorkspace();
    const first = previewTextEditInWorker(new Uint8Array([1]), workspace, edit, { signal: firstController.signal });
    const firstWorker = FakeWorker.instances[0], late = firstWorker.onmessage!;
    const second = previewTextEditInWorker(new Uint8Array([2]), workspace, edit), secondWorker = FakeWorker.instances[1];
    firstController.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    late({ data: { type: 'result', result: new Uint8Array([0]) } } as MessageEvent);
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1); expect(secondWorker.terminate).not.toHaveBeenCalled();
    const current = new Uint8Array([9]); secondWorker.send({ type: 'result', result: current }); await expect(second).resolves.toBe(current);
  });

  it('removes abort listeners and ignores all late messages after successful preparation', async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = prepareTextEditLayoutInWorker(new Uint8Array([1]), block, edit, { signal: controller.signal }), worker = FakeWorker.instances[0], late = worker.onmessage!;
    worker.send({ type: 'result', result: prepared }); await expect(pending).resolves.toBe(prepared);
    controller.abort(); late({ data: { type: 'error', message: 'Late error' } } as MessageEvent);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('checks abort both before allocation and after listener registration', async () => {
    const before = new AbortController(); before.abort();
    await expect(prepareTextEditLayoutInWorker(new Uint8Array([1]), block, undefined, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
    const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => { controller.abort(); add(...args); });
    await expect(previewTextEditInWorker(new Uint8Array([1]), createWorkspace(), edit, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalled(); expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror', 'unknown', 'wrong-result', 'core-error'] as const)('cleans up and rejects %s', async kind => {
    const pending = prepareTextEditLayoutInWorker(new Uint8Array([1]), block, edit), worker = FakeWorker.instances[0];
    if (kind === 'error') { const preventDefault = vi.fn(); worker.onerror!({ message: 'WASM could not load', preventDefault } as unknown as ErrorEvent); expect(preventDefault).toHaveBeenCalled(); }
    else if (kind === 'messageerror') worker.onmessageerror!();
    else if (kind === 'wrong-result') worker.send({ type: 'result', result: new Uint8Array([1]) });
    else if (kind === 'core-error') worker.send({ type: 'error', message: 'Signed PDFs cannot be edited.' });
    else worker.send({ type: 'progress' });
    await expect(pending).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.onmessage).toBeNull();
  });

  it('rejects oversized or empty data before copying or starting a worker', async () => {
    await expect(prepareTextEditLayoutInWorker(new ArrayBuffer(0), block)).rejects.toThrow('200 MB');
    await expect(previewTextEditInWorker({ byteLength: 200 * 1024 * 1024 + 1 } as ArrayBuffer, createWorkspace(), edit)).rejects.toThrow('200 MB');
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('releases resources when workspace cloning fails', async () => {
    vi.stubGlobal('Worker', class extends FakeWorker { postMessage = vi.fn(() => { throw new DOMException('Cannot clone workspace', 'DataCloneError'); }); });
    await expect(previewTextEditInWorker(new Uint8Array([1]), createWorkspace(), edit)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
