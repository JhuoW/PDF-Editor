import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPagesInWorker } from '../../src/core/PageExportClient';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const settings = { format: 'png' as const, range: '1', dpi: 150 as const, quality: 90, fileName: 'source.pdf' };
const result = { data: new Uint8Array([7]), fileName: 'source-page-1.png', mimeType: 'image/png', pages: [1] };
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());

describe('page export worker lifecycle', () => {
  it('transfers an exact private byte view and terminates after a successful result', async () => {
    const original = new Uint8Array([9, 1, 2, 8]), onProgress = vi.fn();
    const pending = exportPagesInWorker(original.subarray(1, 3), settings, { onProgress });
    const worker = FakeWorker.instances[0];
    const [packet, transfer] = worker.postMessage.mock.calls[0] as unknown as [{ data: ArrayBuffer }, ArrayBuffer[]];
    expect(new Uint8Array(packet.data)).toEqual(new Uint8Array([1, 2]));
    expect(packet.data).not.toBe(original.buffer); expect(transfer).toEqual([packet.data]);
    // Simulate the real ownership transfer to demonstrate the source stays usable.
    structuredClone(packet.data, { transfer: [packet.data] });
    expect(original).toEqual(new Uint8Array([9, 1, 2, 8]));
    const listener = worker.onmessage!;
    worker.send({ type: 'progress', progress: { completed: 0, total: 1, phase: 'pages' } });
    worker.send({ type: 'result', result });
    await expect(pending).resolves.toBe(result);
    listener({ data: { type: 'progress', progress: { completed: 1, total: 1, phase: 'pages' } } } as MessageEvent);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('terminates on abort and ignores queued result/progress events', async () => {
    const controller = new AbortController(), onProgress = vi.fn();
    const pending = exportPagesInWorker(new Uint8Array([1]), settings, { signal: controller.signal, onProgress });
    const worker = FakeWorker.instances[0], listener = worker.onmessage!;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    listener({ data: { type: 'progress', progress: { completed: 1, total: 1, phase: 'pages' } } } as MessageEvent);
    listener({ data: { type: 'result', result } } as MessageEvent);
    expect(onProgress).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(exportPagesInWorker(new Uint8Array([1]), settings, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it.each(['error', 'messageerror', 'unexpected'] as const)('rejects and releases the worker on %s', async type => {
    const pending = exportPagesInWorker(new Uint8Array([1]), settings), worker = FakeWorker.instances[0];
    if (type === 'error') {
      const preventDefault = vi.fn();
      worker.onerror!({ message: 'Failed to load WASM', preventDefault } as unknown as ErrorEvent);
      expect(preventDefault).toHaveBeenCalledTimes(1);
    } else if (type === 'messageerror') worker.onmessageerror!();
    else worker.send({ type: 'unknown' });
    await expect(pending).rejects.toThrow(type === 'error' ? 'WASM' : type === 'messageerror' ? 'unreadable' : 'unexpected');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('handles an abort that happens while the listener is being registered', async () => {
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => { controller.abort(); add(...args); });
    await expect(exportPagesInWorker(new Uint8Array([1]), settings, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
