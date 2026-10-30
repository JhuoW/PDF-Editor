import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageCropStore } from '../../src/store/pageCropStore';
import { useDocumentStore } from '../../src/store/documentStore';

const margins = { top: 10, right: 20, bottom: 30, left: 40 }, rect = { x: .1, y: .1, width: .8, height: .8 };
beforeEach(() => {
  usePageCropStore.setState({ session: null, rect: null, busy: false, committing: false, error: null });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useDocumentStore.getState().setDocument({ numPages: 3 } as PDFDocumentProxy);
});
describe('visual page crop sessions', () => {
  it('preserves the selection on zoom and view rotation, and clears it when another PDF is requested', () => {
    usePageCropStore.getState().start({ pageNumber: 1, onApply: vi.fn() }); usePageCropStore.getState().setRect(rect);
    useDocumentStore.getState().setZoom(2); useDocumentStore.getState().setRotation(90);
    expect(usePageCropStore.getState().rect).toEqual(rect);
    useDocumentStore.getState().beginLoadRequest(); expect(usePageCropStore.getState().session).toBeNull(); expect(usePageCropStore.getState().rect).toBeNull();
  });
  it('blocks duplicate submissions and aborts canceled preparation without accepting a late result', async () => {
    let resolve!: () => void;
    const onApply = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    usePageCropStore.getState().start({ pageNumber: 1, onApply }); usePageCropStore.getState().setRect(rect);
    const pending = usePageCropStore.getState().apply(margins); await usePageCropStore.getState().apply(margins);
    expect(onApply).toHaveBeenCalledTimes(1);
    const signal = onApply.mock.calls[0][1] as AbortSignal;
    usePageCropStore.getState().cancel(); expect(signal.aborted).toBe(true);
    resolve(); await pending; expect(usePageCropStore.getState().session).toBeNull(); expect(usePageCropStore.getState().error).toBeNull();
  });
  it('keeps failed selections retryable and disables cancellation after the atomic commit starts', async () => {
    const onApply = vi.fn().mockRejectedValueOnce(new Error('Crop margins leave no visible area on page 1.')).mockImplementationOnce(async (_margins, _signal, commit) => {
      commit(); usePageCropStore.getState().cancel(); expect(usePageCropStore.getState().session).not.toBeNull();
      useDocumentStore.getState().beginLoadRequest();
    });
    usePageCropStore.getState().start({ pageNumber: 1, onApply }); usePageCropStore.getState().setRect(rect);
    await usePageCropStore.getState().apply(margins);
    expect(usePageCropStore.getState().error).toContain('no visible area'); expect(usePageCropStore.getState().rect).toEqual(rect); expect(usePageCropStore.getState().busy).toBe(false);
    await usePageCropStore.getState().apply(margins); expect(usePageCropStore.getState().session).toBeNull();
  });
  it('opens page range and margin options even before drawing a selection', () => {
    const onOptions = vi.fn(); usePageCropStore.getState().start({ pageNumber: 1, onApply: vi.fn(), onOptions });
    usePageCropStore.getState().options(); expect(onOptions).toHaveBeenCalledWith(undefined); expect(usePageCropStore.getState().session).toBeNull();
  });
});
