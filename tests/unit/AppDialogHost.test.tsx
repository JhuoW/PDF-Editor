// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDialogHost, AppNotice } from '../../src/components/Dialogs/AppDialogHost';
import { appAlert, appConfirm, appPrompt, showAppNotice, useAppDialogStore } from '../../src/store/appDialogStore';

let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  }
  useAppDialogStore.setState({ queue: [], notice: null });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<><AppDialogHost /><AppNotice /></>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.confirmation-dialog-footer button')];
const click = async (element: HTMLElement) => act(async () => element.click());

describe('in-app dialogs', () => {
  it('resolves confirmations and shows queued requests one at a time', async () => {
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = appConfirm({ title: 'Delete pages', message: 'Delete page 2?', confirmLabel: 'Delete', danger: true }); second = appConfirm({ message: 'Second?' }); });
    expect(host.textContent).toContain('Delete page 2?'); expect(host.textContent).not.toContain('Second?');
    expect(buttons().map(button => button.textContent)).toEqual(['Cancel', 'Delete']);
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(buttons()[1]); await expect(first).resolves.toBe(true);
    expect(host.textContent).toContain('Second?');
    await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
    await expect(second).resolves.toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
  });

  it('shows alerts with one button and keeps multi-line messages', async () => {
    let done!: Promise<void>;
    await act(async () => { done = appAlert('Line one\n\nLine two'); });
    expect(buttons().map(button => button.textContent)).toEqual(['OK']);
    expect(host.querySelector('.confirmation-dialog-title')?.textContent).toBe('Notice');
    expect(host.querySelector('.confirmation-dialog-message')?.textContent).toBe('Line one\n\nLine two');
    await click(buttons()[0]); await expect(done).resolves.toBeUndefined();
  });

  it('prompts for a non-empty value and returns null when cancelled', async () => {
    let named!: Promise<string | null>;
    await act(async () => { named = appPrompt({ title: 'Save as', message: 'Save PDF as', defaultValue: 'report.pdf', confirmLabel: 'Save' }); });
    const input = host.querySelector<HTMLInputElement>('.confirmation-dialog-input')!;
    expect(input.value).toBe('report.pdf'); expect(document.activeElement).toBe(input);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(buttons()[1]); expect(host.querySelector('[role="alert"]')?.textContent).toBe('Enter a value to continue.');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' renamed '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await expect(named).resolves.toBe('renamed');
    let cancelled!: Promise<string | null>;
    await act(async () => { cancelled = appPrompt({ message: 'Name' }); });
    await click(buttons()[0]); await expect(cancelled).resolves.toBeNull();
  });

  it('shows a status notice that clears itself', async () => {
    vi.useFakeTimers();
    await act(async () => showAppNotice('Imported 3 field values'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Imported 3 field values');
    await act(async () => vi.advanceTimersByTime(6000));
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
