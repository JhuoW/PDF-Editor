import { describe, expect, it } from 'vitest';
import { buildFormDesignOperations, fitDesignRect, makeDesignField } from '../../src/components/Dialogs/formDesignDraft';

const rect = { x: 10, y: 20, width: 100, height: 30 };
describe('form design draft operations', () => {
  it('makes unique field names and native creation batches without draft IDs', () => {
    const first = makeDesignField('text', 1, rect, []), second = makeDesignField('text', 2, rect, [first]);
    expect(first.name).toBe('Text1'); expect(second.name).toBe('Text2');
    const operations = buildFormDesignOperations([], [first, second]);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual({ type: 'create-field', field: expect.objectContaining({ type: 'text', name: 'Text1', widgets: [{ pageNumber: 1, rect, hidden: false }] }) });
    expect(JSON.stringify(operations)).not.toContain(first.id);
  });

  it('edits a shared field once while targeting only the changed or removed widget', () => {
    const field = makeDesignField('text', 1, rect, []); field.id = '12 0 R'; field.widgets[0].id = '13 0 R';
    field.widgets.push({ ...field.widgets[0], id: '14 0 R', pageNumber: 2 });
    const updated = structuredClone(field); updated.name = 'Renamed'; updated.value = 'Keep filled value';
    updated.widgets = [{ ...updated.widgets[0], pageNumber: 2, rect: { ...rect, width: 150 } }];
    expect(buildFormDesignOperations([field], [updated])).toEqual([
      { type: 'delete-widget', fieldId: field.id, widgetId: '14 0 R' },
      { type: 'update-widget', fieldId: field.id, widgetId: '13 0 R', patch: { pageNumber: 2, rect: { ...rect, width: 150 }, hidden: false } },
      { type: 'update-field', fieldId: field.id, patch: { name: 'Renamed', value: 'Keep filled value' } },
    ]);
    expect(buildFormDesignOperations([field], [])).toEqual([{ type: 'delete-field', fieldId: field.id }]);
    expect(field.widgets).toHaveLength(2);
  });

  it('adds radio choices without inventing separate logical fields and retains choice export values', () => {
    const radio = makeDesignField('radio', 1, rect, []);
    const updated = structuredClone(radio);
    updated.widgets.push({ ...updated.widgets[0], id: 'new-choice', optionValue: 'ChoiceB', pageNumber: 2 }); updated.value = 'ChoiceB';
    expect(buildFormDesignOperations([radio], [updated])).toEqual([
      { type: 'add-widget', fieldId: radio.id, widget: { pageNumber: 2, rect, hidden: false, optionValue: 'ChoiceB' } },
      { type: 'update-field', fieldId: radio.id, patch: { value: 'ChoiceB' } },
    ]);
    const choice = makeDesignField('dropdown', 1, rect, []);
    choice.options = [{ label: '中国', value: 'cn' }]; choice.value = 'cn';
    expect(buildFormDesignOperations([], [choice])[0]).toEqual({ type: 'create-field', field: expect.objectContaining({ options: [{ label: '中国', value: 'cn' }], value: 'cn', multiSelect: false }) });
  });

  it('does not manufacture edits for an unchanged draft, and bounds geometry inside a visible page', () => {
    const field = makeDesignField('checkbox', 1, rect, []);
    expect(buildFormDesignOperations([field], [structuredClone(field)])).toEqual([]);
    expect(fitDesignRect({ x: -20, y: 390, width: 800, height: 50 }, 300, 400)).toEqual({ x: 0, y: 350, width: 300, height: 50 });
  });
});
