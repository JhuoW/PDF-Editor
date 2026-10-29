// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoToPageDialog } from '../../src/components/Dialogs/GoToPageDialog';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('rejects empty, fractional and out-of-range page numbers without truncating and accepts a valid page', async () => {
  const navigate = vi.fn(), close = vi.fn();
  await act(async () => root.render(<GoToPageDialog currentPage={1} totalPages={3} onGoToPage={navigate} onClose={close} />));
  const input = host.querySelector('input')!;
  for (const value of ['', '1.5', '0', '4', '2']) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    if (value !== '2') {
      expect(navigate).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      expect(host.querySelector('[role=alert]')).not.toBeNull();
    }
  }
  expect(navigate).toHaveBeenCalledExactlyOnceWith(2); expect(close).toHaveBeenCalledOnce();
});
