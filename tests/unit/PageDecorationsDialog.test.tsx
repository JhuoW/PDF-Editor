// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageDecorationsDialog, type PageDecorationsDialogProps } from '../../src/components/Dialogs/PageDecorationsDialog';
import type { PageDecorationInspection } from '../../src/core/PageDecorationTypes';
import { createDecorationDraft } from '../../src/components/Dialogs/decorationDraft';
const api = vi.hoisted(() => ({ inspect: vi.fn(), apply: vi.fn() }));
vi.mock('../../src/core/PageDecorations', () => ({ inspectPageDecorations: api.inspect, applyPageDecorations: api.apply }));
vi.mock('../../src/components/Dialogs/DecorationPDFPreview', () => ({ DecorationPDFPreview: ({ data }: { data: Uint8Array }) => <div data-preview>{[...data].join(',')}</div> }));
let root: Root, host: HTMLDivElement, props: PageDecorationsDialogProps, inspection: PageDecorationInspection;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  inspection = { pages: [1, 2, 3].map(pageNumber => ({ pageNumber, width: 400, height: 600 })), decorations: [], canEdit: true };
  api.inspect.mockImplementation(async () => structuredClone(inspection)); api.apply.mockResolvedValue(new Uint8Array([2]));
  props = { documentKey: 'one', revision: 1, currentPage: 1, readPDF: vi.fn(async () => new Uint8Array([1]).buffer), onApply: vi.fn(async (_ops, _signal, commit) => { commit(); }), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(changes: Partial<PageDecorationsDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<PageDecorationsDialog {...props} />)); }
async function preview() { await act(async () => vi.advanceTimersByTimeAsync(350)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
function input(label: string) { return [...host.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('input,select,textarea')! as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }
async function fill(label: string, text: string) {
  const element = input(label), prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
async function escape() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }

describe('PageDecorationsDialog', () => {
  it('previews the actual output locally and applies one operation batch only when requested', async () => {
    await render(); await preview(); expect(host.querySelector('dialog')?.open).toBe(true); expect(host.querySelector('[data-preview]')?.textContent).toBe('1');
    await click('Add watermark'); await fill('Watermark text', 'CONFIDENTIAL 中文'); await preview();
    expect(api.apply).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), [expect.objectContaining({ type: 'create', definition: expect.objectContaining({ content: expect.objectContaining({ text: 'CONFIDENTIAL 中文' }) }) })], expect.objectContaining({ previewPage: 1, signal: expect.any(AbortSignal) }));
    expect(props.onApply).not.toHaveBeenCalled(); expect(host.querySelector('[data-preview]')?.textContent).toBe('2');
    await click('Apply decorations'); expect(props.onApply).toHaveBeenCalledTimes(1); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('validates page range/parity and switches the generated preview page', async () => {
    await render(); await click('Add watermark'); await fill('Pages', '1-3'); await fill('Page filter', 'even'); await preview();
    expect(api.apply.mock.calls.at(-1)[1][0].definition.pages).toEqual([2]);
    await fill('Preview page', '2'); await preview(); expect(api.apply.mock.calls.at(-1)[2].previewPage).toBe(2);
    await fill('Pages', '1'); expect(host.textContent).toContain('select no pages'); expect(button('Apply decorations').disabled).toBe(true);
    await fill('Pages', '2'); expect(button('Apply decorations').disabled).toBe(false);
  });
  it('prepares editable overlays after the generated decoration output without changing the source passed to Apply', async () => {
    const preparePreview = vi.fn(async (data: Uint8Array) => new Uint8Array([...data, 9]));
    await render({ readPDF: async () => ({ data: new Uint8Array([1]).buffer, preparePreview }) });
    await click('Add watermark'); await preview();
    expect(preparePreview).toHaveBeenLastCalledWith(new Uint8Array([2])); expect(host.querySelector('[data-preview]')?.textContent).toBe('2,9');
    expect(new Uint8Array(api.apply.mock.calls[0][0])).toEqual(new Uint8Array([1])); await click('Apply decorations'); expect(props.onApply).toHaveBeenCalledTimes(1);
  });
  it('inserts numbering tokens and flushes a focused numeric draft for keyboard Apply', async () => {
    await render(); await click('Add headers & footers'); await fill('Header left', 'CASE ');
    await act(async () => { input('Header left').focus(); (input('Header left') as HTMLTextAreaElement).setSelectionRange(5, 5); });
    await click('Insert {bates}'); expect(input('Header left').value).toBe('CASE {bates}');
    await fill('Bates prefix', 'CN-'); await fill('Bates digits', '8'); await act(async () => input('Bates digits').focus());
    await act(async () => input('Bates digits').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(vi.mocked(props.onApply).mock.calls[0][0][0]).toMatchObject({ type: 'create', definition: { slots: { headerLeft: 'CASE {bates}' }, bates: { digits: 8, prefix: 'CN-' } } });
  });
  it('lists existing decorations, keeps unowned data read only, and deletes only the selected owned ID', async () => {
    const definition = createDecorationDraft('watermark', [1]).definition;
    inspection.decorations = [{ id: 'owned', definition, pages: [1], managed: true, needsRefresh: true }, { id: 'unsafe', definition: { ...definition, name: 'Unowned' }, pages: [1], managed: false, needsRefresh: false, reason: 'The original marks were changed elsewhere.' }];
    await render(); expect(button('Refresh page numbering')).toBeDefined();
    await fill('Decorations', 'unsafe'); expect(button('Remove decoration').disabled).toBe(true); expect(host.textContent).toContain('changed elsewhere');
    await fill('Decorations', 'owned'); await click('Remove decoration'); await click('Apply decorations');
    expect(vi.mocked(props.onApply).mock.calls[0][0]).toEqual([{ type: 'remove', id: 'owned' }]);
  });
  it('ignores obsolete preview results and reports errors without replacing the document', async () => {
    let finish!: (data: Uint8Array) => void;
    api.apply.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click('Add watermark'); await preview();
    await fill('Watermark text', 'New text'); await preview(); expect(host.querySelector('[data-preview]')?.textContent).toBe('2');
    await act(async () => finish(new Uint8Array([99]))); expect(host.querySelector('[data-preview]')?.textContent).toBe('2');
    api.apply.mockRejectedValueOnce(new Error('This text does not fit the page.')); await fill('Watermark text', 'Too large'); await preview();
    expect(host.textContent).toContain('does not fit'); expect(button('Apply decorations').disabled).toBe(true); expect(props.onApply).not.toHaveBeenCalled();
  });
  it('aborts before closing, prevents duplicate applies, and locks cancel after atomic commit starts', async () => {
    let finish!: () => void;
    await render({ onApply: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }); await click('Add watermark'); await click('Apply decorations'); await click('Apply decorations'); await escape();
    expect(props.onApply).toHaveBeenCalledTimes(1); expect(vi.mocked(props.onApply).mock.calls[0][1].aborted).toBe(true); expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
    await render({ documentKey: 'two', onClose: vi.fn(), onApply: vi.fn((_ops, _signal, commit) => { commit(); return new Promise<void>(resolve => { finish = resolve; }); }) });
    await click('Add watermark'); await click('Apply decorations'); await escape(); expect(vi.mocked(props.onApply).mock.calls[0][1].aborted).toBe(false); expect(button('Discard changes').disabled).toBe(true);
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('rejects stale reads and prevents an old operation from committing after a document replacement', async () => {
    let finishRead!: (data: ArrayBuffer) => void;
    await render({ readPDF: vi.fn(() => new Promise(resolve => { finishRead = resolve; })) });
    await render({ documentKey: 'two', readPDF: vi.fn(async () => new Uint8Array([3]).buffer) }); await act(async () => finishRead(new Uint8Array([1]).buffer));
    expect(api.inspect).toHaveBeenCalledTimes(1);
    let finish!: () => void; const committed = vi.fn();
    await render({ onApply: async (_ops, _signal, commit) => { await new Promise<void>(resolve => { finish = resolve; }); commit(); committed(); } });
    await click('Add watermark'); await click('Apply decorations'); await render({ documentKey: 'three' }); await act(async () => finish()); expect(committed).not.toHaveBeenCalled();
  });
  it('shows read/apply failures with retry and preserves the editable draft', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(new Uint8Array([1]).buffer), onApply: vi.fn().mockRejectedValue(new Error('Save failed')) });
    expect(host.textContent).toContain('Read failed'); await click('Retry'); await click('Add background'); await click('Apply decorations');
    expect(host.textContent).toContain('Save failed'); expect(button('Apply decorations').disabled).toBe(false); expect(props.onClose).not.toHaveBeenCalled();
  });

  it('checks image size before reading bytes and keeps restricted PDFs read only', async () => {
    await render(); await click('Add watermark'); await fill('Watermark type', 'image');
    const file = new File(['x'], 'huge.png', { type: 'image/png' }), read = vi.fn();
    Object.defineProperty(file, 'size', { value: 41 * 1024 * 1024 }); Object.defineProperty(file, 'arrayBuffer', { value: read });
    const picker = input('Watermark image'); Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
    expect(read).not.toHaveBeenCalled(); expect(host.textContent).toContain('at most 40 MB');
    inspection = { ...inspection, canEdit: false, unsupportedReason: 'This signed PDF cannot be modified.' };
    await render({ revision: 2 }); expect(button('Add watermark').disabled).toBe(true); expect(button('Apply decorations').disabled).toBe(true); expect(host.textContent).toContain('signed PDF');
  });
});
