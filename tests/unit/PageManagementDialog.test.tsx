// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PageManagementDialog, { type PageManagementAction } from '../../src/components/Dialogs/PageManagementDialog';
import { useLocaleStore } from '../../src/i18n';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  useLocaleStore.getState().setLocale('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); useLocaleStore.getState().setLocale('en'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(action: PageManagementAction, onRun = vi.fn().mockResolvedValue(undefined), selectedPages: number[] = [], onClose = vi.fn()) {
  await act(async () => { root.render(<PageManagementDialog action={action} totalPages={3} currentPage={1} selectedPages={selectedPages} onRun={onRun} onClose={onClose} />); });
  return { onRun, onClose };
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function input(label: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectSource(data: Uint8Array) {
  const file = new File([new Uint8Array(data)], 'replacement.pdf', { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => data.slice().buffer });
  await act(async () => {
    const element = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(element, 'files', { configurable: true, value: [file] });
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PageManagementDialog', () => {
  it('duplicates the selected pages in their requested order after the current page', async () => {
    const { onRun, onClose } = await render('duplicate', undefined, [3, 1]);
    expect(host.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('input[aria-label="Page range"]'));
    await submit();
    expect(onRun).toHaveBeenCalledWith({ action: 'duplicate', pages: [3, 1], beforePage: 2 }, expect.any(AbortSignal), expect.any(Function));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects empty or invalid page selections without running an operation and preserves the draft on language switch', async () => {
    const { onRun } = await render('extract');
    await input('Page range', ''); await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Enter at least one page');
    await input('Page range', '4'); await submit();
    expect(onRun).not.toHaveBeenCalled();
    await act(async () => { useLocaleStore.getState().setLocale('zh-CN'); });
    expect(host.querySelector('h2')!.textContent).toBe('提取页面');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="页面范围"]')!.value).toBe('4');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('1和3');
    await input('页面范围', '３，１'); await submit();
    expect(onRun).toHaveBeenCalledWith({ action: 'extract', pages: [3, 1] }, expect.any(AbortSignal), expect.any(Function));
  });

  it('converts crop margins from millimeters to PDF points and exposes restore without accepting a no-op crop', async () => {
    const { onRun } = await render('crop');
    await submit(); expect(onRun).not.toHaveBeenCalled();
    await input('Top margin (mm)', '25.4'); await input('Right margin (mm)', '12.7');
    await submit();
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ action: 'crop', pages: [1], margins: { top: 72, right: 36, bottom: 0, left: 0 }, resetCrop: false }), expect.any(AbortSignal), expect.any(Function));
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await submit();
    expect(onRun).toHaveBeenLastCalledWith({ action: 'crop', pages: [1], resetCrop: true }, expect.any(AbortSignal), expect.any(Function));
  });

  it('reads a real replacement PDF, rejects unequal counts, and preserves each selected order', async () => {
    const { onRun } = await render('replace');
    await submit(); expect(onRun).not.toHaveBeenCalled();
    expect(host.querySelector('input[aria-label="Page range"]')!.hasAttribute('aria-invalid')).toBe(false);
    const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
    await selectSource(await pdf.save());
    await input('Replacement page range', '2, 1'); await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('same number');
    expect(onRun).not.toHaveBeenCalled();
    await input('Page range', '3, 1'); await submit();
    expect(onRun).toHaveBeenCalledWith({ action: 'replace', pages: [3, 1], source: { data: expect.any(ArrayBuffer), pages: [2, 1] } }, expect.any(AbortSignal), expect.any(Function));
  });

  it('uses localized replacement file controls while retaining an accessible input for file selection', async () => {
    await render('replace');
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!, open = vi.spyOn(fileInput, 'click');
    expect(fileInput.hidden).toBe(true);
    await act(async () => { useLocaleStore.getState().setLocale('zh-CN'); });
    expect(host.textContent).toContain('尚未选择 PDF');
    const choose = [...host.querySelectorAll('button')].find(button => button.textContent === '选择替换 PDF')!;
    await act(async () => { choose.click(); });
    expect(open).toHaveBeenCalledOnce();
    expect(fileInput.getAttribute('aria-label')).toBe('替换来源 PDF');
    expect(host.textContent).not.toContain('Choose File');
  });

  it('rejects an encrypted replacement without invoking document changes', async () => {
    const { onRun } = await render('replace');
    vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(new Error('Input document is encrypted'));
    await selectSource(new Uint8Array([1]));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Unlock the replacement PDF');
    await submit(); expect(onRun).not.toHaveBeenCalled();
  });

  it.each([false, true])('allows cancellation before commit and locks it during commit (%s)', async commit => {
    let finish!: () => void;
    const onRun = vi.fn((_request, _signal, onCommit) => {
      if (commit) onCommit();
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const { onClose } = await render('duplicate', onRun);
    await submit(); await submit();
    expect(onRun).toHaveBeenCalledOnce();
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    const signal = onRun.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(!commit);
    expect(onClose).toHaveBeenCalledTimes(commit ? 0 : 1);
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Close page management dialog"]')!.disabled).toBe(commit);
    await act(async () => { finish(); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
