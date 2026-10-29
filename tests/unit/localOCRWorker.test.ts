// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOCRWorker } from '../../src/ocr/localOCRWorker';

interface Packet { workerId: string; jobId: string; action: string; payload: Record<string, unknown> }
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly url: URL;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Packet[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((packet: Packet) => { this.messages.push(packet); });
  constructor(url: URL) { this.url = url; FakeWorker.instances.push(this); }
  reply(status: 'resolve' | 'reject' | 'progress', data: unknown = {}, packet = this.messages.at(-1)!) {
    this.onmessage?.({ data: { workerId: packet.workerId, jobId: packet.jobId, action: packet.action, status, data } });
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

async function completeInitialization(native: FakeWorker, promise: Promise<void>) {
  for (const action of ['load', 'loadLanguage', 'initialize', 'setParameters']) {
    expect(native.messages.at(-1)?.action).toBe(action);
    native.reply('resolve');
    await Promise.resolve();
  }
  await promise;
}

describe('local OCR worker adapter', () => {
  it('uses only bundled same-origin resources and requests position blocks with automatic rotation disabled', async () => {
    const progress = vi.fn();
    const worker = new LocalOCRWorker(undefined, progress);
    const native = FakeWorker.instances[0];
    expect(native.url.href).toBe(new URL('/ocr/worker.min.js', document.baseURI).href);
    const initialized = worker.initialize('chi_sim+eng');
    native.reply('progress', { status: 'loading tesseract core', progress: 0.4 });
    expect(progress).toHaveBeenCalledWith({ status: 'loading tesseract core', progress: 0.4 });
    await completeInitialization(native, initialized);
    expect(native.messages[0].payload).toEqual({ options: { lstmOnly: true, logging: false, corePath: new URL('/ocr/core/', document.baseURI).href } });
    expect(native.messages[1].payload).toMatchObject({ langs: 'chi_sim+eng', options: { langPath: new URL('/ocr/lang/', document.baseURI).href, cachePath: 'pdf-editor-tesseract-6.0.1-model-1.0.0-best-int', gzip: true } });
    const png = new Uint8Array([1, 2, 3]);
    const pending = worker.recognize(png);
    expect(native.messages.at(-1)?.payload).toMatchObject({ image: png, options: { rotateAuto: false, rotateRadians: 0 }, output: { text: true, blocks: true } });
    const recognized = { text: 'LOCAL', blocks: [] };
    native.reply('resolve', recognized);
    await expect(pending).resolves.toEqual(recognized);
    worker.terminate(); worker.terminate();
    expect(native.terminate).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2, 3])('terminates immediately on abort during initialization stage %i', async stage => {
    const controller = new AbortController();
    const worker = new LocalOCRWorker(controller.signal);
    const native = FakeWorker.instances[0];
    const initialization = worker.initialize('eng');
    const rejected = expect(initialization).rejects.toMatchObject({ name: 'AbortError' });
    for (let index = 0; index < stage; index++) { native.reply('resolve'); await Promise.resolve(); }
    controller.abort();
    await rejected;
    expect(native.terminate).toHaveBeenCalledOnce();
    expect(native.onmessage).toBeNull();
    expect(native.onerror).toBeNull();
    expect(native.onmessageerror).toBeNull();
    await expect(worker.recognize(new Uint8Array())).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('terminates immediately on abort during recognition and ignores late results', async () => {
    const controller = new AbortController();
    const worker = new LocalOCRWorker(controller.signal);
    const native = FakeWorker.instances[0];
    await completeInitialization(native, worker.initialize('eng'));
    const pending = worker.recognize(new Uint8Array());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    native.reply('resolve', { text: 'LATE' });
    await rejected;
    expect(native.terminate).toHaveBeenCalledOnce();
  });

  it.each(['load', 'loadLanguage', 'initialize', 'setParameters'])('settles failed %s initialization without orphaning the worker', async action => {
    const worker = new LocalOCRWorker();
    const native = FakeWorker.instances[0];
    const pending = worker.initialize('eng');
    const rejected = expect(pending).rejects.toThrow('Missing local resource');
    while (native.messages.at(-1)?.action !== action) { native.reply('resolve'); await Promise.resolve(); }
    native.reply('reject', 'Missing local resource');
    await rejected;
    expect(native.terminate).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror', 'invalid-message', 'wrong-job', 'invalid-progress'])('rejects and cleans up on %s', async kind => {
    const worker = new LocalOCRWorker();
    const native = FakeWorker.instances[0];
    const pending = worker.initialize('eng');
    const rejected = expect(pending).rejects.toThrow();
    if (kind === 'error') native.onerror?.({ message: 'Network failed', preventDefault() {} });
    if (kind === 'messageerror') native.onmessageerror?.();
    if (kind === 'invalid-message') native.onmessage?.({ data: null });
    if (kind === 'wrong-job') native.reply('resolve', {}, { ...native.messages[0], jobId: 'unknown' });
    if (kind === 'invalid-progress') native.reply('progress', { status: 'Loading', progress: NaN });
    await rejected;
    expect(native.terminate).toHaveBeenCalledOnce();
  });

  it('does not leak a worker when a progress callback or postMessage fails', async () => {
    const worker = new LocalOCRWorker(undefined, () => { throw new Error('Callback failed'); });
    const native = FakeWorker.instances[0];
    const initialization = worker.initialize('eng');
    const rejected = expect(initialization).rejects.toThrow('report OCR progress');
    native.reply('progress', { status: 'Loading', progress: 0 });
    await rejected;
    expect(native.terminate).toHaveBeenCalledOnce();
    const another = new LocalOCRWorker();
    const otherNative = FakeWorker.instances[1];
    otherNative.postMessage.mockImplementation(() => { throw new Error('Clone failed'); });
    await expect(another.initialize('eng')).rejects.toThrow('send the page');
    expect(otherNative.terminate).toHaveBeenCalledOnce();
  });

  it('does not create a worker for an already aborted signal', () => {
    const controller = new AbortController(); controller.abort();
    expect(() => new LocalOCRWorker(controller.signal)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
