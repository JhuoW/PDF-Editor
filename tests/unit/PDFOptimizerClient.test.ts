import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPDFOptimizationInWorker, optimizePDFInWorker } from '../../src/core/PDFOptimizerClient';
import { DEFAULT_OPTIMIZER_SETTINGS, PDF_OPTIMIZER_LIMITS, type OptimizerInspection, type OptimizerResult } from '../../src/core/PDFOptimizerTypes';

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

const inspection: OptimizerInspection = {
  inputBytes: 100, pageCount: 2, imageCount: 1, eligibleImageCount: 1, canOptimize: true, warnings: [],
};
const result: OptimizerResult = {
  data: new Uint8Array([7]), inputBytes: 100, outputBytes: 1, pageCount: 2,
  imagesOptimized: 1, imagesSkipped: 0, imagesDeduplicated: 0, warnings: [], changed: true, candidateBytes: 1,
};

beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PDF optimizer worker ownership and lifecycle', () => {
  it('transfers only a private exact byte range, then releases the worker and ignores late callbacks', async () => {
    const source = new Uint8Array([9, 1, 2, 8]), onProgress = vi.fn(), controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const settings = { mode: 'images' as const, dpi: 200 as const, quality: 75 };
    const pending = optimizePDFInWorker(source.subarray(1, 3), settings, { signal: controller.signal, onProgress });
    const worker = FakeWorker.instances[0], late = worker.onmessage!;
    const [packet, transfer] = worker.postMessage.mock.calls[0] as unknown as [{ data: ArrayBuffer; job: string; settings: unknown }, ArrayBuffer[]];
    expect(packet).toMatchObject({ job: 'optimize', settings });
    expect(new Uint8Array(packet.data)).toEqual(new Uint8Array([1, 2]));
    expect(transfer).toEqual([packet.data]);
    structuredClone(packet.data, { transfer: [packet.data] });
    expect(source).toEqual(new Uint8Array([9, 1, 2, 8]));
    worker.send({ type: 'progress', progress: { phase: 'images', completed: 1, total: 2 } });
    worker.send({ type: 'result', result });
    await expect(pending).resolves.toBe(result);
    late({ data: { type: 'progress', progress: { phase: 'verify', completed: 2, total: 2 } } } as MessageEvent);
    late({ data: { type: 'error', message: 'Too late' } } as MessageEvent);
    controller.abort();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('inspects in a separate worker and copies ArrayBuffer input without detaching it', async () => {
    const source = new Uint8Array([1, 2]).buffer;
    const pending = inspectPDFOptimizationInWorker(source), worker = FakeWorker.instances[0];
    const packet = worker.postMessage.mock.calls[0][0];
    expect(packet.job).toBe('inspect'); expect(packet.settings).toBeUndefined();
    expect(packet.data).not.toBe(source);
    structuredClone(packet.data, { transfer: [packet.data] });
    expect(new Uint8Array(source)).toEqual(new Uint8Array([1, 2]));
    worker.send({ type: 'result', result: inspection });
    await expect(pending).resolves.toBe(inspection);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('uses the default lossless settings and returns unchanged candidates without rewriting the result', async () => {
    const pending = optimizePDFInWorker(new Uint8Array([1])), worker = FakeWorker.instances[0];
    expect(worker.postMessage.mock.calls[0][0].settings).toEqual(DEFAULT_OPTIMIZER_SETTINGS);
    const unchanged = { ...result, changed: false, candidateBytes: 150, outputBytes: 100 };
    worker.send({ type: 'result', result: unchanged });
    await expect(pending).resolves.toBe(unchanged);
  });

  it('terminates immediately on abort and cannot deliver late output or progress', async () => {
    const controller = new AbortController(), onProgress = vi.fn();
    const pending = optimizePDFInWorker(new Uint8Array([1]), undefined, { signal: controller.signal, onProgress });
    const worker = FakeWorker.instances[0], late = worker.onmessage!;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    late({ data: { type: 'result', result } } as MessageEvent);
    late({ data: { type: 'progress', progress: { phase: 'save', completed: 1, total: 1 } } } as MessageEvent);
    expect(onProgress).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(inspectPDFOptimizationInWorker(new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('rechecks abort after listener registration, before posting any document data', async () => {
    const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => { controller.abort(); add(...args); });
    await expect(inspectPDFOptimizationInWorker(new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels only its own worker when two independent requests overlap', async () => {
    const controller = new AbortController();
    const first = optimizePDFInWorker(new Uint8Array([1]), undefined, { signal: controller.signal });
    const second = inspectPDFOptimizationInWorker(new Uint8Array([2]));
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[1].terminate).not.toHaveBeenCalled();
    FakeWorker.instances[1].send({ type: 'result', result: inspection });
    await expect(second).resolves.toBe(inspection);
  });

  it.each(['error', 'messageerror', 'unknown', 'bad-progress', 'bad-result', 'core-error', 'callback'] as const)(
    'rejects and releases worker resources on %s failures', async kind => {
      const pending = optimizePDFInWorker(new Uint8Array([1]), undefined, { onProgress: () => { throw new Error('Progress handler failed'); } });
      const worker = FakeWorker.instances[0];
      if (kind === 'error') {
        const preventDefault = vi.fn(); worker.onerror!({ message: 'WASM failed', preventDefault } as unknown as ErrorEvent);
        expect(preventDefault).toHaveBeenCalled();
      } else if (kind === 'messageerror') worker.onmessageerror!();
      else if (kind === 'core-error') worker.send({ type: 'error', message: 'Signed PDFs cannot be compressed.' });
      else if (kind === 'callback') worker.send({ type: 'progress', progress: { phase: 'inspect', completed: 0, total: 1 } });
      else if (kind === 'bad-progress') worker.send({ type: 'progress', progress: { phase: 'images', completed: Number.NaN, total: 1 } });
      else if (kind === 'bad-result') worker.send({ type: 'result', result: inspection });
      else worker.send({ type: 'unexpected' });
      await expect(pending).rejects.toThrow();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
    },
  );

  it('rejects invalid input before allocating a worker', async () => {
    await expect(inspectPDFOptimizationInWorker(new Uint8Array())).rejects.toThrow('200 MB');
    // Exercise the boundary without allocating an oversized document in this lifecycle test.
    const oversized = { byteLength: PDF_OPTIMIZER_LIMITS.inputBytes + 1 } as ArrayBuffer;
    await expect(optimizePDFInWorker(oversized)).rejects.toThrow('200 MB');
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('releases the worker if posting its private data fails', async () => {
    vi.stubGlobal('Worker', class extends FakeWorker { postMessage = vi.fn(() => { throw new DOMException('Cannot clone settings', 'DataCloneError'); }); });
    await expect(optimizePDFInWorker(new Uint8Array([1]))).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0].onmessage).toBeNull();
  });
});
