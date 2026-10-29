// @vitest-environment jsdom
import { act, useEffect, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextLayoutDialog, type TextLayoutDialogProps, type TextLayoutSource } from '../../src/components/Dialogs/TextLayoutDialog';
import type { TextLayoutPreview } from '../../src/components/Dialogs/TextLayoutPreview';
import type { PreparedTextEditLayout } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

const api = vi.hoisted(() => ({ prepare: vi.fn(), render: vi.fn(), autoReady: true }));
vi.mock('../../src/editing/TextLayoutClient', () => ({ prepareTextEditLayoutInWorker: api.prepare }));
vi.mock('../../src/components/Dialogs/TextLayoutPreview', () => ({ TextLayoutPreview: function Preview(props: ComponentProps<typeof TextLayoutPreview>) {
  api.render(props);
  const { data, scale, onReady } = props;
  useEffect(() => { if (api.autoReady) onReady?.(); }, [data, scale, onReady]);
  return <div data-preview>{[...props.data].join(',')}</div>;
} }));
let root: Root, host: HTMLDivElement, props: TextLayoutDialogProps, source: TextLayoutSource;
function prepared(block: TextBlock, edit: TextEditOperation): PreparedTextEditLayout {
  const input = { text: edit.newText, rect: edit.layout?.targetRect ?? block.rect, fontName: edit.layout?.fontName ?? 'Times-Roman', fontColor: edit.layout?.fontColor ?? '#123456', fontSize: edit.layout?.fontSize ?? 12, lineHeight: edit.layout?.lineHeight ?? 1.2, alignment: edit.layout?.alignment ?? 'left' as const };
  const long = edit.newText.length > 40, requiredHeight = edit.newText === '' ? 0 : long ? 60 : 12;
  const fits = input.rect.height >= requiredHeight || input.fontSize <= 8;
  return { input, page: { width: 400, height: 600 }, layout: { fits, requiredHeight, fontSize: input.fontSize, lineAdvance: input.fontSize * input.lineHeight, lines: edit.newText ? [{ text: edit.newText, x: input.rect.x, baseline: input.rect.y + 10, width: 90, paragraphEnd: true, glyphs: [] }] : [], inkBounds: null,
    warnings: ['A standard replacement font is used.'], ...(fits ? {} : { overflow: 'The text needs 60 points of height; no text was truncated.', suggestedFontSize: 8 }) } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.autoReady = true;
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  source = { data: new Uint8Array([1]).buffer, block: { id: 'original-block', pageNumber: 2, text: 'Original', rect: { x: 10, y: 20, width: 100, height: 20 }, style: { fontName: 'Source font', fontSize: 12, alignment: 'left', lineHeight: 1.2 }, editable: true, lines: [] },
    preview: vi.fn(async edit => new Uint8Array([9, edit.newText.length])) };
  api.prepare.mockImplementation(async (_data, block, edit) => prepared(block, edit));
  props = { documentKey: 'one', revision: 1, blockId: source.block.id, readPDF: vi.fn(async () => source), onSave: vi.fn(async () => {}), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(changes: Partial<TextLayoutDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<TextLayoutDialog {...props} />)); }
async function settle() { await act(async () => vi.advanceTimersByTimeAsync(300)); }
function button(name: string) { return [...host.querySelectorAll('button')].find(element => element.textContent === name)!; }
async function click(name: string) { await act(async () => button(name).click()); }
function field(name: string) { return [...host.querySelectorAll('label')].find(element => element.firstChild?.textContent === name)!.querySelector('input,textarea,select')! as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; }
async function fill(name: string, value: string) {
  const element = field(name), prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { element.focus(); Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
}
async function number(name: string, value: number) { await fill(name, String(value)); await act(async () => field(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); }
function latestPreview(): ComponentProps<typeof TextLayoutPreview> { return api.render.mock.calls.at(-1)![0]; }
async function escape() { await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))); }

describe('TextLayoutDialog', () => {
  it('uses resolved source style and the complete PDF preview without creating an unchanged draft', async () => {
    await render(); await settle();
    expect(field('Font').value).toBe('Times-Roman'); expect(field('Text color').value).toBe('#123456');
    expect(host.textContent).toContain('Preview ready'); expect(host.textContent).toContain('original removal area stays unchanged'); expect(button('Save draft').disabled).toBe(true);
    expect(api.prepare.mock.calls[0][0]).toBe(source.data); expect(latestPreview().pageNumber).toBe(2); expect(latestPreview().data).toEqual(new Uint8Array([9, 8]));
    expect(latestPreview().sourceRect).toEqual(source.block.rect); expect(props.onSave).not.toHaveBeenCalled();
  });
  it('reports overflow and fits height only after an explicit action', async () => {
    await render(); await settle(); await fill('Text', 'A long replacement paragraph. '.repeat(5)); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('needs 60 points'); expect(button('Save draft').disabled).toBe(true); expect(field('Height').value).toBe('20');
    expect(source.preview).toHaveBeenCalledTimes(1); await click('Fit height'); await settle();
    expect(field('Height').value).toBe('60'); expect(host.textContent).toContain('Preview ready'); expect(button('Save draft').disabled).toBe(false);
    await click('Save draft'); expect(props.onSave).toHaveBeenCalledTimes(1); expect(vi.mocked(props.onSave).mock.calls[0][0].layout?.targetRect).toEqual({ x: 10, y: 20, width: 100, height: 60 });
    expect(source.block.rect).toEqual({ x: 10, y: 20, width: 100, height: 20 });
  });
  it('shrinks only when requested and saves explicit font/alignment/color overrides', async () => {
    await render(); await settle(); await fill('Text', 'Long text '.repeat(12)); await settle(); await click('Shrink font to fit'); await settle();
    expect(field('Font size').value).toBe('8'); await fill('Alignment', 'justify'); await fill('Font', 'Helvetica-Bold'); await fill('Text color', '#334455'); await settle();
    await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].layout).toMatchObject({ fontSize: 8, alignment: 'justify', fontName: 'Helvetica-Bold', fontColor: '#334455' });
  });
  it('uses the explicit-layout height suggestion instead of the legacy baseline height', async () => {
    await render(); await settle();
    api.prepare.mockImplementationOnce(async (_data, block, edit) => { const value = prepared(block, edit); return { ...value, layout: { ...value.layout, suggestedHeight: 75.003 } }; });
    await fill('Text', 'Long text '.repeat(12)); await settle(); await click('Fit height'); await settle();
    expect(field('Height').value).toBe('75.01'); expect(button('Save draft').disabled).toBe(false);
  });
  it('resets an existing workspace edit to the source text with layout undefined', async () => {
    source.edit = { blockId: source.block.id, originalText: 'Original', newText: 'Edited', timestamp: 1, layout: { targetRect: { x: 30, y: 40, width: 150, height: 80 }, fontSize: 18 } };
    await render(); await settle(); expect(button('Save draft').disabled).toBe(true);
    await click('Reset to original'); await settle(); expect(field('Text').value).toBe('Original'); expect(field('X').value).toBe('10');
    await click('Save draft'); const operation = vi.mocked(props.onSave).mock.calls[0][0]; expect(operation.newText).toBe('Original'); expect(operation.layout).toBeUndefined();
  });
  it('discards uncommitted numeric input when resetting to the original', async () => {
    source.edit = { blockId: source.block.id, originalText: 'Original', newText: 'Edited', timestamp: 1, layout: { fontSize: 18 } };
    await render(); await settle(); await fill('Font size', '55'); expect(button('Save draft').disabled).toBe(true);
    await click('Reset to original'); await settle(); expect(field('Font size').value).toBe('12'); expect(host.textContent).not.toContain('Finish numeric input');
    await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].layout).toBeUndefined();
  });
  it('treats an empty text draft as a deletion', async () => {
    await render(); await settle(); await fill('Text', ''); await settle(); expect(button('Save draft').disabled).toBe(false);
    await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].newText).toBe('');
  });
  it('blocks Save for numeric input drafts and never saves stale values on click or Ctrl+S', async () => {
    await render(); await settle(); await fill('Text', 'Changed'); await settle(); expect(button('Save draft').disabled).toBe(false);
    await fill('Font size', '22'); expect(button('Save draft').disabled).toBe(true); expect(host.textContent).not.toContain('Preview ready'); await click('Save draft'); expect(props.onSave).not.toHaveBeenCalled();
    const shortcut = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }); await act(async () => field('Font size').dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true); expect(props.onSave).not.toHaveBeenCalled(); expect(button('Save draft').disabled).toBe(true); await settle();
    expect(button('Save draft').disabled).toBe(false); await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].layout?.fontSize).toBe(22);
  });
  it('waits for actual canvas rendering and blocks failed renders', async () => {
    api.autoReady = false; await render(); await settle(); await fill('Text', 'Changed'); await settle();
    expect(button('Save draft').disabled).toBe(true); expect(host.textContent).not.toContain('Preview ready');
    await act(async () => latestPreview().onReady?.()); expect(button('Save draft').disabled).toBe(false);
    await act(async () => latestPreview().onError('PDF preview rendering failed.')); expect(button('Save draft').disabled).toBe(true); expect(host.textContent).toContain('PDF preview rendering failed');
  });
  it('keeps source bounds immutable while dragging and postpones expensive previews until the gesture ends', async () => {
    await render(); await settle(); const calls = api.prepare.mock.calls.length;
    await act(async () => latestPreview().onInteractionChange(true));
    await act(async () => latestPreview().onChange({ x: 40, y: 50, width: 200, height: 90 })); await settle(); expect(api.prepare).toHaveBeenCalledTimes(calls);
    expect(latestPreview().sourceRect).toEqual({ x: 10, y: 20, width: 100, height: 20 });
    await act(async () => latestPreview().onInteractionChange(false)); await settle();
    expect(api.prepare).toHaveBeenCalledTimes(calls + 1); expect(latestPreview().targetRect).toEqual({ x: 40, y: 50, width: 200, height: 90 });
    await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].layout?.targetRect).toEqual({ x: 40, y: 50, width: 200, height: 90 });
  });
  it('ignores outdated measurements and actual PDF previews', async () => {
    let finish!: (value: Uint8Array) => void;
    await render(); await settle(); vi.mocked(source.preview).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await fill('Text', 'First'); await settle(); const oldSignal = vi.mocked(source.preview).mock.calls.at(-1)![1];
    await fill('Text', 'Latest'); await settle(); expect(oldSignal.aborted).toBe(true); expect(latestPreview().data).toEqual(new Uint8Array([9, 6]));
    await act(async () => finish(new Uint8Array([99]))); expect(latestPreview().data).toEqual(new Uint8Array([9, 6]));
    await click('Save draft'); expect(vi.mocked(props.onSave).mock.calls[0][0].newText).toBe('Latest');
  });
  it('aborts a previous document read and closes without saving unsaved changes', async () => {
    let finish!: (value: TextLayoutSource) => void;
    await render({ readPDF: vi.fn(() => new Promise(resolve => { finish = resolve; })) }); const oldSignal = vi.mocked(props.readPDF).mock.calls[0][0];
    await render({ documentKey: 'two', readPDF: vi.fn(async () => source) }); await act(async () => finish({ ...source, block: { ...source.block, text: 'OLD DOCUMENT' } })); await settle();
    expect(oldSignal.aborted).toBe(true); expect(field('Text').value).toBe('Original'); await fill('Text', 'Unsaved'); await escape();
    expect(props.onSave).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('shows read and worker errors with no silent fallback or partial save', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(source) }); expect(host.textContent).toContain('Read failed'); await click('Retry'); await settle();
    api.prepare.mockRejectedValueOnce(new Error('Complex script is unsupported.')); await fill('Text', 'Changed'); await settle();
    expect(host.textContent).toContain('Complex script is unsupported'); expect(button('Save draft').disabled).toBe(true); expect(props.onSave).not.toHaveBeenCalled();
    await fill('Text', 'Retry'); await settle(); expect(button('Save draft').disabled).toBe(false);
  });
  it('guards duplicate saves, permits cancel, and does not close again after the canceled save settles', async () => {
    let finish!: () => void;
    await render({ onSave: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }); await settle(); await number('Width', 180); await settle();
    const save = button('Save draft'); await act(async () => { save.click(); save.click(); }); expect(props.onSave).toHaveBeenCalledTimes(1);
    await escape(); expect(vi.mocked(props.onSave).mock.calls[0][1].aborted).toBe(true); await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('does not let an old revision\'s pending save close the newer session', async () => {
    let finish!: () => void;
    await render({ onSave: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) }); await settle(); await number('Width', 180); await settle(); await click('Save draft');
    const signal = vi.mocked(props.onSave).mock.calls[0][1]; await render({ revision: 2 }); await settle();
    expect(signal.aborted).toBe(true); await act(async () => finish()); expect(props.onClose).not.toHaveBeenCalled(); expect(field('Width').value).toBe('100'); expect(button('Save draft').disabled).toBe(true);
  });
});
