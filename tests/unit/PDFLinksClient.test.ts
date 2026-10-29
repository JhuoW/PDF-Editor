import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPDFLinksWorkspaceInWorker, inspectPDFLinksInWorker, preparePDFLinksWorkspaceInWorker, previewPDFLinksInWorker } from '../../src/core/PDFLinksClient';
import type { PDFLinkInspection, PDFLinkOperation } from '../../src/core/PDFLinkTypes';
import { createWorkspace } from '../../src/store/workspaceSnapshot';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const report: PDFLinkInspection = { revision: 'source-revision', canEdit: true, pages: [{ pageNumber: 1, width: 400, height: 600, rotation: 0 }], links: [] };
const operations: PDFLinkOperation[] = [{ type: 'create', definition: { pageNumber: 1, rect: { x: 10, y: 20, width: 100, height: 30 }, target: { type: 'page', pageNumber: 1, view: 'Fit' } } }];
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PDF links worker lifecycle', () => {
  it('inspects only an exact private byte range without detaching the source', async () => {
    const source = new Uint8Array([9, 1, 2, 8]), pending = inspectPDFLinksInWorker(source.subarray(1, 3));
    const worker = FakeWorker.instances[0], [packet, transfer] = worker.postMessage.mock.calls[0];
    expect(packet.job).toBe('inspect'); expect(new Uint8Array(packet.data)).toEqual(new Uint8Array([1, 2]));
    expect(transfer).toEqual([packet.data]); structuredClone(packet, { transfer });
    expect(source).toEqual(new Uint8Array([9, 1, 2, 8]));
    worker.send({ type: 'result', result: report }); await expect(pending).resolves.toBe(report);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.onmessage).toBeNull();
  });

  it.each(['prepare', 'preview', 'apply'] as const)('%s clones workspace image buffers and transfers only a private PDF', async job => {
    const workspace = createWorkspace(), imageData = new Uint8Array([3, 4]).buffer, source = new Uint8Array([1, 2]).buffer;
    workspace.editing.imageEdits.push({ type: 'replace', imageId: 'image', newImageData: imageData, timestamp: 1 });
    const control = { expectedRevision: report.revision };
    const pending = job === 'prepare' ? preparePDFLinksWorkspaceInWorker(source, workspace, control)
      : job === 'preview' ? previewPDFLinksInWorker(source, workspace, operations, control)
      : applyPDFLinksWorkspaceInWorker(source, workspace, operations, control);
    const worker = FakeWorker.instances[0], [packet, transfer] = worker.postMessage.mock.calls[0];
    const cloned = structuredClone(packet, { transfer });
    expect(packet).toMatchObject({ job, expectedRevision: report.revision });
    if (job !== 'prepare') expect(cloned.operations).toEqual(operations);
    expect(transfer).toHaveLength(1); expect(cloned.workspace).not.toBe(workspace);
    expect(cloned.workspace.editing.imageEdits[0].newImageData).not.toBe(imageData);
    expect(new Uint8Array(imageData)).toEqual(new Uint8Array([3, 4])); expect(new Uint8Array(source)).toEqual(new Uint8Array([1, 2]));
    const result = job === 'prepare' ? { data: new Uint8Array([7]).buffer, report }
      : job === 'preview' ? new Uint8Array([7]) : { data: new Uint8Array([7]), workspace: createWorkspace() };
    worker.send({ type: 'result', result }); await expect(pending).resolves.toBe(result);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('hard-cancels obsolete preparation while a new revision completes independently', async () => {
    const controller = new AbortController(), progress = vi.fn(), workspace = createWorkspace();
    const first = preparePDFLinksWorkspaceInWorker(new Uint8Array([1]), workspace, { signal: controller.signal, onProgress: progress });
    const oldWorker = FakeWorker.instances[0], late = oldWorker.onmessage!;
    const second = preparePDFLinksWorkspaceInWorker(new Uint8Array([2]), workspace), currentWorker = FakeWorker.instances[1];
    oldWorker.send({ type: 'progress', progress: { completed: 1, total: 2 } }); expect(progress).toHaveBeenCalledTimes(1);
    controller.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    late({ data: { type: 'progress', progress: { completed: 2, total: 2 } } } as MessageEvent);
    late({ data: { type: 'result', result: { data: new ArrayBuffer(1), report } } } as MessageEvent);
    expect(progress).toHaveBeenCalledTimes(1); expect(oldWorker.terminate).toHaveBeenCalledTimes(1); expect(currentWorker.terminate).not.toHaveBeenCalled();
    const result = { data: new ArrayBuffer(1), report: { ...report, revision: 'new' } };
    currentWorker.send({ type: 'result', result }); await expect(second).resolves.toBe(result);
  });

  it('removes listeners after success and ignores late results/errors/progress', async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener'), progress = vi.fn();
    const pending = inspectPDFLinksInWorker(new Uint8Array([1]), { signal: controller.signal, onProgress: progress });
    const worker = FakeWorker.instances[0], late = worker.onmessage!;
    worker.send({ type: 'result', result: report }); await pending;
    controller.abort(); late({ data: { type: 'error', message: 'late' } } as MessageEvent);
    late({ data: { type: 'progress', progress: { completed: 1, total: 1 } } } as MessageEvent);
    expect(progress).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull(); expect(worker.onmessageerror).toBeNull();
  });

  it('checks abort before allocation and again after listener installation', async () => {
    const before = new AbortController(); before.abort();
    await expect(inspectPDFLinksInWorker(new Uint8Array([1]), { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
    const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => { controller.abort(); add(...args); });
    await expect(inspectPDFLinksInWorker(new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalled(); expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'messageerror', 'unknown', 'wrong-result', 'bad-progress', 'core-error'] as const)('rejects and cleans %s', async kind => {
    const pending = inspectPDFLinksInWorker(new Uint8Array([1])), worker = FakeWorker.instances[0];
    if (kind === 'error') { const preventDefault = vi.fn(); worker.onerror!({ message: 'WASM failed', preventDefault } as unknown as ErrorEvent); expect(preventDefault).toHaveBeenCalled(); }
    else if (kind === 'messageerror') worker.onmessageerror!();
    else if (kind === 'wrong-result') worker.send({ type: 'result', result: new Uint8Array([1]) });
    else if (kind === 'bad-progress') worker.send({ type: 'progress', progress: { completed: 2, total: 1 } });
    else if (kind === 'core-error') worker.send({ type: 'error', message: 'The PDF revision changed.' });
    else worker.send({ type: 'unknown' });
    await expect(pending).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('releases the worker when a progress observer or structured cloning throws', async () => {
    const pending = inspectPDFLinksInWorker(new Uint8Array([1]), { onProgress: () => { throw new Error('Observer failed'); } });
    FakeWorker.instances[0].send({ type: 'progress', progress: { completed: 1, total: 2 } });
    await expect(pending).rejects.toThrow('Observer failed'); expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    vi.stubGlobal('Worker', class extends FakeWorker { postMessage = vi.fn(() => { throw new DOMException('Cannot clone workspace', 'DataCloneError'); }); });
    await expect(applyPDFLinksWorkspaceInWorker(new Uint8Array([1]), createWorkspace(), operations)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects empty or oversized input before allocating or copying', async () => {
    await expect(inspectPDFLinksInWorker(new ArrayBuffer(0))).rejects.toThrow('200 MB');
    await expect(inspectPDFLinksInWorker({ byteLength: 200 * 1024 * 1024 + 1 } as ArrayBuffer)).rejects.toThrow('200 MB');
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
