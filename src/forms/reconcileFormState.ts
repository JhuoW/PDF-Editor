import type { FormField } from './types';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';

/** Keep unsaved values while refreshing widget positions/options after page edits. */
export function reconcileFormState(
  previous: WorkspaceSnapshot['form'],
  fields: FormField[],
): WorkspaceSnapshot['form'] {
  const previousFields = new Map(previous.fields.map(field => [field.id, field]));
  const originalValues = new Map<string, string | boolean | string[]>();
  const updated = fields.map(field => {
    const old = previousFields.get(field.id);
    let value = old?.value ?? field.value;
    if (field.options && !field.allowCustomValue && (field.type === 'radio' || field.type === 'dropdown' || field.type === 'listbox')) {
      const allowed = new Set(field.options.map(option => option.value));
      value = Array.isArray(value) ? value.filter(option => allowed.has(option))
        : typeof value === 'string' && allowed.has(value) ? value : field.type === 'listbox' ? [] : '';
    }
    originalValues.set(field.id, previous.originalValues.has(field.id)
      ? previous.originalValues.get(field.id)! : field.value);
    return { ...field, value };
  });
  return {
    fields: updated,
    originalValues,
    isDirty: updated.some(field => JSON.stringify(field.value) !== JSON.stringify(originalValues.get(field.id))),
  };
}
