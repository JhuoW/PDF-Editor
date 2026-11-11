// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DecorationNumberInput } from '../../src/components/Dialogs/DecorationNumberInput';
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('formats PDF measurements without modifying untouched values on focus or blur', async () => {
  const change = vi.fn();
  await act(async () => root.render(<DecorationNumberInput label="Width" value={9.962599754} min={1} onChange={change} />));
  const input = host.querySelector('input')!;
  expect(input.value).toBe('9.963');
  await act(async () => { input.focus(); input.blur(); });
  expect(change).not.toHaveBeenCalled();
});
it('commits an intentional change and Escape restores the source without rounding it', async () => {
  const change = vi.fn();
  await act(async () => root.render(<DecorationNumberInput label="Width" value={9.962599754} min={1} onChange={change} />));
  const input = host.querySelector('input')!;
  const fill = async (value: string) => act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await fill('12.5'); await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(change).toHaveBeenCalledWith(12.5); change.mockClear();
  await fill('20'); await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(async () => input.blur());
  expect(input.value).toBe('9.963'); expect(change).not.toHaveBeenCalled();
});
