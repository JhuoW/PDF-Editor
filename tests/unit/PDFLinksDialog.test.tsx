// @vitest-environment jsdom
import { act, useEffect, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFLinksDialog, type PDFLinksDialogProps, type PDFLinksSource } from '../../src/components/Dialogs/PDFLinksDialog';
import type { PDFLinksPreview } from '../../src/components/Dialogs/PDFLinksPreview';
import type { PDFLinkDefinition, PDFLinkInspection } from '../../src/core/PDFLinkTypes';
const api = vi.hoisted(() => ({ inspect: vi.fn(), render: vi.fn(), autoReady: true }));
vi.mock('../../src/core/PDFLinksClient', () => ({ inspectPDFLinksInWorker: api.inspect }));
vi.mock('../../src/components/Dialogs/PDFLinksPreview', () => ({ PDFLinksPreview: function Preview(props: ComponentProps<typeof PDFLinksPreview>) {
  api.render(props); const { data, pageNumber, scale, onReady } = props;
  useEffect(() => { if (api.autoReady) onReady(); }, [data, pageNumber, scale, onReady]); return <div data-preview>{[...props.data].join(',')}</div>;
} }));
let root: Root, host: HTMLDivElement, props: PDFLinksDialogProps, source: PDFLinksSource, report: PDFLinkInspection;
const first: PDFLinkDefinition = { pageNumber: 1, rect: { x: 10, y: 20, width: 120, height: 30 }, target: { type: 'url', url: 'https://example.com' }, description: 'Website', border: { width: 0, color: '#000000', style: 'solid' } };
function currentOperations() { return vi.mocked(source.preview).mock.calls.at(-1)![0]; }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.autoReady = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  report = { revision: 'source-revision', pages: [{ pageNumber: 1, width: 400, height: 600, rotation: 0 }, { pageNumber: 2, width: 500, height: 700, rotation: 90 }], links: [
    { id: 'first', pageNumber: 1, rect: first.rect, definition: structuredClone(first), editable: true, removable: true, summary: 'Website' },
    { id: 'second', pageNumber: 2, rect: { x: 30, y: 40, width: 80, height: 25 }, definition: { pageNumber: 2, rect: { x: 30, y: 40, width: 80, height: 25 }, target: { type: 'page', pageNumber: 1, view: 'XYZ', x: null, y: 24, zoom: 1.5 } }, editable: true, removable: true, namedDestination: 'Chapter', summary: 'Chapter' },
    { id: 'unsupported', pageNumber: 1, rect: null, editable: false, removable: true, summary: 'JavaScript action', unsupportedReason: 'JavaScript actions are read only.' },
  ], canEdit: true };
  api.inspect.mockResolvedValue(report);
  source = { data: new Uint8Array([1]).buffer, preview: vi.fn(async ops => new Uint8Array([9, ops.length])) };
  props = { documentKey: 'document-one', revision: 1, currentPage: 1, readPDF: vi.fn(async () => source), onApply: vi.fn(async () => {}), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<PDFLinksDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<PDFLinksDialog {...props} />)); }
async function settle() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(element => element.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
function field(name: string) { return [...host.querySelectorAll('label')].find(element => element.firstChild?.textContent === name)!.querySelector('input,textarea,select')! as HTMLInputElement | HTMLSelectElement; }
async function fill(name: string, value: string) { const element = field(name), prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; await act(async () => { element.focus(); Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }); }
async function number(name: string, value: number) { await fill(name, String(value)); await act(async () => field(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); }
async function select(id = 'first') { await fill('Links', id); }
function preview(): ComponentProps<typeof PDFLinksPreview> { return api.render.mock.calls.at(-1)![0]; }
async function cancel() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }
function updateDefinition() { const op = currentOperations().find(op => op.type === 'update'); if (op?.type !== 'update') throw new Error('No update'); return op.definition; }

describe('PDFLinksDialog', () => {
  it('loads a modal, previews complete workspace bytes, filters and locates without opening links', async () => {
    await render(); await settle(); expect(host.querySelector('dialog')?.open).toBe(true); expect(host.querySelector('a')).toBeNull(); expect(currentOperations()).toEqual([]); expect(button('Apply links').disabled).toBe(true);
    await select('second'); expect(field('Preview page').value).toBe('2'); expect(field('Destination view').value).toBe('XYZ'); expect(field('Destination Y').value).toBe('24'); expect(field('Destination zoom (%)').value).toBe('150'); expect(host.textContent).toContain('Named destination: Chapter');
    await fill('Links on page', '2'); expect(field('Links').querySelectorAll('option')).toHaveLength(2); expect(preview().data).toEqual(new Uint8Array([9, 0]));
  });
  it('reuses the parent inspection and keeps unsupported annotations read only but explicitly removable', async () => {
    source.report = report; await render(); await settle(); expect(api.inspect).not.toHaveBeenCalled(); await select('unsupported'); expect(host.textContent).toContain('JavaScript actions are read only'); expect(host.textContent).toContain('explicitly delete'); expect(host.querySelector('input[type="text"]')).toBeNull();
    expect(preview().links.find(item => item.id === 'unsupported')?.rect).toBeUndefined(); await click('Delete link'); await settle(); expect(currentOperations()).toEqual([{ type: 'remove', id: 'unsupported' }]); await click('Apply links'); expect(vi.mocked(props.onApply).mock.calls[0][0]).toEqual([{ type: 'remove', id: 'unsupported' }]);
  });
  it('creates a drawn native URL link and batches update/create/remove in one apply', async () => {
    await render(); await settle(); await click('Add link'); expect(preview().placing).toBe(true);
    await act(async () => preview().onCreate({ x: 50, y: 60, width: 150, height: 40 })); await fill('URL', 'mailto:hello@example.com'); await fill('Description', 'Email'); await number('Border width', 2); await fill('Border style', 'underline'); await fill('Border color', '#112233');
    await select('first'); await fill('URL', 'https://updated.example'); await select('unsupported'); await click('Delete link'); await settle();
    const operations = currentOperations(); expect(operations.map(op => op.type)).toEqual(['remove', 'update', 'create']); expect(operations[2]).toMatchObject({ definition: { rect: { x: 50, y: 60, width: 150, height: 40 }, target: { type: 'url', url: 'mailto:hello@example.com' }, border: { width: 2, style: 'underline', color: '#112233' } } });
    await click('Apply links'); expect(props.onApply).toHaveBeenCalledTimes(1); expect(props.onClose).toHaveBeenCalledTimes(1); expect(report.links).toHaveLength(3);
  });
  it('creates at page center, edits all internal destination view modes, and preserves parameters of an existing XYZ link', async () => {
    await render(); await settle(); await select('second'); await number('Border width', 3); await settle(); expect(updateDefinition().target).toEqual(report.links[1].definition!.target);
    await click('Add link'); await click('Place at page center'); await fill('Link type', 'page'); await fill('Destination page', '1'); await fill('Destination view', 'FitR'); await number('Destination width', 300); await number('Destination X', 20); await settle();
    const create = currentOperations().find(op => op.type === 'create'); expect(create).toMatchObject({ definition: { pageNumber: 2, rect: { x: 190, y: 336, width: 120, height: 28 }, target: { pageNumber: 1, view: 'FitR', rect: { x: 20, width: 300 } } } });
    for (const view of ['FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'Fit', 'XYZ']) { await fill('Destination view', view); await settle(); expect((currentOperations().at(-1) as { definition: PDFLinkDefinition }).definition.target).toMatchObject({ view }); }
  });
  it('keeps numeric drafts from applying stale geometry, flushes Ctrl+S, and isolates values between links', async () => {
    await render(); await settle(); await select(); await fill('URL', 'https://changed.example'); await settle(); await fill('Width', '170'); expect(button('Apply links').disabled).toBe(true); expect(host.textContent).toContain('Finish numeric input'); await click('Apply links'); expect(props.onApply).not.toHaveBeenCalled();
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }); await act(async () => field('Width').dispatchEvent(event)); expect(event.defaultPrevented).toBe(true); expect(props.onApply).not.toHaveBeenCalled(); await settle(); expect(updateDefinition().rect.width).toBe(170);
    await fill('Border width', '55'); await select('second'); expect(field('Border width').value).toBe('0'); await settle(); expect(button('Apply links').disabled).toBe(false);
  });
  it('waits for actual canvas rendering, blocks render failures, and does not mutate operations for zoom/page changes', async () => {
    api.autoReady = false; await render(); await settle(); await select(); await fill('URL', 'https://changed.example'); await settle(); expect(button('Apply links').disabled).toBe(true);
    await act(async () => preview().onReady()); expect(button('Apply links').disabled).toBe(false); const calls = vi.mocked(source.preview).mock.calls.length;
    await fill('Preview zoom', '2'); expect(preview().scale).toBe(2); expect(button('Apply links').disabled).toBe(true); await act(async () => preview().onReady()); expect(button('Apply links').disabled).toBe(false);
    await fill('Preview page', '2'); expect(button('Apply links').disabled).toBe(true); await act(async () => preview().onError('Canvas error')); expect(host.textContent).toContain('Canvas error'); expect(button('Apply links').disabled).toBe(true); expect(source.preview).toHaveBeenCalledTimes(calls);
  });
  it('defers expensive previews during dragging and guards obsolete async preview results', async () => {
    await render(); await settle(); const calls = vi.mocked(source.preview).mock.calls.length; await act(async () => preview().onInteractionChange(true)); await act(async () => preview().onMove('first', { x: 70, y: 80, width: 150, height: 40 })); await settle(); expect(source.preview).toHaveBeenCalledTimes(calls);
    await act(async () => preview().onInteractionChange(false)); await settle(); expect(updateDefinition().rect.x).toBe(70);
    let finish!: (data: Uint8Array) => void; vi.mocked(source.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await select(); await fill('URL', 'https://old.example'); await settle(); const signal = vi.mocked(source.preview).mock.calls.at(-1)![1];
    await fill('URL', 'https://latest.example'); await settle(); expect(signal.aborted).toBe(true); await act(async () => finish(new Uint8Array([99]))); expect(preview().data).toEqual(new Uint8Array([9, 1])); expect(updateDefinition().target).toEqual({ type: 'url', url: 'https://latest.example' });
  });
  it('reports preview validation errors and allows correction without modifying the source', async () => {
    await render(); await settle(); await select(); vi.mocked(source.preview).mockRejectedValueOnce(new Error('Only http, https, and mailto links are supported.'));
    await fill('URL', 'javascript:bad()'); await settle(); expect(host.textContent).toContain('Only http'); expect(button('Apply links').disabled).toBe(true); expect(props.onApply).not.toHaveBeenCalled(); await fill('URL', 'https://valid.example'); await settle(); expect(button('Apply links').disabled).toBe(false);
  });
  it('handles read errors/retry and aborts old document reads', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Cannot read PDF')).mockResolvedValue(source) }); expect(host.textContent).toContain('Cannot read PDF'); await click('Retry'); await settle(); expect(host.textContent).toContain('Preview ready');
    let finish!: (value: PDFLinksSource) => void; const oldRead = vi.fn((signal: AbortSignal) => { signal.throwIfAborted(); return new Promise<PDFLinksSource>(resolve => { finish = resolve; }); }); await render({ documentKey: 'two', readPDF: oldRead });
    await render({ documentKey: 'three', readPDF: vi.fn(async () => source) }); await settle(); expect(oldRead.mock.calls[0][0].aborted).toBe(true); await act(async () => finish({ ...source, report: { ...report, links: [] } })); expect(host.textContent).toContain('Website');
  });
  it('cancels draft/preview work and never commits partial changes', async () => {
    await render(); await settle(); await select(); await fill('URL', 'https://unsaved.example'); await cancel(); expect(props.onApply).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1); expect(report.links[0].definition!.target).toEqual(first.target);
  });
  it('guards duplicate apply, aborts precommit work, and ignores completion after cancellation or document revision change', async () => {
    let finish!: () => void; await render({ onApply: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }); await settle(); await select(); await fill('URL', 'https://changed.example'); await settle();
    await act(async () => { button('Apply links').click(); button('Apply links').click(); }); expect(props.onApply).toHaveBeenCalledTimes(1); const signal = vi.mocked(props.onApply).mock.calls[0][1]; await cancel(); expect(signal.aborted).toBe(true); await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
    props.onClose = vi.fn(); await render({ revision: 2 }); await settle(); await select(); await fill('URL', 'https://other.example'); await settle(); await click('Apply links'); const second = vi.mocked(props.onApply).mock.calls[1][1]; await render({ revision: 3 }); await settle(); expect(second.aborted).toBe(true); await act(async () => finish()); expect(props.onClose).not.toHaveBeenCalled();
  });
  it('prevents closing after the atomic commit boundary and recovers from save failure', async () => {
    let finish!: () => void; await render({ onApply: vi.fn(async (_ops, _signal, commit) => { commit(); await new Promise<void>(resolve => { finish = resolve; }); }) }); await settle(); await select(); await fill('URL', 'https://changed.example'); await settle(); await click('Apply links');
    expect(button('Cancel').disabled).toBe(true); await cancel(); expect(props.onClose).not.toHaveBeenCalled(); await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
    await render({ revision: 2, onApply: vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue(undefined) }); await settle(); await select(); await fill('URL', 'https://retry.example'); await settle(); await click('Apply links'); expect(host.textContent).toContain('Save failed'); expect(button('Apply links').disabled).toBe(false); await click('Apply links'); expect(props.onApply).toHaveBeenCalledTimes(2);
  });
  it('survives its own committed revision publication and closes exactly once after apply resolves', async () => {
    let finish!: () => void;
    await render({ onApply: vi.fn(async (_operations, _signal, onCommit) => { onCommit(); await new Promise<void>(resolve => { finish = resolve; }); }) }); await settle(); await select(); await fill('URL', 'https://committed.example'); await settle(); await click('Apply links');
    const signal = vi.mocked(props.onApply).mock.calls[0][1]; const reads = vi.mocked(props.readPDF).mock.calls.length;
    await render({ revision: 2 }); expect(signal.aborted).toBe(false); expect(props.readPDF).toHaveBeenCalledTimes(reads); expect(button('Cancel').disabled).toBe(true);
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false);
  });
  it('does not permit creating, editing, or deleting links from a restricted document', async () => {
    report.canEdit = false; report.unsupportedReason = 'Signed PDFs are read only.'; await render(); await settle(); expect(host.textContent).toContain('Signed PDFs'); expect(button('Add link').disabled).toBe(true); await select('unsupported'); expect(button('Delete link').disabled).toBe(true); expect(button('Apply links').disabled).toBe(true);
  });
});
