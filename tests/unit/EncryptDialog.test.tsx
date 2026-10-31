// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncryptDialog } from '../../src/components/Dialogs/EncryptDialog';
import { encryptPDF } from '../../src/core/PDFEncryption';
import { downloadPDF } from '../../src/core/PDFManipulator';

vi.mock('../../src/core/PDFEncryption', () => ({
  ALL_PDF_PERMISSIONS: { print: true, copy: true, edit: true, annotate: true, form: true, accessibility: true, assemble: true, printHighQuality: true },
  encryptPDF: vi.fn(async () => new Uint8Array([9]).buffer),
}));
vi.mock('../../src/core/PDFManipulator', () => ({ downloadPDF: vi.fn(async () => {}) }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function passwords() { await fill('Password to open', 'open-pass'); await fill('Confirm opening password', 'open-pass'); }
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

describe('EncryptDialog', () => {
  it('encrypts the exact prepared byte view and defaults an unrestricted owner password', async () => {
    const preparePDF = vi.fn(async () => ({ data: new Uint8Array([1, 7, 8, 2]).subarray(1, 3), fileName: 'Example.PDF' }));
    const onClose = vi.fn();
    await act(async () => { root.render(<EncryptDialog preparePDF={preparePDF} onClose={onClose} />); });
    await passwords();
    await submit();
    expect(new Uint8Array(vi.mocked(encryptPDF).mock.calls[0][0])).toEqual(new Uint8Array([7, 8]));
    expect(vi.mocked(encryptPDF).mock.calls[0][1]).toMatchObject({ userPassword: 'open-pass', ownerPassword: 'open-pass' });
    expect(downloadPDF).toHaveBeenCalledWith(new Uint8Array([9]), 'Example-encrypted.pdf');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('shows preparation errors and allows a retry without downloading incomplete data', async () => {
    const preparePDF = vi.fn().mockRejectedValueOnce(new Error('Document changed during export')).mockResolvedValue({ data: new Uint8Array([1]), fileName: 'retry.pdf' });
    await act(async () => { root.render(<EncryptDialog preparePDF={preparePDF} onClose={vi.fn()} />); });
    await passwords();
    await submit();
    expect(host.querySelector('[role="alert"] .diagnostic-summary')?.textContent).toBe('Document changed during export');
    expect(encryptPDF).not.toHaveBeenCalled();
    expect(downloadPDF).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit();
    expect(downloadPDF).toHaveBeenCalledTimes(1);
  });
  it('returns to encryption settings after cancelling PDF preparation without showing an error', async () => {
    const preparePDF = vi.fn().mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError')).mockResolvedValue({ data: new Uint8Array([1]), fileName: 'retry.pdf' });
    await act(async () => { root.render(<EncryptDialog preparePDF={preparePDF} onClose={vi.fn()} />); });
    await passwords(); await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(encryptPDF).not.toHaveBeenCalled(); expect(downloadPDF).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit(); expect(downloadPDF).toHaveBeenCalledOnce();
  });
  it('blocks duplicate submits and Escape while busy, and abandons an externally unmounted export', async () => {
    let resolve!: (value: { data: Uint8Array; fileName: string }) => void;
    const preparePDF = vi.fn(() => new Promise<{ data: Uint8Array; fileName: string }>(done => { resolve = done; }));
    const onClose = vi.fn();
    await act(async () => { root.render(<EncryptDialog preparePDF={preparePDF} onClose={onClose} />); });
    await passwords();
    await submit();
    await submit();
    expect(preparePDF).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const cancellation = new Event('cancel', { cancelable: true });
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(cancellation); });
    expect(cancellation.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { root.render(null); });
    await act(async () => { resolve({ data: new Uint8Array([1]), fileName: 'old-document.pdf' }); });
    expect(encryptPDF).not.toHaveBeenCalled();
    expect(downloadPDF).not.toHaveBeenCalled();
  });
});
