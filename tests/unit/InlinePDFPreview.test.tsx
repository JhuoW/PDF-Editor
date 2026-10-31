// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlinePDFPreview } from '../../src/components/PDFViewer/InlinePDFPreview';
import { pdfjsLib } from '../../src/utils/pdfConfig';
import { useSearchStore } from '../../src/store/searchStore';

vi.mock('../../src/utils/pdfConfig', () => ({ pdfDocumentOptions: {}, pdfjsLib: { getDocument: vi.fn() } }));
let root: Root, host: HTMLElement;
const png = new Uint8Array([1]), firstBytes = new Uint8Array([2]), nextBytes = new Uint8Array([3]);
function ownedDocument(text: string, pending = false) {
  let disposed = false, resolve!: (value: { getPage: typeof getPage }) => void;
  const getTextContent = vi.fn(() => {
    if (disposed) throw new TypeError("Cannot read properties of null (reading 'sendWithStream')");
    return Promise.resolve({ items: [{ str: text, transform: [12, 0, 0, 12, 20, 80], width: 60, height: 12 }] });
  });
  const page = { pageNumber: 1, rotate: 0, getViewport: () => ({ width: 300, height: 200 }), getTextContent };
  const getPage = vi.fn().mockResolvedValue(page), pdf = { getPage };
  const promise = pending ? new Promise<typeof pdf>(done => { resolve = done; }) : Promise.resolve(pdf);
  return { task: { promise, destroy: vi.fn(async () => { disposed = true; }) }, finish: () => resolve(pdf), getTextContent, getPage };
}
async function render(editing: boolean, bytes = firstBytes) {
  await act(async () => root.render(<InlinePDFPreview png={png} bytes={bytes} pageNumber={1} scale={1} rotation={0} editing={editing} />));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:preview'); static revokeObjectURL = vi.fn(); });
  useSearchStore.getState().clearSearch();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains a usable selection document when typing starts and finishes before the next preview arrives', async () => {
  const original = ownedDocument('中文编辑'), delayed = ownedDocument('中文编辑', true);
  vi.mocked(pdfjsLib.getDocument).mockReturnValueOnce(original.task as never).mockReturnValue(delayed.task as never);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await render(false); expect(host.querySelector('.textLayer')?.textContent).toBe('中文编辑');
  await render(true); expect(host.querySelector('.textLayer')).toBeNull();
  await render(false);
  expect(host.querySelector('.textLayer')?.textContent).toBe('中文编辑');
  expect(errors).not.toHaveBeenCalled();
  expect(original.task.destroy).not.toHaveBeenCalled();
});
it('replaces preview bytes without exposing an old disposed page or a late loading result', async () => {
  const old = ownedDocument('旧文字', true), next = ownedDocument('当前文字');
  vi.mocked(pdfjsLib.getDocument).mockReturnValueOnce(old.task as never).mockReturnValueOnce(next.task as never);
  await render(false); await render(false, nextBytes);
  expect(old.task.destroy).toHaveBeenCalledOnce(); expect(host.querySelector('.textLayer')?.textContent).toBe('当前文字');
  await act(async () => old.finish()); expect(host.querySelector('.textLayer')?.textContent).toBe('当前文字'); expect(old.getPage).not.toHaveBeenCalled();
  await act(async () => root.unmount()); expect(next.task.destroy).toHaveBeenCalledOnce();
  root = createRoot(host);
});

it('does not revive an old disposed page when preview bytes change and then return to an earlier buffer', async () => {
  const old = ownedDocument('之前的文字'), intermediate = ownedDocument('中间文字', true), current = ownedDocument('当前文字', true);
  vi.mocked(pdfjsLib.getDocument).mockReturnValueOnce(old.task as never).mockReturnValueOnce(intermediate.task as never).mockReturnValueOnce(current.task as never);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await render(false); await render(false, nextBytes); await render(false, firstBytes);
  expect(host.querySelector('.textLayer')).toBeNull();
  await act(async () => current.finish()); expect(host.querySelector('.textLayer')?.textContent).toBe('当前文字');
  await act(async () => intermediate.finish()); expect(host.querySelector('.textLayer')?.textContent).toBe('当前文字');
  expect(errors).not.toHaveBeenCalled();
});
