// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPagesDialog } from '../../src/components/Dialogs/ExportPagesDialog';
import { downloadPageExport, exportPagesInWorker } from '../../src/core/PageExportClient';
import { useLocaleStore } from '../../src/i18n';

vi.mock('../../src/core/PageExportClient', () => ({ downloadPageExport: vi.fn(), exportPagesInWorker: vi.fn() }));
const source = { data: new Uint8Array([1, 2]), fileName: 'source.pdf' };
const result = { data: new Uint8Array([9]), fileName: 'source-page-1.png', mimeType: 'image/png', pages: [1] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  useLocaleStore.getState().setLocale('en');
  vi.clearAllMocks(); vi.mocked(exportPagesInWorker).mockResolvedValue(result);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); useLocaleStore.getState().setLocale('en'); vi.unstubAllGlobals(); });
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function choose(scope: string) { await act(async () => { host.querySelector<HTMLInputElement>(`input[value="${scope}"]`)!.click(); }); }
async function enterRange(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-describedby]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ExportPagesDialog', () => {
  it('closes once and rejects late submissions even if the parent has not unmounted it yet', async () => {
    const readPDF = vi.fn().mockResolvedValue(source), onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={readPDF} onClose={onClose} />); });
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    await submit();
    await act(async () => { host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(host.querySelector('dialog')!.open).toBe(false);
    expect(readPDF).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
  });

  it('clears an obsolete render-limit error when resolution changes and retries with the corrected settings', async () => {
    vi.mocked(exportPagesInWorker).mockRejectedValueOnce(new Error('Page 1 exceeds the 40 megapixel export limit at 300 dpi. Choose 150 dpi or a smaller page.'));
    await act(async () => { root.render(<ExportPagesDialog readPDF={async () => source} onClose={vi.fn()} />); });
    const resolution = host.querySelector<HTMLSelectElement>('select[aria-label="Resolution"]')!;
    await act(async () => { resolution.value = '300'; resolution.dispatchEvent(new Event('change', { bubbles: true })); });
    await submit(); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => { resolution.value = '150'; resolution.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await submit();
    expect(exportPagesInWorker).toHaveBeenLastCalledWith(source.data, expect.objectContaining({ dpi: 150 }), expect.anything());
    expect(downloadPageExport).toHaveBeenCalledOnce();
  });

  it.each([
    ['all', '', '8 of 8'], ['current', '4', '1 of 8'], ['selection', '2,7', '2 of 8'],
  ])('converts %s pages from document navigation without exposing text formats', async (scope, range, count) => {
    await act(async () => { root.render(<ExportPagesDialog imagesOnly totalPages={8} currentPage={4} selectedPages={[7, 2, 7, 99]} readPDF={async () => source} onClose={vi.fn()} />); });
    expect(host.querySelector('h2')!.textContent).toBe('PDF to images');
    expect([...host.querySelectorAll('select[aria-label="Export format"] option')].map(option => (option as HTMLOptionElement).value)).toEqual(['png', 'jpeg']);
    await choose(scope);
    expect(host.querySelector('[role="status"]')!.textContent).toContain(count);
    await submit();
    expect(exportPagesInWorker).toHaveBeenCalledWith(source.data, expect.objectContaining({ range }), expect.anything());
    expect(downloadPageExport).toHaveBeenCalledWith(result);
  });

  it('rejects empty and out-of-bounds custom ranges before preparing edits, then permits a corrected Chinese range', async () => {
    const readPDF = vi.fn().mockResolvedValue(source);
    await act(async () => { root.render(<ExportPagesDialog imagesOnly totalPages={8} readPDF={readPDF} onClose={vi.fn()} />); });
    expect(host.querySelector<HTMLInputElement>('input[value="selection"]')!.disabled).toBe(true);
    await choose('custom'); await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Enter at least one page');
    await enterRange('9'); await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('between 1 and 8');
    expect(readPDF).not.toHaveBeenCalled(); expect(exportPagesInWorker).not.toHaveBeenCalled();
    await act(async () => { useLocaleStore.getState().setLocale('zh-CN'); });
    expect(host.querySelector('h2')!.textContent).toBe('PDF 转图片');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('1和8');
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby]')!.value).toBe('9');
    await enterRange('３，１–２，３');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toContain('已选择 3 页，共 8 页');
    await submit();
    expect(readPDF).toHaveBeenCalledOnce();
    expect(exportPagesInWorker).toHaveBeenCalledWith(source.data, expect.objectContaining({ range: '３，１–２，３' }), expect.anything());
  });

  it('opens a native modal and allows retry after preparation fails without downloading incomplete data', async () => {
    const readPDF = vi.fn().mockRejectedValueOnce(new Error('Document changed')).mockResolvedValue(source), onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={readPDF} onClose={onClose} />); });
    expect(host.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Export format"]'));
    await submit();
    expect(host.querySelector('[role="alert"] .diagnostic-summary')?.textContent).toBe('Document changed');
    expect(exportPagesInWorker).not.toHaveBeenCalled(); expect(downloadPageExport).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit();
    expect(exportPagesInWorker).toHaveBeenCalledWith(source.data, expect.objectContaining({ fileName: 'source.pdf', format: 'png', dpi: 150 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(downloadPageExport).toHaveBeenCalledWith(result); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'unmount'] as const)('abandons pending PDF preparation on %s and blocks duplicate submits', async action => {
    let resolve!: (value: typeof source) => void;
    const readPDF = vi.fn<(signal?: AbortSignal) => Promise<typeof source>>().mockImplementation(() => new Promise(done => { resolve = done; })), onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={readPDF} onClose={onClose} />); });
    await submit(); await submit();
    expect(readPDF).toHaveBeenCalledTimes(1);
    expect(readPDF.mock.calls[0][0]?.aborted).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => {
      if (action === 'unmount') root.render(null);
      else host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await act(async () => { resolve(source); });
    expect(readPDF.mock.calls[0][0]?.aborted).toBe(true);
    expect(exportPagesInWorker).not.toHaveBeenCalled(); expect(downloadPageExport).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(action === 'cancel' ? 1 : 0);
  });

  it('aborts a running worker on unmount and ignores a late completion', async () => {
    let resolve!: (value: typeof result) => void;
    vi.mocked(exportPagesInWorker).mockImplementation(() => new Promise(done => { resolve = done; }));
    const onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={async () => source} onClose={onClose} />); });
    await submit();
    const control = vi.mocked(exportPagesInWorker).mock.calls[0][2]!;
    expect(control.signal!.aborted).toBe(false);
    await act(async () => { root.render(null); });
    expect(control.signal!.aborted).toBe(true);
    await act(async () => {
      control.onProgress?.({ completed: 1, total: 1, phase: 'pages' }); resolve(result);
    });
    expect(downloadPageExport).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});
