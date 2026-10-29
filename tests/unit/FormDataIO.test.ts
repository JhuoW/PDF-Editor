// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { FormField } from '../../src/forms/types';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { reconcileFormState } from '../../src/forms/reconcileFormState';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { exportToJSON, importFromJSON, exportToFDF, importFromFDF, exportToXFDF, importFromXFDF, normalizeImportedFormValues } from '../../src/forms/FormDataIO';

const field = (name: string, value: FormField['value'], type: FormField['type'] = 'text'): FormField => ({
  id: name, name, value, type, pageNumber: 1, rect: { x: 0, y: 0, width: 100, height: 20 },
  required: false, readOnly: false, hidden: false,
});

describe('form data exchange', () => {
  const fields = [field('姓名 (name)\\file', '中文 😀\nPath \\n (draft)'), field('Empty', ''),
    field('Checked', true, 'checkbox'), field('Unchecked', false, 'checkbox'),
    field('Choices', ['一', 'two'], 'listbox'), field('No choices', [], 'listbox'), field('Literal Off', 'Off'),
    field('__proto__', 'ordinary field')];

  it('JSON retains empty values, unchecked boxes, arrays, and property-like field names', () => {
    const values = importFromJSON(exportToJSON(fields));
    expect([...values]).toEqual(fields.map(item => [item.name, item.value]));
    expect({}.toString).toBe(Object.prototype.toString);
  });

  it.each(['null', '{}', '{"fields":null}', '{"fields":{"Bad":{"value":"text"}}}', '{"fields":{"Bad":[1]}}'])('rejects malformed JSON schema %s', source => {
    expect(() => importFromJSON(source)).toThrow();
  });

  it('FDF uses Unicode PDF strings and preserves explicit clearing values', async () => {
    const source = exportToFDF(fields, { pdfFileName: '合同.pdf' });
    expect(source).toContain('<FEFF');
    expect(source).toContain('/V /Off');
    expect([...normalizeImportedFormValues(fields, await importFromFDF(source))]).toEqual(fields.map(item => [item.name, item.value]));
  });

  it('parses nested, indirect, escaped literal and octal FDF values', async () => {
    const source = String.raw`%FDF-1.2
1 0 obj << /FDF << /Fields [2 0 R] >> >> endobj
2 0 obj << /T (person) /Kids [3 0 R] >> endobj
3 0 obj << /T (first\(name\)) /V (line\nback\\tail\053) >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
    expect([...(await importFromFDF(source))]).toEqual([['person.first(name)', 'line\nback\\tail+']]);
  });

  it('rejects circular FDF field trees and unrelated documents', async () => {
    const cyclic = '%FDF-1.2\n1 0 obj << /FDF << /Fields [2 0 R] >> >> endobj\n2 0 obj << /T (loop) /Kids [2 0 R] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF';
    await expect(importFromFDF(cyclic)).rejects.toThrow('circular');
    await expect(importFromFDF('not a form')).rejects.toThrow('header');
  });

  it('XFDF distinguishes text Off from unchecked fields and retains empty multiselects', () => {
    expect([...normalizeImportedFormValues(fields, importFromXFDF(exportToXFDF(fields)))])
      .toEqual(fields.map(item => [item.name, item.value]));
  });

  it('reads hierarchical XFDF fields without assigning child values to their parent', () => {
    const result = importFromXFDF('<xfdf xmlns="http://ns.adobe.com/xfdf/"><fields><field name="person"><field name="name"><value>Yes</value></field><field name="notes"><value>&lt;中文&gt;</value></field></field></fields></xfdf>');
    expect([...result]).toEqual([['person.name', 'Yes'], ['person.notes', '<中文>']]);
    expect(() => importFromXFDF('<document><field name="fake"/></document>')).toThrow();
  });

  it('maps real native radio appearance names to export labels in both directions', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const radio = pdf.getForm().createRadioGroup('Group');
    radio.addOptionToPage('First', page, { x: 10, y: 100, width: 20, height: 20 });
    radio.addOptionToPage('Second', page, { x: 40, y: 100, width: 20, height: 20 });
    radio.select('Second');
    const extracted = await extractFormFields(new Uint8Array(await pdf.save()).buffer);
    const raw = await importFromFDF(exportToFDF(extracted));
    expect(raw.get('Group')).toBe(radio.acroField.getValue().decodeText());
    expect(normalizeImportedFormValues(extracted, raw).get('Group')).toBe('Second');
    expect(normalizeImportedFormValues(extracted, importFromXFDF(exportToXFDF(extracted))).get('Group')).toBe('Second');
  });

  it('validates known values before applying them and skips read-only or unknown fields', () => {
    const target = [field('Name', ''), { ...field('Check', false, 'checkbox'), exportValue: 'Accepted' }, { ...field('Locked', 'Original'), readOnly: true }];
    expect(() => normalizeImportedFormValues(target, new Map<string, FormField['value']>([['Name', 'New'], ['Check', 'Invalid']]))).toThrow('Check');
    expect([...normalizeImportedFormValues(target, new Map([['Name', 'Off'], ['Check', 'Accepted'], ['Locked', 'Changed'], ['Unknown', 'Ignored']]))])
      .toEqual([['Name', 'Off'], ['Check', true]]);
  });

  it('keeps a logical JSON radio label named Off distinct from the native cleared state', () => {
    const radio = { ...field('Mode', 'Off', 'radio'), exportValue: 'Off', appearanceValue: '0' };
    const input = importFromJSON(exportToJSON([radio]));
    expect(normalizeImportedFormValues([radio], input, false).get('Mode')).toBe('Off');
    expect(normalizeImportedFormValues([radio], new Map([['Mode', 'Off']])).get('Mode')).toBe('');
  });

  it('retains a multiselect dropdown when XFDF contains just one value', () => {
    const target = [field('Multiple', [], 'dropdown'), field('Single', '', 'dropdown')];
    expect(normalizeImportedFormValues(target, new Map([['Multiple', 'one']])).get('Multiple')).toEqual(['one']);
    expect(normalizeImportedFormValues(target, new Map([['Single', []]])).get('Single')).toBe('');
    expect(() => normalizeImportedFormValues(target, new Map([['Single', ['one', 'two']]]))).toThrow('only one');
  });

  it.each(['dropdown', 'listbox'] as const)('rejects imports with multiple values for native single-select %s fields', type => {
    const target = { ...field('Single', ['one'], type), multiSelect: false };
    expect(() => normalizeImportedFormValues([target], new Map([['Single', ['one', 'two']]]))).toThrow('only one');
    expect(normalizeImportedFormValues([target], new Map([['Single', ['two']]])).get('Single')).toEqual(type === 'listbox' ? ['two'] : 'two');
    expect(normalizeImportedFormValues([target], new Map([['Single', []]])).get('Single')).toEqual(type === 'listbox' ? [] : '');
    const multiple = { ...target, multiSelect: true };
    expect(normalizeImportedFormValues([multiple], new Map([['Single', 'two']])).get('Single')).toEqual(['two']);
  });

  it('validates predefined choices and retains custom dropdown entries through page operations', () => {
    const fixed = { ...field('Fixed', '', 'dropdown'), options: [{ label: 'One', value: '1' }] };
    expect(normalizeImportedFormValues([fixed], new Map([['Fixed', 'One']])).get('Fixed')).toBe('1');
    expect(() => normalizeImportedFormValues([fixed], new Map([['Fixed', 'Other']]))).toThrow('Unknown option');
    const custom = { ...field('Custom', 'Typed value', 'dropdown'), options: [{ label: 'One', value: '1' }], allowCustomValue: true };
    expect(normalizeImportedFormValues([custom], new Map([['Custom', 'Other']])).get('Custom')).toBe('Other');
    const previous = createWorkspace([custom]).form;
    expect(reconcileFormState(previous, [{ ...custom, pageNumber: 2, value: '' }]).fields[0].value).toBe('Typed value');
  });

  it('rejects overlong imports before a value can enter a constrained text field', () => {
    const target = { ...field('Code', 'Old'), maxLength: 3 };
    expect(() => normalizeImportedFormValues([target], new Map([['Code', 'TOOLONG']]))).toThrow('at most 3');
    expect(target.value).toBe('Old');
    expect(normalizeImportedFormValues([target], new Map([['Code', 'ABC']])).get('Code')).toBe('ABC');
  });
});
