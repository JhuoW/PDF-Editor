// @vitest-environment jsdom
import { act, useEffect, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFBookmarksDialog, type PDFBookmarksDialogProps, type PDFBookmarksSource } from '../../src/components/Dialogs/PDFBookmarksDialog';
import type { PDFLinksPreview } from '../../src/components/Dialogs/PDFLinksPreview';
import type { PDFBookmarkInfo, PDFBookmarkInspection } from '../../src/core/PDFBookmarksTypes';
const api = vi.hoisted(() => ({ render: vi.fn(), autoReady: true }));
vi.mock('../../src/components/Dialogs/PDFLinksPreview', () => ({ PDFLinksPreview: function Preview(props: ComponentProps<typeof PDFLinksPreview>) {
  api.render(props); const { data, pageNumber, scale, onReady } = props;
  useEffect(() => { if (api.autoReady) onReady(); }, [data, pageNumber, scale, onReady]); return <div data-preview>{[...data].join(',')}</div>;
} }));
let root: Root, host: HTMLDivElement, props: PDFBookmarksDialogProps, source: PDFBookmarksSource, report: PDFBookmarkInspection;
function node(id: string, title: string, pageNumber = 1, children: PDFBookmarkInfo[] = []): PDFBookmarkInfo {
  return { id, definition: { title, target: { type: 'page', pageNumber, view: 'Fit' }, bold: false, italic: false, color: '#000000', expanded: true }, children, editable: true, movable: true, removable: true };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.autoReady = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  report = { revision: 'revision', canEdit: true, pages: [{ pageNumber: 1, width: 400, height: 600, rotation: 0 }, { pageNumber: 2, width: 500, height: 700, rotation: 90 }], bookmarks: [node('first', 'Chapter 一', 1, [node('child', 'Child', 2)]), node('second', 'Chapter 二', 2), { ...node('unknown', 'Unsupported'), definition: { ...node('', '').definition, title: 'Unsupported', target: null }, editable: false, unsupportedReason: 'JavaScript actions are read only.' }] };
  source = { data: new Uint8Array([1]).buffer, report, preview: vi.fn(async tree => new Uint8Array([9, tree.length])) };
  props = { documentKey: 'one', revision: 1, currentPage: 1, readPDF: vi.fn(async () => source), onApply: vi.fn(async () => {}), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<PDFBookmarksDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<PDFBookmarksDialog {...props} />)); }
async function settle() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(element => element.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
function field(name: string) { return [...host.querySelectorAll('label')].find(element => element.firstChild?.textContent === name)!.querySelector('input,select')! as HTMLInputElement | HTMLSelectElement; }
async function fill(name: string, value: string) { const element = field(name), prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; await act(async () => { element.focus(); Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }); }
async function number(name: string, value: number) { await fill(name, String(value)); await act(async () => field(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); }
async function select(id = 'first') { await fill('Bookmarks', id); }
function preview(): ComponentProps<typeof PDFLinksPreview> { return api.render.mock.calls.at(-1)![0]; }
function tree() { return vi.mocked(source.preview).mock.calls.at(-1)![0]; }
async function cancel() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }
function checkbox(label: string) { return [...host.querySelectorAll('label')].find(element => element.textContent === label)!.querySelector('input')!; }

describe('PDFBookmarksDialog', () => {
  it('shows native hierarchy and previews destination pages without interactive links or premature saving', async () => {
    await render(); await settle(); expect(host.querySelector('dialog')?.open).toBe(true); expect(host.querySelector('a')).toBeNull(); expect(button('Apply bookmarks').disabled).toBe(true);
    expect(tree()[0].children[0].id).toBe('child'); expect(tree()[0]).not.toHaveProperty('editable'); await select('child'); expect(field('Preview page').value).toBe('2'); expect(field('Destination page').value).toBe('2');
    expect(preview().showAreas).toBe(false); expect(preview().disabled).toBe(true); expect(preview().links).toEqual([]);
  });
  it('adds, renames, indents, outdents and reorders a complete tree without mutating the source', async () => {
    await render(); await settle(); await click('Add bookmark'); await fill('Title', '附录 Appendix'); await click('Move up'); await click('Indent'); await settle();
    expect(tree()[1].id).toBe('second'); expect(tree()[1].children[0].definition.title).toBe('附录 Appendix');
    await click('Outdent'); await click('Move up'); await settle(); expect(tree()[1].definition.title).toBe('附录 Appendix');
    await click('Apply bookmarks'); expect(props.onApply).toHaveBeenCalledTimes(1); expect(vi.mocked(props.onApply).mock.calls[0][0]).toEqual(tree()); expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(report.bookmarks).toHaveLength(3); expect(report.bookmarks[0].children).toHaveLength(1);
  });
  it('requires explicit confirmation before deleting a whole subtree and can keep it', async () => {
    await render(); await settle(); await select(); await click('Delete bookmark'); expect(host.textContent).toContain('and its 1 child bookmark'); expect(tree()).toHaveLength(3);
    await click('Keep bookmarks'); expect(button('Confirm delete')).toBeUndefined(); await click('Delete bookmark'); await click('Confirm delete'); await settle(); expect(tree().map(item => item.id)).toEqual(['second', 'unknown']);
    await cancel(); expect(props.onApply).not.toHaveBeenCalled(); expect(report.bookmarks[0].children[0].id).toBe('child');
  });
  it('preserves readonly actions and prevents deletion of a protected descendant', async () => {
    report.bookmarks[0].children[0].removable = false; await render(); await settle(); await select(); expect(button('Delete bookmark').disabled).toBe(true);
    await select('unknown'); expect(host.textContent).toContain('JavaScript actions are read only'); expect(host.querySelector('input[maxlength="4096"]')).toBeNull(); expect(button('Move up').disabled).toBe(false);
    await click('Move up'); await settle(); expect(tree()[1].definition.target).toBeNull(); await click('Delete bookmark'); await click('Confirm delete'); await settle(); expect(tree().some(item => item.id === 'unknown')).toBe(false);
  });
  it('keeps existing named destination parameters when changing style and supports all native destination modes', async () => {
    report.bookmarks[0].namedDestination = 'chapter'; report.bookmarks[0].definition.target = { type: 'page', pageNumber: 2, view: 'XYZ', x: null, y: 34, zoom: 1.5 };
    await render(); await settle(); await select(); await act(async () => checkbox('Bold').click()); await settle(); expect(tree()[0].definition.target).toEqual(report.bookmarks[0].definition.target); expect(tree()[0].definition.bold).toBe(true);
    expect(host.textContent).toContain('Named destination: chapter');
    for (const view of ['Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR']) { await fill('Destination view', view); await settle(); expect(tree()[0].definition.target).toMatchObject({ type: 'page', view }); }
    await number('Destination X', 10); await number('Destination width', 450); await settle(); expect(tree()[0].definition.target).toMatchObject({ rect: { x: 0, width: 450 } });
    await fill('Destination type', 'group'); await settle(); expect(tree()[0].definition.target).toBeNull(); expect(host.textContent).toContain('does not navigate');
  });
  it('blocks saving unfinished numeric input and waits for the actual current PDF render', async () => {
    await render(); await settle(); await select(); await fill('Destination view', 'XYZ'); await act(async () => checkbox('Keep current Y').click()); await settle();
    await fill('Destination Y', '123'); expect(button('Apply bookmarks').disabled).toBe(true); const calls = vi.mocked(source.preview).mock.calls.length; await settle(); expect(source.preview).toHaveBeenCalledTimes(calls);
    api.autoReady = false; await act(async () => field('Destination Y').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); await settle(); expect(button('Apply bookmarks').disabled).toBe(true);
    await act(async () => preview().onReady()); expect(button('Apply bookmarks').disabled).toBe(false); expect(tree()[0].definition.target).toMatchObject({ y: 123 });
  });
  it('reports validation and render failures and recovers after correcting parameters', async () => {
    await render(); await settle(); await select(); await fill('Destination type', 'url'); vi.mocked(source.preview).mockRejectedValueOnce(new Error('Only http, https, and mailto are supported.')); await fill('URL', 'javascript:bad()'); await settle(); expect(host.textContent).toContain('Only http'); expect(button('Apply bookmarks').disabled).toBe(true);
    await fill('URL', 'mailto:review@example.com'); await settle(); expect(button('Apply bookmarks').disabled).toBe(false);
    await act(async () => preview().onError('Page render failed')); expect(button('Apply bookmarks').disabled).toBe(true); expect(host.textContent).toContain('Page render failed');
    await fill('Title', 'Email'); await settle(); expect(button('Apply bookmarks').disabled).toBe(false);
  });
  it('ignores old previews and cancels draft work without a commit', async () => {
    await render(); await settle(); await select(); let finish!: (data: Uint8Array) => void; vi.mocked(source.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await fill('Title', 'Old'); await settle(); const signal = vi.mocked(source.preview).mock.calls.at(-1)![1]; await fill('Title', 'Latest'); await settle(); expect(signal.aborted).toBe(true);
    await act(async () => finish(new Uint8Array([99]))); expect(preview().data).toEqual(new Uint8Array([9, 3])); expect(tree()[0].definition.title).toBe('Latest');
    await cancel(); expect(props.onApply).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('retries failed reads and ignores a late read after a document change', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Cannot read')).mockResolvedValue(source) }); expect(host.textContent).toContain('Cannot read'); await click('Retry'); await settle(); expect(host.textContent).toContain('Preview ready');
    let finish!: (source: PDFBookmarksSource) => void; const oldRead = vi.fn((signal: AbortSignal) => { signal.throwIfAborted(); return new Promise<PDFBookmarksSource>(resolve => { finish = resolve; }); }); await render({ documentKey: 'two', readPDF: oldRead }); await render({ documentKey: 'three', readPDF: vi.fn(async () => source) }); await settle();
    expect(oldRead.mock.calls[0][0].aborted).toBe(true); await act(async () => finish({ ...source, report: { ...report, bookmarks: [] } })); expect(host.textContent).toContain('Chapter 一');
  });
  it('does not let an old apply close a replacement document and guards duplicate saves', async () => {
    let finish!: () => void; await render({ onApply: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }); await settle(); await select(); await fill('Title', 'Changed'); await settle(); await act(async () => { button('Apply bookmarks').click(); button('Apply bookmarks').click(); });
    expect(props.onApply).toHaveBeenCalledTimes(1); const signal = vi.mocked(props.onApply).mock.calls[0][1]; await render({ revision: 2 }); await settle(); expect(signal.aborted).toBe(true); await act(async () => finish()); expect(props.onClose).not.toHaveBeenCalled();
  });
  it('survives its own committed revision, disables cancellation during commit and closes once', async () => {
    let finish!: () => void; await render({ onApply: vi.fn(async (_tree, _signal, commit) => { commit(); await new Promise<void>(resolve => { finish = resolve; }); }) }); await settle(); await select(); await fill('Title', 'Committed'); await settle(); await click('Apply bookmarks');
    const signal = vi.mocked(props.onApply).mock.calls[0][1], reads = vi.mocked(props.readPDF).mock.calls.length; await render({ revision: 2 }); expect(signal.aborted).toBe(false); expect(props.readPDF).toHaveBeenCalledTimes(reads); expect(button('Cancel').disabled).toBe(true); await cancel(); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('reports save failures and restricts edits in a readonly document', async () => {
    await render({ onApply: vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue(undefined) }); await settle(); await select(); await fill('Title', 'Changed'); await settle(); await click('Apply bookmarks'); expect(host.textContent).toContain('Save failed'); expect(button('Apply bookmarks').disabled).toBe(false); await click('Apply bookmarks'); expect(props.onClose).toHaveBeenCalledTimes(1);
    report.canEdit = false; report.unsupportedReason = 'Signed PDFs are read only.'; await render({ revision: 2 }); await settle(); expect(host.textContent).toContain('Signed PDFs'); expect(button('Add bookmark').disabled).toBe(true); await select(); expect(button('Delete bookmark').disabled).toBe(true); expect(button('Apply bookmarks').disabled).toBe(true);
  });
});
