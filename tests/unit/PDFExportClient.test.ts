import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exportWorkspacePDFInWorker, inspectWorkspaceTextInWorker } from '../../src/core/PDFExportClient';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { TextCheckError } from '../../src/editing/TextCheckTypes';

class WorkerDouble {
  static instances: WorkerDouble[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { WorkerDouble.instances.push(this); }
  send(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
beforeEach(() => { WorkerDouble.instances = []; vi.stubGlobal('Worker', WorkerDouble); });
afterEach(() => vi.unstubAllGlobals());

it('transfers a private PDF and reports progress, preserving source and workspace ownership', async () => {
  const data = new Uint8Array([1, 2, 3]).buffer, workspace = createWorkspace(), onProgress = vi.fn();
  const pending = exportWorkspacePDFInWorker(data, workspace, { onProgress }), worker = WorkerDouble.instances[0];
  const [request, transfers] = worker.postMessage.mock.calls[0];
  expect(request.data).not.toBe(data); expect(transfers).toEqual([request.data]);
  expect(data.byteLength).toBe(3); expect(workspace.editing.textEdits).toEqual([]);
  worker.send({ type: 'progress', progress: { stage: 'text', progress: .55 } });
  expect(onProgress).toHaveBeenCalledWith({ stage: 'text', progress: .55 });
  worker.send({ type: 'result', result: new Uint8Array([4]) });
  expect(await pending).toEqual(new Uint8Array([4])); expect(worker.terminate).toHaveBeenCalledOnce();
});
it('terminates immediately on cancel and ignores a late result', async () => {
  const controller = new AbortController();
  const pending = exportWorkspacePDFInWorker(new ArrayBuffer(1), createWorkspace(), { signal: controller.signal });
  const worker = WorkerDouble.instances[0], late = worker.onmessage!;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  late({ data: { type: 'result', result: new Uint8Array([4]) } } as MessageEvent);
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(worker.onmessage).toBeNull();
});
it('does not start a cancelled export', async () => {
  await expect(exportWorkspacePDFInWorker(new ArrayBuffer(1), createWorkspace(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(WorkerDouble.instances).toHaveLength(0);
});
it('preserves every page and region in validation errors', async () => {
  const pending = exportWorkspacePDFInWorker(new ArrayBuffer(1), createWorkspace());
  const issues = [1, 2].map(pageNumber => ({ pageNumber, blockId: `b${pageNumber}`, kind: 'overflow', blocking: true, message: 'Text does not fit.' }));
  WorkerDouble.instances[0].send({ type: 'error', issues, message: 'failed' });
  await expect(pending).rejects.toBeInstanceOf(TextCheckError);
  await expect(pending).rejects.toMatchObject({ issues });
});
it('accepts a text check report without serializing PDF content', async () => {
  const pending = inspectWorkspaceTextInWorker(new ArrayBuffer(1), createWorkspace());
  WorkerDouble.instances[0].send({ type: 'result', result: { checked: 3, issues: [] } });
  await expect(pending).resolves.toEqual({ checked: 3, issues: [] });
});
it.each(['error', 'messageerror', 'bad-result'])('cleans up after %s', async kind => {
  const pending = exportWorkspacePDFInWorker(new ArrayBuffer(1), createWorkspace()), worker = WorkerDouble.instances[0];
  if (kind === 'error') worker.onerror!({ message: 'Missing WASM', preventDefault() {} } as ErrorEvent);
  else if (kind === 'messageerror') worker.onmessageerror!();
  else worker.send({ type: 'result', result: 'broken PDF' });
  await expect(pending).rejects.toThrow(); expect(worker.terminate).toHaveBeenCalledOnce();
});
