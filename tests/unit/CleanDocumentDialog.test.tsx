// @vitest-environment jsdom
import { useLocaleStore } from '../../src/i18n';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleanDocumentDialog, type CleanDocumentDialogProps, type CleanDocumentSource } from '../../src/components/Dialogs/CleanDocumentDialog';
import type { CleanupReport } from '../../src/core/DocumentCleanupTypes';
import type { VisibleCopyResult } from '../../src/core/VisibleCopyTypes';
const api = vi.hoisted(() => ({ inspect: vi.fn(), clean: vi.fn(), inspectVisible: vi.fn(), createVisible: vi.fn() }));
vi.mock('../../src/core/DocumentCleanup', () => ({ inspectPDFCleanup: api.inspect, cleanPDF: api.clean }));
vi.mock('../../src/core/VisibleCopyClient', () => ({ inspectVisibleCopyInWorker: api.inspectVisible, createVisibleCopyInWorker: api.createVisible }));
vi.mock('../../src/components/Dialogs/DecorationPDFPreview', () => ({ DecorationPDFPreview: ({ data, pageNumber }: { data: Uint8Array; pageNumber: number }) => <div data-preview>{[...data].join(',')} page {pageNumber}</div> }));
let root: Root, host: HTMLDivElement, props: CleanDocumentDialogProps, source: CleanDocumentSource, report: CleanupReport;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  report = { revision: 'original-hash', pageCount: 2, findings: [{ id: 'm1', category: 'metadata', label: 'Title', pages: [], details: 'Private title', affectsAppearance: false }], counts: { metadata: 1, attachments: 2, activeContent: 1, comments: 1, links: 2, forms: 1, privateData: 1 }, canClean: true, hasSignatures: false, hasXfa: false, limitations: ['Page content is not checked for every hidden object.'] };
  source = { data: new Uint8Array([1]).buffer, report, fileName: 'private.pdf', workspaceAnnotations: { count: 2, pages: [1] }, pendingRedactions: 0,
    preparePreview: vi.fn(async (data, options) => new Uint8Array([...data, options.comments ? 0 : 9])), readVisiblePDF: vi.fn(async () => new Uint8Array([4]).buffer) };
  api.inspect.mockImplementation(async () => report); api.clean.mockImplementation(async (_data, options) => ({ data: new Uint8Array([2]), report: { ...report, counts: Object.fromEntries(Object.entries(report.counts).map(([key, value]) => [key, options[key] ? 0 : value])) }, removed: report.counts }));
  api.inspectVisible.mockResolvedValue({ pageCount: 2, pages: [1, 2].map(pageNumber => ({ pageNumber, width: 400, height: 600, pixelWidth: 800, pixelHeight: 1200, pixels: 960000 })), totalPixels: 1920000, hasSignatures: false, warnings: [], warningsTruncated: false });
  api.createVisible.mockResolvedValue({ data: new Uint8Array([5]), pageCount: 1, sourcePageCount: 2, pages: [1], dpi: 150, compression: 'lossless', encodedImageBytes: 100, warnings: [], warningsTruncated: false });
  props = { documentKey: 'one', revision: 1, currentPage: 1, readPDF: vi.fn(async () => source), onApply: vi.fn(async (_options, _signal, commit) => { commit(); }), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { useLocaleStore.getState().setLocale('en'); localStorage.clear(); await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(changes: Partial<CleanDocumentDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<CleanDocumentDialog {...props} />)); }
async function settlePreview() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
function checkbox(name: string) { return host.querySelector(`input[aria-label="${name}"]`)! as HTMLInputElement; }
async function toggle(name: string) { await act(async () => checkbox(name).click()); }
async function escape() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }

describe('CleanDocumentDialog', () => {
  it('translates active cleanup progress without restarting or discarding the operation', async () => {
    let finish!: () => void;
    await render({ onApply: vi.fn((_options, _signal, _commit, progress) => {
      progress?.({ phase: 'clean', completed: 3, total: 10 });
      return new Promise<void>(resolve => { finish = resolve; });
    }) });
    await settlePreview(); await click('Apply cleanup');
    expect(host.querySelector('.clean-progress')?.textContent).toContain('Removing selected items');
    await act(async () => useLocaleStore.getState().setLocale('zh-CN'));
    expect(host.querySelector('.clean-progress')?.textContent).not.toContain('Removing');
    expect(host.querySelector('.clean-progress')?.textContent).toContain('3 / 10');
    await act(async () => useLocaleStore.getState().setLocale('en'));
    expect(host.querySelector('.clean-progress')?.textContent).toContain('Removing selected items');
    expect(props.onApply).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('reuses the prepared report, selects conservative defaults, merges current annotations, and waits for an exact preview before Apply', async () => {
    await render(); expect(host.querySelector('dialog')?.open).toBe(true); expect(api.inspect).not.toHaveBeenCalled();
    for (const name of ['Document metadata', 'Attachments', 'Scripts and active content']) expect(checkbox(name).checked).toBe(true);
    for (const name of ['Comments and annotations', 'Links', 'Form fields and values', 'Private application data']) expect(checkbox(name).checked).toBe(false);
    expect(checkbox('Comments and annotations').closest('.clean-category')?.textContent).toContain('3 found');
    expect(button('Apply cleanup').disabled).toBe(true); await settlePreview(); expect(button('Apply cleanup').disabled).toBe(false);
    expect(api.clean.mock.calls[0][2]).toMatchObject({ expectedRevision: 'original-hash', signal: expect.any(AbortSignal) });
    expect(host.querySelector('[data-preview]')?.textContent).toBe('2,9 page 1'); await click('Apply cleanup'); expect(props.onApply).toHaveBeenCalledTimes(1); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('compares current and cleaned pages and previews removal of editable annotations only when selected', async () => {
    await render(); await settlePreview(); await click('Current'); expect(host.querySelector('[data-preview]')?.textContent).toBe('1,9 page 1');
    await toggle('Comments and annotations'); expect(button('Apply cleanup').disabled).toBe(true); await settlePreview(); await click('After cleanup');
    expect(host.querySelector('[data-preview]')?.textContent).toBe('2,0 page 1'); expect(props.onApply).not.toHaveBeenCalled();
  });
  it('ignores stale previews and does not apply a failed preview', async () => {
    let finish!: (value: unknown) => void;
    api.clean.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await settlePreview(); await toggle('Comments and annotations'); await settlePreview();
    expect(host.querySelector('[data-preview]')?.textContent).toBe('2,0 page 1');
    await act(async () => finish({ data: new Uint8Array([88]), report, removed: report.counts })); expect(host.querySelector('[data-preview]')?.textContent).toBe('2,0 page 1');
    api.clean.mockRejectedValueOnce(new Error('Cleanup could not be verified.')); await toggle('Links'); await settlePreview();
    expect(host.textContent).toContain('could not be verified'); expect(button('Apply cleanup').disabled).toBe(true); expect(props.onApply).not.toHaveBeenCalled();
  });
  it('keeps unsupported PDFs inspectable and supports keyboard tab navigation without running background shortcuts', async () => {
    report.canClean = false; report.unsupportedReason = 'This signed PDF is read only for selective cleanup.';
    await render(); await settlePreview(); expect(host.textContent).toContain('signed PDF'); expect(button('Apply cleanup').disabled).toBe(true);
    const tab = button('Review & remove'); await act(async () => tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(button('Save visible copy').getAttribute('aria-selected')).toBe('true');
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }); await act(async () => button('Save visible copy').dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true); expect(props.onApply).not.toHaveBeenCalled();
  });
  it('displays native progress, prevents duplicate applies, and waits for cancellation before closing', async () => {
    let finish!: () => void;
    await render({ onApply: vi.fn((_options, _signal, _commit, progress) => { progress?.({ phase: 'clean', completed: 3, total: 10 }); return new Promise<void>(resolve => { finish = resolve; }); }) });
    await settlePreview(); await click('Apply cleanup'); await click('Apply cleanup'); expect(props.onApply).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('3 / 10');
    await escape(); expect(vi.mocked(props.onApply).mock.calls[0][1].aborted).toBe(true); expect(props.onClose).not.toHaveBeenCalled(); await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('locks cancellation during the atomic commit and rejects old-document callbacks', async () => {
    let finish!: () => void;
    await render({ onApply: vi.fn((_options, _signal, commit) => { commit(); return new Promise<void>(resolve => { finish = resolve; }); }) }); await settlePreview(); await click('Apply cleanup'); await escape();
    expect(vi.mocked(props.onApply).mock.calls[0][1].aborted).toBe(false); expect(button('Cancel cleanup').disabled).toBe(true); await act(async () => finish());
    const committed = vi.fn();
    await render({ documentKey: 'two', onClose: vi.fn(), onApply: async (_options, _signal, commit) => { await new Promise<void>(resolve => { finish = resolve; }); commit(); committed(); } });
    await settlePreview(); await click('Apply cleanup'); await render({ documentKey: 'three' }); await act(async () => finish()); expect(committed).not.toHaveBeenCalled();
  });
  it('retries read failures, scans when no report is provided, and preserves selection after an Apply failure', async () => {
    source.report = undefined;
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(source), onApply: vi.fn().mockRejectedValue(new Error('Save failed')) });
    expect(host.textContent).toContain('Read failed'); await click('Retry'); expect(api.inspect).toHaveBeenCalledTimes(1); await toggle('Links'); await settlePreview(); await click('Apply cleanup');
    expect(host.textContent).toContain('Save failed'); expect(checkbox('Links').checked).toBe(true); expect(button('Apply cleanup').disabled).toBe(false); expect(props.onClose).not.toHaveBeenCalled();
  });
  it('aborts an old read when the document changes and never publishes its report', async () => {
    let finish!: (value: CleanDocumentSource) => void;
    await render({ readPDF: vi.fn(() => new Promise(resolve => { finish = resolve; })) }); const signal = vi.mocked(props.readPDF).mock.calls[0][0];
    await render({ documentKey: 'new', readPDF: vi.fn(async () => source) }); await act(async () => finish({ ...source, report: { ...report, unsupportedReason: 'STALE REPORT', canClean: false } }));
    expect(signal.aborted).toBe(true); expect(host.textContent).not.toContain('STALE REPORT');
  });
  it('releases a replaced revision\'s copy generation without unlocking a newer generation', async () => {
    let finishOld!: (value: VisibleCopyResult) => void, finishNew!: (value: VisibleCopyResult) => void;
    await render(); await click('Save visible copy'); await settlePreview();
    api.createVisible.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    await click('Download image-only PDF');
    const oldSignal = api.createVisible.mock.calls.at(-1)![2].signal;
    expect(button('Review & remove').disabled).toBe(true);
    await render({ revision: 2 }); await settlePreview();
    expect(oldSignal.aborted).toBe(true); expect(button('Review & remove').disabled).toBe(false);
    api.createVisible.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    await click('Download image-only PDF'); expect(button('Review & remove').disabled).toBe(true);
    const result = await api.createVisible.mock.results[0].value as VisibleCopyResult;
    await act(async () => finishOld(result)); expect(button('Review & remove').disabled).toBe(true);
    await click('Cancel generation'); await act(async () => finishNew(result));
    expect(button('Review & remove').disabled).toBe(false);
    await click('Review & remove'); await settlePreview(); expect(button('Apply cleanup').disabled).toBe(false);
  });
});
