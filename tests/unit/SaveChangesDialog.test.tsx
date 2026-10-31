// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SaveChangesDialog from '../../src/components/Dialogs/SaveChangesDialog';
import { useLocaleStore } from '../../src/i18n';

let host: HTMLDivElement, root: Root;
type Props = ComponentProps<typeof SaveChangesDialog>;
beforeEach(() => {
  useLocaleStore.getState().setLocale('en'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useLocaleStore.getState().setLocale('en'); vi.unstubAllGlobals(); });
async function render(overrides: Partial<Props> = {}) {
  const props = { fileName: 'Original English.pdf', onSave: vi.fn().mockResolvedValue(undefined), onDiscard: vi.fn(), onCancel: vi.fn(), ...overrides };
  await act(async () => root.render(<SaveChangesDialog {...props} />));
  return props;
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function cancel() { await act(async () => { host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); }); }

describe('SaveChangesDialog', () => {
  it('opens a native modal and switches language while preserving the user filename and decision', async () => {
    const { onSave, onCancel, onDiscard } = await render({ purpose: 'open' });
    expect(host.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('button[type="submit"]'));
    expect(host.textContent).toContain('before opening another PDF');
    await act(async () => useLocaleStore.getState().setLocale('zh-CN'));
    expect(host.querySelector('h2')!.textContent).toBe('保存更改？'); expect(host.textContent).toContain('Original English.pdf');
    expect([...host.querySelectorAll('footer button')].map(button => button.textContent)).toEqual(['取消', '不保存', '保存']);
    await cancel(); await cancel();
    expect(onCancel).toHaveBeenCalledOnce(); expect(onSave).not.toHaveBeenCalled(); expect(onDiscard).not.toHaveBeenCalled();
  });

  it('locks the decision while saving and blocks duplicate submissions or cancelling an active write', async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { onDiscard, onCancel } = await render({ onSave });
    await submit(); await submit(); await cancel();
    expect(onSave).toHaveBeenCalledOnce(); expect(onCancel).not.toHaveBeenCalled();
    expect([...host.querySelectorAll<HTMLButtonElement>('footer button')].every(button => button.disabled)).toBe(true);
    await act(async () => { finish(); });
    expect(host.querySelector('dialog')!.open).toBe(false); expect(onDiscard).not.toHaveBeenCalled();
  });

  it('keeps the prompt open when the save picker is cancelled, then allows a successful retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new DOMException('Picker cancelled', 'AbortError')).mockResolvedValue(undefined);
    await render({ onSave }); await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector('dialog')!.open).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit(); expect(onSave).toHaveBeenCalledTimes(2); expect(host.querySelector('dialog')!.open).toBe(false);
  });

  it('localizes a write error and preserves the open document until the user chooses another decision', async () => {
    const { onDiscard, onCancel } = await render({ onSave: vi.fn().mockRejectedValue(new Error('Could not save the PDF.')) });
    await submit();
    await act(async () => useLocaleStore.getState().setLocale('zh-CN'));
    expect(host.querySelector('[role="alert"] .diagnostic-summary')!.textContent).toBe('无法保存 PDF。');
    expect(host.querySelector('dialog')!.open).toBe(true);
    await act(async () => host.querySelectorAll<HTMLButtonElement>('footer button')[1].click());
    await submit();
    expect(onDiscard).toHaveBeenCalledOnce(); expect(onCancel).not.toHaveBeenCalled();
  });

  it('blocks every decision when its parent reports an existing save and handles Ctrl+S once otherwise', async () => {
    const props = await render({ busy: true });
    await submit(); await cancel(); expect(props.onSave).not.toHaveBeenCalled(); expect(props.onCancel).not.toHaveBeenCalled();
    await act(async () => root.render(<SaveChangesDialog {...props} busy={false} />));
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(props.onSave).toHaveBeenCalledOnce();
  });
});
