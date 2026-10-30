// @vitest-environment jsdom
import { useLocaleStore } from '../../src/i18n';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OCRDialog, type OCRDialogProps } from '../../src/components/Dialogs/OCRDialog';
import type { OCRPageResult } from '../../src/ocr/recognizePDF';

let host: HTMLDivElement, root: Root, props: OCRDialogProps;
const recognized: OCRPageResult = { pageNumber: 1, status: 'recognized', wordCount: 5, text: 'Recognized sample text', confidence: 98 };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  props = { documentKey: 'first', totalPages: 8, currentPage: 4, onClose: vi.fn(), onRun: vi.fn(async () => [recognized]) };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { useLocaleStore.getState().setLocale('en'); localStorage.clear(); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(changes: Partial<OCRDialogProps> = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<OCRDialog {...props} />));
}
function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function submit() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function fill(value: string) {
  const input = host.querySelector<HTMLInputElement>('#ocr-pages')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function escape() {
  const event = new Event('cancel', { cancelable: true });
  await act(async () => host.querySelector('dialog')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}

describe('OCRDialog', () => {
  it('translates live OCR worker stages while keeping the recognition job and options intact', async () => {
    let finish!: (value: OCRPageResult[]) => void;
    await render({ onRun: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    await submit();
    const [, signal, report] = vi.mocked(props.onRun).mock.calls[0];
    for (const status of ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api', 'recognizing text']) {
      await act(async () => report({ phase: 'recognizing', pageNumber: 2, completedPages: 1, totalPages: 8, progress: .25, status }));
      expect(host.querySelector('.ocr-progress [role="status"]')?.textContent).toContain(status);
      await act(async () => useLocaleStore.getState().setLocale('zh-CN'));
      expect(host.querySelector('.ocr-progress [role="status"]')?.textContent).not.toContain(status);
      expect(host.querySelector('.ocr-progress [role="status"]')?.textContent).toMatch(/[\u3400-\u9fff]/);
      await act(async () => useLocaleStore.getState().setLocale('en'));
      expect(host.querySelector('.ocr-progress [role="status"]')?.textContent).toContain(status);
    }
    expect(signal.aborted).toBe(false); expect(props.onRun).toHaveBeenCalledTimes(1);
    await act(async () => finish([recognized]));
  });

  it('opens a focused native modal, defaults to all pages and skipping text, and restores focus', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    await render();
    expect(host.querySelector('dialog')?.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('#ocr-pages'));
    expect(host.querySelector<HTMLInputElement>('#ocr-pages')?.value).toBe('1-8');
    expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
    await click('Current page');
    expect(host.querySelector<HTMLInputElement>('#ocr-pages')?.value).toBe('4');
    await click('All pages');
    expect(host.querySelector<HTMLInputElement>('#ocr-pages')?.value).toBe('1-8');
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener); opener.remove();
  });

  it.each(['', '0', '9', '3-1', '1,,2', '2.5'])('rejects invalid page range %j before starting work', async value => {
    await render(); await fill(value); await submit();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter pages from 1 to 8');
    expect(document.activeElement).toBe(host.querySelector('#ocr-pages'));
  });

  it('normalizes page ranges, passes language and skip choice, and presents per-page results', async () => {
    await render({ onRun: vi.fn(async () => [recognized, { ...recognized, pageNumber: 3, status: 'skipped-existing-text', wordCount: 0 }, { ...recognized, pageNumber: 4, status: 'no-text', wordCount: 0 }]) });
    await fill('4, 1, 3-4');
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('#ocr-language')!;
      select.value = 'chi_sim+eng'; select.dispatchEvent(new Event('change', { bubbles: true }));
      host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
    });
    expect(host.textContent).toContain('can add duplicate text');
    await submit();
    expect(props.onRun).toHaveBeenCalledWith({ pages: [1, 3, 4], language: 'chi_sim+eng', skipExistingText: false }, expect.any(AbortSignal), expect.any(Function));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(host.textContent).toContain('Searchable text added to 1 page');
    expect(host.textContent).toContain('Skipped: existing text');
    expect(host.textContent).toContain('No text detected');
  });

  it('cancels recognition, prevents duplicate starts and waits for worker cleanup', async () => {
    let reject!: (error: Error) => void;
    await render({ onRun: vi.fn(() => new Promise((_, fail) => { reject = fail; })) });
    await submit(); await submit();
    expect(props.onRun).toHaveBeenCalledTimes(1);
    const [, signal, report] = vi.mocked(props.onRun).mock.calls[0];
    await act(async () => report({ phase: 'recognizing', pageNumber: 2, completedPages: 1, totalPages: 8, progress: .25, status: 'Recognizing text' }));
    expect(host.querySelector('progress')?.value).toBe(.25);
    expect(host.textContent).toContain('Page 2 (1/8 completed)');
    await click('Cancel OCR');
    expect(signal.aborted).toBe(true);
    expect(button('Cancel OCR').disabled).toBe(true);
    expect(button('Start OCR').disabled).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => reject(new DOMException('Stopped', 'AbortError')));
    expect(host.textContent).toContain('OCR canceled. The document was not changed.');
    expect(button('Start OCR').disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('Escape aborts running work and closes only after the operation settles', async () => {
    let finish!: (value: OCRPageResult[]) => void;
    await render({ onRun: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    await submit(); await escape();
    expect(vi.mocked(props.onRun).mock.calls[0][1].aborted).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish([]));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not offer cancellation once the atomic document commit starts', async () => {
    let finish!: (value: OCRPageResult[]) => void;
    await render({ onRun: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    await submit();
    const [, signal, report] = vi.mocked(props.onRun).mock.calls[0];
    await act(async () => report({ phase: 'committing', pageNumber: null, completedPages: 8, totalPages: 8, progress: 1, status: 'Saving' }));
    await escape(); await click('Cancel OCR');
    expect(signal.aborted).toBe(false);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Close OCR"]')?.disabled).toBe(true);
    await act(async () => finish([recognized]));
    expect(host.textContent).toContain('Searchable text added');
    await click('Close'); expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts on a document change and ignores the old result', async () => {
    let finish!: (value: OCRPageResult[]) => void;
    await render({ onRun: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    await submit();
    const signal = vi.mocked(props.onRun).mock.calls[0][1];
    await render({ documentKey: 'replacement', currentPage: 1, totalPages: 2 });
    expect(signal.aborted).toBe(true);
    await act(async () => finish([recognized]));
    expect(host.querySelector<HTMLInputElement>('#ocr-pages')?.value).toBe('1-2');
    expect(host.querySelector('tbody')).toBeNull();
    expect(button('Start OCR').disabled).toBe(false);
  });

  it('shows recognition errors and allows retry without clearing the options', async () => {
    await render({ onRun: vi.fn().mockRejectedValueOnce(new Error('Language data unavailable')).mockResolvedValueOnce([]) });
    await fill('2-3'); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Language data unavailable');
    expect(host.querySelector<HTMLInputElement>('#ocr-pages')?.value).toBe('2-3');
    await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('No text was added. The document was not changed.');
  });
});
