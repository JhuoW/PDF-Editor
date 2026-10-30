// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInlineTextPreview } from '../../src/components/PDFViewer/useInlineTextPreview';
import type { InlineTextPreviewRequest, InlineTextPreviewResult } from '../../src/editing/InlineTextPreviewClient';
import type { PDFImage, TextBlock, TextEditOperation } from '../../src/editing/types';
import { useDocumentStore } from '../../src/store/documentStore';
import { useEditingStore } from '../../src/store/editingStore';
import { useFormStore } from '../../src/store/formStore';
import { useObjectTransformStore } from '../../src/store/objectTransformStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<InlineTextPreviewResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  reply(id: number, pixel: number) { this.onmessage?.({ data: { id, png: new Uint8Array([pixel]), bytes: new Uint8Array([pixel]) } } as MessageEvent<InlineTextPreviewResult>); }
  packet(index = -1): InlineTextPreviewRequest { return this.postMessage.mock.calls.at(index)![0]; }
}
const sheet = {} as PDFPageProxy;
const block: TextBlock = { id: 'text', pageNumber: 1, text: 'Existing words', editable: true, lines: [], rect: { x: 20, y: 30, width: 100, height: 20 }, style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
const image: PDFImage = { id: 'image', pageNumber: 1, objectName: 'Im1', rect: { x: 20, y: 100, width: 80, height: 50 }, originalRect: { x: 20, y: 100, width: 80, height: 50 }, source: { occurrence: 0, occurrenceCount: 1, transform: [1, 0, 0, 1, 0, 0], insideForm: false } };
const blocks = [block], noEdits: TextEditOperation[] = [];
const textEdit: TextEditOperation = { blockId: block.id, originalText: 'Original words', newText: 'Existing words', timestamp: 1 };
let root: Root, host: HTMLDivElement, source: Uint8Array;
function Probe({ edits = noEdits, page = sheet }: { edits?: TextEditOperation[]; page?: PDFPageProxy }) {
  const preview = useInlineTextPreview(page, 1, blocks, edits, null, 1, 0);
  return <output>{preview?.png?.[0] ?? 'none'}</output>;
}
async function render(edits = noEdits, page = sheet) { await act(async () => root.render(<Probe edits={edits} page={page} />)); }
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
function draftAt(x: number) {
  return { pageNumber: 1, imageEdit: { imageId: image.id, type: 'move' as const, newRect: { ...image.rect, x }, timestamp: x } };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', FakeWorker); FakeWorker.instances = [];
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useEditingStore.setState(useEditingStore.getInitialState(), true);
  useFormStore.setState(useFormStore.getInitialState(), true);
  source = new Uint8Array([1, 2, 3]);
  useDocumentStore.getState().setDocument({ getData: vi.fn(async () => source) } as unknown as PDFDocumentProxy);
  useEditingStore.getState().setImages(1, [image]);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useObjectTransformStore.getState().setDraft(null);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('composite native-object previews', () => {
  it('merges a temporary text layout and image transform with committed edits on the current page only', async () => {
    const replacement = new Uint8Array([4, 5]).buffer;
    useEditingStore.getState().setImages(2, [{ ...image, id: 'other-page', pageNumber: 2 }]);
    useEditingStore.getState().addImageEdit({ imageId: image.id, type: 'replace', newImageData: replacement, timestamp: 1 });
    useEditingStore.getState().addImageEdit({ imageId: 'other-page', type: 'delete', timestamp: 2 });
    const movedText = { ...textEdit, layout: { targetRect: { ...block.rect, x: 70 }, translate: true }, timestamp: 3 };
    useObjectTransformStore.getState().setDraft({ ...draftAt(90), textEdit: movedText });
    await render([textEdit]);
    const packet = FakeWorker.instances[0].packet();
    expect(packet.edits).toEqual([movedText]); expect(packet.images).toEqual([image]);
    expect(packet.imageEdits).toHaveLength(2); expect(packet.imageEdits?.map(edit => edit.type)).toEqual(['replace', 'move']);
    expect(packet.imageEdits?.[1].newRect?.x).toBe(90);
    expect(packet.data).not.toBe(source.buffer); expect(new Uint8Array(packet.data!)).toEqual(source);
    const clone = structuredClone(packet, { transfer: FakeWorker.instances[0].postMessage.mock.calls[0][1] });
    expect(clone.imageEdits?.[0].newImageData).not.toBe(replacement);
    expect(new Uint8Array(replacement)).toEqual(new Uint8Array([4, 5])); expect(source).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('produces a frame during a continuous drag and discards a late frame after cancellation', async () => {
    useObjectTransformStore.getState().setDraft(draftAt(30)); await render();
    const worker = FakeWorker.instances[0]; act(() => worker.reply(worker.packet().id, 1));
    await advance(35);
    if (worker.postMessage.mock.calls.length > 1) act(() => worker.reply(worker.packet().id, 1));
    act(() => useObjectTransformStore.getState().setDraft(draftAt(40))); await advance(20);
    act(() => useObjectTransformStore.getState().setDraft(draftAt(50))); await advance(20);
    expect(worker.packet().imageEdits?.[0].newRect?.x).toBe(50);
    expect(useEditingStore.getState().imageEdits).toEqual([]);
    const pending = worker.packet().id;
    act(() => useObjectTransformStore.getState().setDraft(null));
    expect(host.textContent).toBe('none'); expect(worker.terminate).toHaveBeenCalledTimes(1);
    act(() => worker.reply(pending, 9)); expect(host.textContent).toBe('none');
  });

  it('does not publish a draft frame after its committed edit context has changed', async () => {
    useEditingStore.getState().addImageEdit({ imageId: image.id, type: 'move', newRect: { ...image.rect, x: 30 }, timestamp: 1 });
    await render(); const worker = FakeWorker.instances[0]; act(() => worker.reply(worker.packet().id, 1));
    await advance(35); act(() => worker.reply(worker.packet().id, 1));
    act(() => useObjectTransformStore.getState().setDraft(draftAt(50))); await advance(35);
    const old = worker.packet().id;
    act(() => { useEditingStore.getState().addImageEdit({ imageId: image.id, type: 'move', newRect: { ...image.rect, x: 60 }, timestamp: 2 }); useObjectTransformStore.getState().setDraft(null); });
    act(() => worker.reply(old, 5)); expect(host.textContent).toBe('1');
    await advance(35); act(() => worker.reply(worker.packet().id, 6)); expect(host.textContent).toBe('6');
  });

  it('clears temporary geometry as soon as another document load starts', async () => {
    useObjectTransformStore.getState().setDraft(draftAt(90)); await render();
    const worker = FakeWorker.instances[0];
    act(() => useDocumentStore.getState().beginLoadRequest());
    expect(useObjectTransformStore.getState().draft).toBeNull(); expect(worker.terminate).toHaveBeenCalledTimes(1);
    act(() => worker.reply(worker.packet().id, 9)); expect(host.textContent).toBe('none');
  });
});
