// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SplitDialog } from '../../src/components/Dialogs/SplitDialog';
import { splitPDF, downloadPDF } from '../../src/core/PDFManipulator';

vi.mock('../../src/core/PDFManipulator', () => ({ splitPDF: vi.fn(), downloadPDF: vi.fn() }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('keeps split settings and permits retry after PDF preparation is cancelled', async () => {
  const preparePDF = vi.fn().mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError')).mockResolvedValue(new Uint8Array([1]));
  const onClose = vi.fn();
  await act(async () => root.render(<SplitDialog totalPages={3} preparePDF={preparePDF} onClose={onClose} />));
  await act(async () => host.querySelector<HTMLButtonElement>('.split-submit')!.click());
  expect(host.querySelector('.split-error')).toBeNull();
  expect(splitPDF).not.toHaveBeenCalled(); expect(downloadPDF).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLButtonElement>('.split-submit')!.disabled).toBe(false);
  vi.mocked(splitPDF).mockResolvedValue([new Uint8Array([2])]);
  await act(async () => host.querySelector<HTMLButtonElement>('.split-submit')!.click());
  expect(downloadPDF).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});

it('bounds huge extraction ranges to real pages and rejects fractional or unsafe page numbers before exporting', async () => {
  const onClose = vi.fn();
  await act(async () => root.render(<SplitDialog totalPages={3} preparePDF={async () => new Uint8Array([1])} onClose={onClose} />));
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].click());
  const input = host.querySelector<HTMLInputElement>('.split-extract input')!;
  const submit = host.querySelector<HTMLButtonElement>('.split-submit')!;
  async function extract(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => submit.click());
  }
  for (const invalid of ['1.5', '1-2.5', '1-9007199254740992']) {
    await extract(invalid);
    expect(host.querySelector('.split-error')?.textContent).toContain('whole page numbers');
    expect(splitPDF).not.toHaveBeenCalled();
    expect(downloadPDF).not.toHaveBeenCalled();
  }
  vi.mocked(splitPDF).mockResolvedValue([new Uint8Array([2])]);
  await extract('2, 1-999999999999, 3');
  expect(splitPDF).toHaveBeenCalledWith(expect.any(ArrayBuffer), { mode: 'extract-pages', pages: [1, 2, 3] });
  expect(downloadPDF).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
