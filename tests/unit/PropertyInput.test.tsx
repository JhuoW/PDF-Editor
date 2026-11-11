// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PropertyNumberInput, PropertyColorInput } from '../../src/components/Workspace/PropertyInput';

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const input = () => host.querySelector('input')!;
async function type(value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
}
async function key(key: string) { await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))); }
async function blur() { await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); }

it('rejects invalid dimensions without applying a partial numeric edit or changing history', async () => {
  const commit = vi.fn(); await act(async () => root.render(<PropertyNumberInput value={100} min={10} onCommit={commit} aria-label="Width" />));
  await type('-10'); expect(input().getAttribute('aria-invalid')).toBe('true'); expect(commit).not.toHaveBeenCalled();
  await blur(); expect(input().value).toBe('100'); expect(commit).not.toHaveBeenCalled();
  await type(''); await key('Enter'); expect(input().value).toBe('100'); expect(commit).not.toHaveBeenCalled();
});
it('keeps full PDF precision unless the user actually edits the displayed value', async () => {
  const commit = vi.fn(); const source = Number('411.00239999999994');
  await act(async () => root.render(<PropertyNumberInput value={source} onCommit={commit} />));
  expect(input().value).toBe('411.0024'); await blur(); await key('Enter'); expect(commit).not.toHaveBeenCalled();
  await type('420.125'); await key('Enter'); expect(commit).toHaveBeenCalledExactlyOnceWith(420.125); await blur(); expect(commit).toHaveBeenCalledTimes(1);
});
it('cancels an uncommitted draft with Escape and resets it on external undo', async () => {
  const commit = vi.fn(); await act(async () => root.render(<PropertyNumberInput value={12} min={1} onCommit={commit} />));
  await type('22'); await key('Escape'); await blur(); expect(input().value).toBe('12'); expect(commit).not.toHaveBeenCalled();
  await type('44'); await act(async () => root.render(<PropertyNumberInput value={18} min={1} onCommit={commit} />));
  await blur(); expect(input().value).toBe('18'); expect(commit).not.toHaveBeenCalled();
});
it('validates color text before it can enter rendering or export', async () => {
  const commit = vi.fn(); await act(async () => root.render(<PropertyColorInput value="#123456" onCommit={commit} allowTransparent />));
  await type('#ff'); await blur(); expect(input().value).toBe('#123456'); expect(commit).not.toHaveBeenCalled();
  await type('transparent'); await key('Enter'); expect(commit).toHaveBeenCalledExactlyOnceWith('transparent');
});
