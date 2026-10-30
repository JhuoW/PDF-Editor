// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PageCropLayer } from '../../src/components/PDFViewer/PageCropLayer';
import { usePageCropStore } from '../../src/store/pageCropStore';
import { useDocumentStore } from '../../src/store/documentStore';
import { useLocaleStore } from '../../src/i18n';

const selection = { x: .1, y: .1, width: .8, height: .8 };
const page = { pageNumber: 1, rotate: 0, getViewport: () => ({ width: 200, height: 100,
  convertToPdfPoint: (x: number, y: number) => [x, y], convertToViewportPoint: (x: number, y: number) => [x, y] }) } as unknown as PDFPageProxy;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useLocaleStore.getState().setLocale('en');
  usePageCropStore.setState({ session: null, rect: null, busy: false, committing: false, error: null });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true); useDocumentStore.getState().setDocument({ numPages: 1 } as PDFDocumentProxy);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); usePageCropStore.getState().cancel(); vi.unstubAllGlobals(); });
async function render(onApply: ReturnType<typeof vi.fn>) {
  usePageCropStore.getState().start({ pageNumber: 1, onApply }); usePageCropStore.getState().setRect(selection);
  await act(async () => { root.render(<PageCropLayer page={page} pageNumber={1} scale={1} rotation={0} />); });
}

describe('visual crop keyboard controls', () => {
  it('leaves Enter and arrow keys to focused zoom/page inputs and selects', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined); await render(onApply);
    for (const tag of ['input', 'select', 'textarea']) {
      const control = document.createElement(tag); document.body.append(control); control.focus();
      await act(async () => {
        control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      expect(onApply).not.toHaveBeenCalled(); expect(usePageCropStore.getState().rect).toEqual(selection); control.remove();
    }
  });
  it('applies the drawn page area with Enter while the overlay owns focus', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined); await render(onApply);
    const overlay = host.querySelector<HTMLElement>('.page-crop-layer')!; expect(document.activeElement).toBe(overlay);
    await act(async () => { overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(onApply).toHaveBeenCalledOnce();
    const margins = onApply.mock.calls[0][0];
    expect(margins.top).toBeCloseTo(10); expect(margins.right).toBeCloseTo(20); expect(margins.bottom).toBeCloseTo(10); expect(margins.left).toBeCloseTo(20);
    expect(usePageCropStore.getState().session).toBeNull();
  });
});
