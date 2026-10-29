import type { DesignableFieldType, FormDesignField, FormDesignFieldPatch, FormDesignOperation, FormDesignWidget, NewFormDesignWidget } from '../../forms/FormDesignerTypes';
import type { FormFieldRect } from '../../forms/types';

export const designFieldLabels: Record<DesignableFieldType, string> = { text: 'Text field', checkbox: 'Checkbox', radio: 'Radio group', dropdown: 'Dropdown', listbox: 'List box' };
export const defaultFieldSize: Record<DesignableFieldType, [number, number]> = { text: [180, 28], checkbox: [20, 20], radio: [20, 20], dropdown: [180, 28], listbox: [180, 90] };
export const newDesignId = () => `new-${crypto.randomUUID()}`;

export function fitDesignRect(rect: FormFieldRect, width: number, height: number): FormFieldRect {
  const w = Math.max(Math.min(4, width), Math.min(width, rect.width));
  const h = Math.max(Math.min(4, height), Math.min(height, rect.height));
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(Math.max(0, Math.min(width - w, rect.x))), y: round(Math.max(0, Math.min(height - h, rect.y))), width: round(w), height: round(h) };
}

export function makeDesignField(type: DesignableFieldType, pageNumber: number, rect: FormFieldRect, existing: FormDesignField[]): FormDesignField {
  const stem = type === 'text' ? 'Text' : type === 'listbox' ? 'List' : type === 'radio' ? 'Radio' : type === 'checkbox' ? 'Checkbox' : 'Dropdown';
  let number = 1;
  while (existing.some(field => field.name === `${stem}${number}`)) number++;
  return {
    id: newDesignId(), name: `${stem}${number}`, type, supported: true, required: false, readOnly: false,
    value: type === 'checkbox' ? false : type === 'listbox' ? [] : '',
    defaultValue: type === 'checkbox' ? false : type === 'listbox' ? [] : '',
    widgets: [{ id: newDesignId(), pageNumber, rect, hidden: false, ...(type === 'radio' ? { optionValue: 'Option1' } : {}) }],
    ...(type === 'text' ? { multiline: false, fontSize: 12, textAlign: 'left' as const } : {}),
    ...(type === 'dropdown' || type === 'listbox' ? { options: [{ label: 'Option 1', value: 'option1' }, { label: 'Option 2', value: 'option2' }], multiSelect: false, fontSize: 12 } : {}),
  };
}

const patchKeys = ['name', 'required', 'readOnly', 'value', 'defaultValue', 'options', 'multiSelect', 'allowCustomValue', 'fontSize', 'textAlign', 'multiline', 'maxLength'] as const;
function fieldProperties(field: FormDesignField): FormDesignFieldPatch {
  return Object.fromEntries(patchKeys.filter(key => field[key] !== undefined && (key !== 'options' || field.type === 'dropdown' || field.type === 'listbox')).map(key => [key, structuredClone(field[key])])) as FormDesignFieldPatch;
}
function widgetProperties(widget: FormDesignWidget): NewFormDesignWidget {
  return { pageNumber: widget.pageNumber, rect: { ...widget.rect }, hidden: widget.hidden, ...(widget.optionValue !== undefined ? { optionValue: widget.optionValue } : {}) };
}
const equal = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);

/** A modal edits a draft; saving produces one native-form operation batch. */
export function buildFormDesignOperations(original: FormDesignField[], fields: FormDesignField[]): FormDesignOperation[] {
  const operations: FormDesignOperation[] = [];
  const originals = new Map(original.map(field => [field.id, field]));
  for (const field of original) if (!fields.some(next => next.id === field.id)) operations.push({ type: 'delete-field', fieldId: field.id });
  for (const field of fields) {
    const before = originals.get(field.id);
    if (!before) {
      operations.push({ type: 'create-field', field: { ...fieldProperties(field), name: field.name, type: field.type as DesignableFieldType, widgets: field.widgets.map(widgetProperties) } });
      continue;
    }
    for (const widget of before.widgets) if (!field.widgets.some(next => next.id === widget.id)) operations.push({ type: 'delete-widget', fieldId: field.id, widgetId: widget.id });
    for (const widget of field.widgets) {
      const old = before.widgets.find(item => item.id === widget.id);
      if (!old) operations.push({ type: 'add-widget', fieldId: field.id, widget: widgetProperties(widget) });
      else if (!equal(widgetProperties(widget), widgetProperties(old))) operations.push({ type: 'update-widget', fieldId: field.id, widgetId: widget.id, patch: widgetProperties(widget) });
    }
    const beforeProperties = fieldProperties(before), afterProperties = fieldProperties(field);
    const patch = Object.fromEntries(Object.entries(afterProperties).filter(([key, value]) => !equal(value, beforeProperties[key as keyof FormDesignFieldPatch]))) as FormDesignFieldPatch;
    if (Object.keys(patch).length) operations.push({ type: 'update-field', fieldId: field.id, patch });
  }
  return operations;
}
