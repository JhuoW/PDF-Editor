import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineTextPreviewClient, type InlineTextPreviewRequest, type InlineTextPreviewResult } from '../../src/editing/InlineTextPreviewClient';

class PreviewWorker {
  static instances: PreviewWorker[] = [];
  onmessage: ((event: MessageEvent<InlineTextPreviewResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  packets: InlineTextPreviewRequest[] = [];
  postMessage = vi.fn((request: InlineTextPreviewRequest, transfer: Transferable[]) => {
    this.packets.push(structuredClone(request, { transfer }));
  });
  terminate = vi.fn();
  constructor() { PreviewWorker.instances.push(this); }
  reply(id: number) { this.onmessage?.({ data: { id } } as MessageEvent<InlineTextPreviewResult>); }
}
const request = (id: number, data?: ArrayBuffer): InlineTextPreviewRequest => ({
  id, data, pageNumber: 1, activeId: null, blocks: [], edits: [], scale: 1, rotation: 0,
});
beforeEach(() => { PreviewWorker.instances = []; vi.stubGlobal('Worker', PreviewWorker); });
afterEach(() => vi.unstubAllGlobals());

describe('inline preview source ownership and queued requests', () => {
  it('sends the PDF once and coalesces edits while the initial preview is still loading', () => {
    const result = vi.fn(), client = new InlineTextPreviewClient(result), worker = PreviewWorker.instances[0];
    const source = new Uint8Array([1, 2, 3]).buffer;
    client.request(request(1, source));
    client.request(request(2)); client.request(request(3));
    expect(worker.packets).toHaveLength(1);
    expect(new Uint8Array(worker.packets[0].data!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(source.byteLength).toBe(0);
    worker.reply(1);
    expect(worker.packets.map(packet => packet.id)).toEqual([1, 3]);
    expect(worker.packets[1].data).toBeUndefined();
    expect(result).toHaveBeenCalledExactlyOnceWith({ id: 1 });
    client.destroy();
  });

  it('retains a queued replacement source when later typing replaces its unsent request', () => {
    const client = new InlineTextPreviewClient(vi.fn()), worker = PreviewWorker.instances[0];
    client.request(request(1, new Uint8Array([1]).buffer));
    const replacement = new Uint8Array([9, 8]).buffer;
    client.request(request(2, replacement)); client.request(request(3));
    expect(replacement.byteLength).toBe(2);
    worker.reply(1);
    expect(worker.packets.map(packet => packet.id)).toEqual([1, 3]);
    expect(new Uint8Array(worker.packets[1].data!)).toEqual(new Uint8Array([9, 8]));
    expect(replacement.byteLength).toBe(0);
    client.destroy();
  });

  it('cancels pending work and ignores an initial result delivered after disposal', () => {
    const result = vi.fn(), client = new InlineTextPreviewClient(result), worker = PreviewWorker.instances[0];
    client.request(request(1, new Uint8Array([1]).buffer)); client.request(request(2));
    client.destroy(); worker.reply(1); client.request(request(3));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.packets.map(packet => packet.id)).toEqual([1]);
    expect(result).not.toHaveBeenCalled();
  });
});
