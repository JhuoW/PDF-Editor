// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FormLayer } from '../../src/components/PDFViewer/FormLayer';
import { useFormStore } from '../../src/store/formStore';
import type { FormField } from '../../src/forms/types';
import type { PDFPageProxy } from 'pdfjs-dist';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null;
let container: HTMLDivElement;

function widget(pageNumber: number, type: FormField['type'], value: FormField['value']): FormField {
  return {
    id: `widget-${pageNumber}`, name: 'shared', pageNumber, type, value,
    rect: { x: 10, y: 20, width: 100, height: 20 },
    required: false, readOnly: false, hidden: false,
    options: ['First', 'Second', 'Third'].map(option => ({ label: option, value: option })),
  };
}

function pdfPage(rotate = 0, unit = 1): PDFPageProxy {
  return {
    rotate,
    getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => ({
      convertToPdfPoint: (x: number, y: number) => [x / scale / unit + 50, 40 + 800 / unit - y / scale / unit],
      convertToViewportPoint: (pdfX: number, pdfY: number) => {
        const x = (pdfX - 50) * unit;
        const y = 800 - (pdfY - 40) * unit;
        const [left, top] = rotation === 90 ? [800 - y, x] : rotation === 180 ? [600 - x, 800 - y] : rotation === 270 ? [y, 600 - x] : [x, y];
        return [left * scale, top * scale];
      },
    }),
  } as unknown as PDFPageProxy;
}

async function renderFields(fields: FormField[], rotation = 0, scale = 1, page = pdfPage()) {
  useFormStore.getState().setFields(fields);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<>
      <FormLayer page={page} pageNumber={1} scale={scale} rotation={rotation} />
      <FormLayer page={page} pageNumber={2} scale={scale} rotation={rotation} />
    </>);
  });
}

beforeEach(() => {
  root = null;
  useFormStore.setState(useFormStore.getInitialState(), true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe('shared PDF form widget interactions', () => {
  it('maps crop offsets and UserUnit through both viewports and adds the native page rotation', async () => {
    await renderFields([widget(1, 'text', 'positioned')], 90, 2, pdfPage(90, 2));
    const input = container.querySelector<HTMLInputElement>('input')!;
    expect(input.style.left).toBe('980px');
    expect(input.style.top).toBe('1520px');
    expect(input.style.width).toBe('200px');
    expect(input.style.height).toBe('40px');
  });
  it.each([
    [90, 1440, 100, 200, 40],
    [180, 980, 1520, 200, 40],
    [270, -40, 1060, 200, 40],
  ])('positions widgets correctly at %i degrees of clockwise rotation', async (rotation, left, top, width, height) => {
    await renderFields([widget(1, 'text', 'positioned')], rotation, 2);
    const input = container.querySelector<HTMLInputElement>('input')!;
    expect(input.style.left).toBe(`${left}px`);
    expect(input.style.top).toBe(`${top}px`);
    expect(input.style.width).toBe(`${width}px`);
    expect(input.style.height).toBe(`${height}px`);
    expect(input.style.transform).toBe(`rotate(${rotation}deg)`);
  });

  it('checks only the selected radio option and keeps every widget value synchronized', async () => {
    await renderFields([
      { ...widget(1, 'radio', 'First'), radioGroup: 'shared', exportValue: 'First' },
      { ...widget(2, 'radio', 'First'), radioGroup: 'shared', exportValue: 'Second' },
    ]);
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(input => input.checked)).toEqual([true, false]);

    await act(async () => radios[1].click());
    expect(radios.map(input => input.checked)).toEqual([false, true]);
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual(['Second', 'Second']);
    expect(useFormStore.getState().getModifiedFields()).toEqual(new Map([['shared', 'Second']]));

    await act(async () => useFormStore.getState().setFieldValueByName('shared', ''));
    expect(radios.map(input => input.checked)).toEqual([false, false]);
  });

  it('updates all text widgets sharing the same field name', async () => {
    await renderFields([widget(1, 'text', 'before'), widget(2, 'text', 'before')]);
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], 'after');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(inputs.map(input => input.value)).toEqual(['after', 'after']);
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual(['after', 'after']);
  });

  it('checks and unchecks every checkbox widget belonging to the same field', async () => {
    await renderFields([widget(1, 'checkbox', false), widget(2, 'checkbox', false)]);
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => checkboxes[0].click());
    expect(checkboxes.map(input => input.checked)).toEqual([true, true]);
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual([true, true]);

    await act(async () => checkboxes[1].click());
    expect(checkboxes.map(input => input.checked)).toEqual([false, false]);
    expect(useFormStore.getState().isDirty).toBe(false);
  });

  it.each(['listbox', 'dropdown'] as const)('preserves all %s selections across shared widgets, including clearing', async type => {
    await renderFields([widget(1, type, ['First', 'Second']), widget(2, type, ['First', 'Second'])]);
    const selects = [...container.querySelectorAll('select')];
    expect(selects.every(select => select.multiple)).toBe(true);
    expect(Array.from(selects[0].selectedOptions, option => option.value)).toEqual(['First', 'Second']);

    await act(async () => {
      for (const option of selects[0].options) option.selected = option.value !== 'First';
      selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual([
      ['Second', 'Third'], ['Second', 'Third'],
    ]);
    expect(Array.from(selects[1].selectedOptions, option => option.value)).toEqual(['Second', 'Third']);

    await act(async () => {
      for (const option of selects[1].options) option.selected = false;
      selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual([[], []]);
    expect(selects.every(select => select.multiple && select.selectedOptions.length === 0)).toBe(true);
  });

  it('uses the native single-select list flag while keeping shared widgets synchronized', async () => {
    await renderFields([1, 2].map(page => ({ ...widget(page, 'listbox', ['First']), multiSelect: false })));
    const selects = [...container.querySelectorAll('select')];
    expect(selects.every(select => !select.multiple && select.size >= 2)).toBe(true);
    await act(async () => {
      selects[0].value = 'Second';
      selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual([['Second'], ['Second']]);
    expect(selects.map(select => select.value)).toEqual(['Second', 'Second']);
    await act(async () => useFormStore.getState().setFieldValueByName('shared', []));
    expect(selects.every(select => select.selectedIndex === -1)).toBe(true);
  });

  it('respects an explicit multi-select flag even when a restored dropdown value is scalar', async () => {
    await renderFields([{ ...widget(1, 'dropdown', 'First'), multiSelect: true }]);
    const select = container.querySelector('select')!;
    expect(select.multiple).toBe(true);
    expect(Array.from(select.selectedOptions, option => option.value)).toEqual(['First']);
  });

  it('keeps single dropdowns scalar while synchronizing their other widgets', async () => {
    await renderFields([widget(1, 'dropdown', 'First'), widget(2, 'dropdown', 'First')]);
    const selects = [...container.querySelectorAll('select')];
    expect(selects.every(select => !select.multiple)).toBe(true);
    await act(async () => {
      selects[0].value = 'Second';
      selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(selects.map(select => select.value)).toEqual(['Second', 'Second']);
    expect(useFormStore.getState().fields.map(field => field.value)).toEqual(['Second', 'Second']);
  });
});
