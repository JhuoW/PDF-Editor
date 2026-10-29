// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPagesDialog } from '../../src/components/Dialogs/ExportPagesDialog';
import { downloadPageExport, exportPagesInWorker } from '../../src/core/PageExportClient';

vi.mock('../../src/core/PageExportClient', () => ({ downloadPageExport: vi.fn(), exportPagesInWorker: vi.fn() }));
const source = { data: new Uint8Array([1, 2]), fileName: 'source.pdf' };
const result = { data: new Uint8Array([9]), fileName: 'source-page-1.png', mimeType: 'image/png', pages: [1] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(exportPagesInWorker).mockResolvedValue(result);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

describe('ExportPagesDialog', () => {
  it('opens a native modal and allows retry after preparation fails without downloading incomplete data', async () => {
    const readPDF = vi.fn().mockRejectedValueOnce(new Error('Document changed')).mockResolvedValue(source), onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={readPDF} onClose={onClose} />); });
    expect(host.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Export format"]'));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Document changed');
    expect(exportPagesInWorker).not.toHaveBeenCalled(); expect(downloadPageExport).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit();
    expect(exportPagesInWorker).toHaveBeenCalledWith(source.data, expect.objectContaining({ fileName: 'source.pdf', format: 'png', dpi: 150 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(downloadPageExport).toHaveBeenCalledWith(result); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'unmount'] as const)('abandons pending PDF preparation on %s and blocks duplicate submits', async action => {
    let resolve!: (value: typeof source) => void;
    const readPDF = vi.fn(() => new Promise<typeof source>(done => { resolve = done; })), onClose = vi.fn();
    await act(async () => { root.render(<ExportPagesDialog readPDF={readPDF} onClose={onClose} />); });
    await submit(); await submit();
    expect(readPDF).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => {
      if (action === 'unmount') root.render(null);
      else host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await act(async () => { resolve(source); });
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
