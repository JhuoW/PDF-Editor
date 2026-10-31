// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormDesignerDialog, type FormDesignerDialogProps } from '../../src/components/Dialogs/FormDesignerDialog';
import type { FormDesignerPreview } from '../../src/components/Dialogs/FormDesignerPreview';
import type { FormDesignDocument } from '../../src/forms/FormDesignerTypes';
import { makeDesignField } from '../../src/components/Dialogs/formDesignDraft';

const api = vi.hoisted(() => ({ inspectFormDesign: vi.fn(), getDocument: vi.fn(), destroy: vi.fn() }));
vi.mock('../../src/forms/FormDesigner', () => ({ inspectFormDesign: api.inspectFormDesign }));
vi.mock('../../src/utils/pdfConfig', () => ({ pdfDocumentOptions: {}, pdfjsLib: { getDocument: api.getDocument } }));
vi.mock('../../src/components/Dialogs/FormDesignerPreview', () => ({ FormDesignerPreview: ({ onCreate, onSelect, fields }: ComponentProps<typeof FormDesignerPreview>) => <div>
  <button onClick={() => onCreate('text', 1, { x: 20, y: 40, width: 180, height: 30 })}>Draw text field</button>
  {fields.map(field => <button key={field.id} onClick={() => onSelect({ fieldId: field.id, widgetId: field.widgets[0]?.id ?? '' })}>Choose {field.name}</button>)}
</div> }));
let root: Root, host: HTMLDivElement, props: FormDesignerDialogProps, design: FormDesignDocument;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  api.destroy.mockResolvedValue(undefined);
  api.getDocument.mockImplementation(() => ({ promise: Promise.resolve({ numPages: 2 }), destroy: api.destroy }));
  design = { pages: [{ pageNumber: 1, width: 400, height: 600 }, { pageNumber: 2, width: 300, height: 500 }], fields: [], canEdit: true };
  api.inspectFormDesign.mockImplementation(async () => structuredClone(design));
  props = { documentKey: 'first', revision: 1, currentPage: 1, readPDF: vi.fn(async () => new Uint8Array([1]).buffer), onSave: vi.fn(async (_operations, _signal, commit) => { commit(); }), onClose: vi.fn() };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(changes: Partial<FormDesignerDialogProps> = {}) { props = { ...props, ...changes }; await act(async () => root.render(<FormDesignerDialog {...props} />)); }
function button(text: string) { return [...host.querySelectorAll('button')].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function fill(label: string, text: string) {
  const input = [...host.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function escape() { const event = new Event('cancel', { cancelable: true }); await act(async () => host.querySelector('dialog')!.dispatchEvent(event)); expect(event.defaultPrevented).toBe(true); }

describe('FormDesignerDialog', () => {
  it('opens a modal and creates only a local draft until save commits one native form operation', async () => {
    await render(); expect(host.querySelector('dialog')?.open).toBe(true);
    expect(button('Save form design').disabled).toBe(true);
    await click('Draw text field'); await fill('Field name', 'Applicant'); await fill('Current value', '中文姓名');
    expect(props.onSave).not.toHaveBeenCalled();
    await click('Save form design');
    expect(props.onSave).toHaveBeenCalledWith([{ type: 'create-field', field: expect.objectContaining({ name: 'Applicant', type: 'text', value: '中文姓名' }) }], expect.any(AbortSignal), expect.any(Function));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('supports shared-widget property changes and numeric drafts without prematurely navigating', async () => {
    const field = makeDesignField('text', 1, { x: 10, y: 20, width: 100, height: 30 }, []); field.id = 'native-field';
    field.widgets.push({ ...field.widgets[0], id: 'second', pageNumber: 2 }); design.fields = [field];
    await render(); await click(`Choose ${field.name}`);
    await fill('Left', '');
    expect(button('Save form design').disabled).toBe(true);
    await fill('Left', '125');
    const input = [...host.querySelectorAll('label')].find(item => item.textContent === 'Left')!.querySelector('input')!;
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await fill('Field name', 'Renamed');
    await click('Save form design');
    const operations = vi.mocked(props.onSave).mock.calls[0][0];
    expect(operations).toContainEqual({ type: 'update-widget', fieldId: field.id, widgetId: field.widgets[0].id, patch: { pageNumber: 1, rect: { x: 125, y: 20, width: 100, height: 30 }, hidden: false } });
    expect(operations).toContainEqual({ type: 'update-field', fieldId: field.id, patch: { name: 'Renamed' } });
    expect(operations).toHaveLength(2);
  });

  it('flushes a focused numeric draft before Ctrl+S even when it is the only change', async () => {
    const field = makeDesignField('text', 1, { x: 10, y: 20, width: 100, height: 30 }, []); design.fields = [field];
    await render(); await click(`Choose ${field.name}`);
    const input = [...host.querySelectorAll('label')].find(item => item.textContent === 'Width')!.querySelector('input')!;
    await act(async () => input.focus()); await fill('Width', '175');
    expect(button('Save form design').disabled).toBe(true);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(props.onSave).toHaveBeenCalledWith([{ type: 'update-widget', fieldId: field.id, widgetId: field.widgets[0].id, patch: { pageNumber: 1, rect: { x: 10, y: 20, width: 175, height: 30 }, hidden: false } }], expect.any(AbortSignal), expect.any(Function));
  });

  it('keeps an orphaned widget inspectable without navigating to page zero or rendering invalid geometry', async () => {
    const field = makeDesignField('text', 1, { x: 10, y: 20, width: 100, height: 30 }, []);
    field.widgets[0].pageNumber = 0; field.supported = false; field.unsupportedReason = 'This widget has no valid page.'; design.fields = [field];
    await render(); await click(`Choose ${field.name}`);
    expect(host.textContent).toContain('This widget has no valid page');
    expect([...host.querySelectorAll('label')].find(item => item.textContent?.startsWith('Preview page'))!.querySelector('select')!.value).toBe('1');
    expect(host.querySelector('.form-designer-properties')).toBeNull();
    expect(button('Save form design').disabled).toBe(true);
  });

  it('isolates numeric drafts when selecting another field with the same original number', async () => {
    const first = makeDesignField('text', 1, { x: 10, y: 20, width: 100, height: 30 }, []);
    const second = makeDesignField('text', 1, { x: 10, y: 90, width: 100, height: 30 }, [first]); design.fields = [first, second];
    await render(); await click(`Choose ${first.name}`); await fill('Font size', '50');
    await click(`Choose ${second.name}`);
    const font = [...host.querySelectorAll('label')].find(item => item.textContent === 'Font size')!.querySelector('input')!;
    expect(font.value).toBe('12');
    await act(async () => { font.focus(); font.blur(); });
    expect(button('Save form design').disabled).toBe(true);
  });

  it('edits custom multiple dropdown values as arrays and preserves literal commas in current and default values', async () => {
    const field = makeDesignField('dropdown', 1, { x: 10, y: 20, width: 100, height: 30 }, []);
    Object.assign(field, { multiSelect: true, allowCustomValue: true, value: ['a', 'b'], defaultValue: ['a'] }); design.fields = [field];
    await render(); await click(`Choose ${field.name}`);
    const inputs = [...host.querySelectorAll('textarea')]; expect(inputs[0].value).toBe('a\nb');
    for (const [index, text] of ['a\nb\ncustom, value\n', 'a\ndefault, value'].entries()) {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(inputs[index], text); inputs[index].dispatchEvent(new Event('input', { bubbles: true })); });
    }
    await act(async () => inputs[0].focus());
    await act(async () => inputs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toEqual([{ type: 'update-field', fieldId: field.id, patch: { value: ['a', 'b', 'custom, value'], defaultValue: ['a', 'default, value'] } }]);
  });

  it('preserves selected choice semantics when an export value is renamed and exposes only supported appearance controls', async () => {
    const field = makeDesignField('dropdown', 1, { x: 10, y: 20, width: 100, height: 30 }, []); field.value = 'option1'; field.defaultValue = 'option1'; design.fields = [field];
    await render(); await click(`Choose ${field.name}`); await fill('Value 1', 'cn');
    const value = [...host.querySelectorAll('label')].find(item => item.textContent?.startsWith('Current value'))!.querySelector('select')!;
    expect(value.value).toBe('cn');
    expect([...host.querySelectorAll('label')].some(item => item.textContent?.startsWith('Text alignment'))).toBe(false);
    expect([...host.querySelectorAll('label')].find(item => item.textContent === 'Font size')!.querySelector('input')!.max).toBe('144');
    await click('Save form design');
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toContainEqual({ type: 'update-field', fieldId: field.id, patch: { options: [{ label: 'Option 1', value: 'cn' }, { label: 'Option 2', value: 'option2' }], value: 'cn', defaultValue: 'cn' } });
  });

  it('keeps restricted documents and unsupported field types read-only', async () => {
    const field = makeDesignField('text', 1, { x: 10, y: 20, width: 100, height: 30 }, []);
    design.fields = [{ ...field, type: 'signature', supported: false, unsupportedReason: 'Signature fields are read only.' }];
    await render(); await click(`Choose ${field.name}`);
    expect(host.textContent).toContain('Signature fields are read only');
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(button('Save form design').disabled).toBe(true);
    design = { ...design, canEdit: false, unsupportedReason: 'XFA forms are not supported.' };
    await render({ revision: 2 });
    expect(host.textContent).toContain('XFA forms are not supported');
    expect(button('Text field').disabled).toBe(true);
  });

  it('shows read failures with retry and keeps the draft when a save fails', async () => {
    await render({ readPDF: vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue(new Uint8Array([1]).buffer) });
    expect(host.textContent).toContain('Read failed'); await click('Retry'); await click('Draw text field');
    vi.mocked(props.onSave).mockRejectedValueOnce(new Error('Duplicate field name'));
    await click('Save form design');
    expect(host.querySelector('[role="alert"] .diagnostic-summary')?.textContent).toBe('Duplicate field name');
    expect(button('Save form design').disabled).toBe(false);
    expect(host.textContent).toContain('Field properties');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('blocks duplicate saves and aborts before closing, while atomic commit cannot be canceled', async () => {
    let finish!: () => void;
    await render({ onSave: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    await click('Draw text field'); await click('Save form design'); await click('Save form design');
    expect(props.onSave).toHaveBeenCalledTimes(1);
    await escape();
    expect(vi.mocked(props.onSave).mock.calls[0][1].aborted).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
    await render({ documentKey: 'next', onClose: vi.fn(), onSave: vi.fn((_ops, _signal, commit) => { commit(); return new Promise<void>(resolve => { finish = resolve; }); }) });
    await click('Draw text field'); await click('Save form design'); await escape();
    expect(vi.mocked(props.onSave).mock.calls[0][1].aborted).toBe(false);
    expect(button('Discard changes').disabled).toBe(true);
    await act(async () => finish()); expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('discards stale reads and refuses old saves before their caller commits to another document', async () => {
    let finishRead!: (value: ArrayBuffer) => void;
    await render({ readPDF: vi.fn(() => new Promise(resolve => { finishRead = resolve; })) });
    await render({ documentKey: 'new', readPDF: vi.fn(async () => new Uint8Array([2]).buffer) });
    await act(async () => finishRead(new Uint8Array([1]).buffer));
    expect(api.inspectFormDesign).toHaveBeenCalledTimes(1);
    let finishSave!: () => void;
    const committed = vi.fn();
    await render({ onSave: async (_ops, _signal, commit) => { await new Promise<void>(resolve => { finishSave = resolve; }); commit(); committed(); } });
    await click('Draw text field'); await click('Save form design');
    await render({ documentKey: 'replacement' });
    await act(async () => finishSave());
    expect(committed).not.toHaveBeenCalled();
    expect(button('Save form design').disabled).toBe(true);
  });
});
