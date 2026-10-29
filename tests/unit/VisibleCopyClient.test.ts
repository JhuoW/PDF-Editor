import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisibleCopyInWorker, inspectVisibleCopyInWorker } from '../../src/core/VisibleCopyClient';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());
const settings = { dpi: 150 as const, compression: 'lossless' as const };

describe('visible-copy worker ownership and cancellation', () => {
  it('transfers only a private copy, includes the preview selection, and terminates on completion', async () => {
    const source = new Uint8Array([9, 1, 2, 8]), progress = vi.fn();
    const pending = createVisibleCopyInWorker(source.subarray(1, 3), settings, { previewPage: 3, onProgress: progress }), worker = FakeWorker.instances[0];
    const [packet, transfer] = worker.postMessage.mock.calls[0] as unknown as [{ data: ArrayBuffer; job: string; previewPage: number }, ArrayBuffer[]];
    expect(packet).toMatchObject({ job: 'create', previewPage: 3 }); expect(new Uint8Array(packet.data)).toEqual(new Uint8Array([1, 2])); expect(transfer).toEqual([packet.data]);
    structuredClone(packet.data, { transfer: [packet.data] }); expect(source).toEqual(new Uint8Array([9, 1, 2, 8]));
    const listener = worker.onmessage!; worker.send({ type: 'progress', progress: { phase: 'render', completed: 1, total: 1 } });
    const result = { data: new Uint8Array([7]), pageCount: 1 }; worker.send({ type: 'result', result }); await expect(pending).resolves.toBe(result);
    listener({ data: { type: 'progress', progress: {} } } as MessageEvent); expect(progress).toHaveBeenCalledTimes(1); expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });
  it('supports inspection without committing a PDF and aborts a long render immediately', async () => {
    const inspect = inspectVisibleCopyInWorker(new Uint8Array([1]), settings), inspector = FakeWorker.instances[0];
    expect(inspector.postMessage.mock.calls[0][0].job).toBe('inspect'); inspector.send({ type: 'result', result: { pageCount: 4 } }); await expect(inspect).resolves.toEqual({ pageCount: 4 });
    const controller = new AbortController(), progress = vi.fn(), pending = createVisibleCopyInWorker(new Uint8Array([1]), settings, { signal: controller.signal, onProgress: progress }), worker = FakeWorker.instances[1], late = worker.onmessage!;
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    late({ data: { type: 'result', result: {} } } as MessageEvent); late({ data: { type: 'progress', progress: {} } } as MessageEvent);
    expect(progress).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(createVisibleCopyInWorker(new Uint8Array([1]), settings, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(FakeWorker.instances).toHaveLength(2);
  });
  it.each(['error', 'messageerror', 'unknown', 'progress'] as const)('rejects and releases worker resources on %s failures', async kind => {
    const pending = createVisibleCopyInWorker(new Uint8Array([1]), settings, { onProgress: () => { throw new Error('Progress callback failed'); } }), worker = FakeWorker.instances[0];
    if (kind === 'error') { const preventDefault = vi.fn(); worker.onerror!({ message: 'WASM failed', preventDefault } as unknown as ErrorEvent); expect(preventDefault).toHaveBeenCalled(); }
    else if (kind === 'messageerror') worker.onmessageerror!();
    else worker.send({ type: kind, progress: {} });
    await expect(pending).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('handles abort while registering its listener without posting detached data', async () => {
    const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => { controller.abort(); add(...args); });
    await expect(createVisibleCopyInWorker(new Uint8Array([1]), settings, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalled(); expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
