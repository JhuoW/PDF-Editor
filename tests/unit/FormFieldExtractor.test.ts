import { describe, expect, it } from 'vitest';
import { AnnotationFlags, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { extractFormFields, updateFormFieldValues } from '../../src/forms/FormFieldExtractor';

const asBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const position = { x: 10, y: 20, width: 100, height: 20, borderWidth: 0 };

describe('form field extraction and updates', () => {
  it('matches the unrotated PDF.js viewport for cropped, rotated, scaled pages', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 800]);
    page.setCropBox(50, 100, 400, 500);
    page.setRotation(degrees(90));
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const field = pdf.getForm().createTextField('positioned');
    field.addToPage(page, {
      x: 70, y: 500, width: 100, height: 30, borderWidth: 0,
    });
    field.setFontSize(12);
    const fields = await extractFormFields(asBuffer(await pdf.save()));
    expect(fields[0].rect).toEqual({ x: 40, y: 140, width: 200, height: 60 });
    expect(fields[0].fontSize).toBe(24);
  });

  it('intersects CropBox with MediaBox and ignores invalid UserUnit values', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 800]);
    page.setCropBox(-50, 100, 700, 800);
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(-2));
    pdf.getForm().createTextField('positioned').addToPage(page, position);
    expect((await extractFormFields(asBuffer(await pdf.save())))[0].rect)
      .toEqual({ x: 10, y: 760, width: 100, height: 20 });
  });

  it('exports mixed Unicode text visibly in every shared widget and preserves editable fields', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage([600, 800]), pdf.addPage([600, 800])];
    const field = pdf.getForm().createTextField('shared');
    field.setText('Original');
    for (const page of pages) field.addToPage(page, { x: 50, y: 500, width: 400, height: 40 });
    const value = '你好，世界 café Ελληνικά Привет';
    const modified = await updateFormFieldValues(asBuffer(await pdf.save()), new Map([['shared', value]]));
    const saved = await PDFDocument.load(modified);
    expect(saved.getForm().getTextField('shared').getText()).toBe(value);
    expect(saved.getForm().getTextField('shared').isReadOnly()).toBe(false);
    const rendered = new mupdf.PDFDocument(modified);
    const embeddedCJKFonts = new Set<string>();
    try {
      for (let index = 0; index < rendered.countPages(); index++) {
        const page = rendered.loadPage(index);
        const widget = page.getWidgets()[0];
        widget.getObject().get('AP', 'N', 'Resources', 'XObject', 'PDFEditorFieldText', 'Resources', 'Font').forEach(font => {
          if (font.get('BaseFont').asName().includes('Droid')) embeddedCJKFonts.add(font.toString());
        });
        const list = widget.toDisplayList();
        const text = list.toStructuredText('');
        try { expect(text.asText().replace(/\s/g, '')).toBe(value.replace(/\s/g, '')); }
        finally { text.destroy(); list.destroy(); widget.destroy(); page.destroy(); }
      }
    } finally { rendered.destroy(); }
    expect(embeddedCJKFonts.size).toBe(1);
    const again = await updateFormFieldValues(asBuffer(modified), new Map([['shared', '修改后的字段'] ]));
    expect((await PDFDocument.load(again)).getForm().getTextField('shared').getText()).toBe('修改后的字段');
  });

  it('exports Chinese dropdown and list labels while retaining native values and selection flags', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage(), pdf.addPage()];
    const dropdown = pdf.getForm().createDropdown('city');
    const list = pdf.getForm().createOptionList('cities');
    list.enableMultiselect();
    for (const field of [dropdown, list]) {
      for (const page of pages) field.addToPage(page, { x: 40, y: field === dropdown ? 500 : 300, width: 250, height: field === dropdown ? 35 : 150 });
      field.acroField.setOptions([
        { value: PDFHexString.fromText('BJ'), display: PDFHexString.fromText('北京') },
        { value: PDFHexString.fromText('SH'), display: PDFHexString.fromText('上海') },
      ]);
    }
    const input = asBuffer(await pdf.save({ updateFieldAppearances: false }));
    const saved = await updateFormFieldValues(input, new Map<string, string | string[]>([['city', 'SH'], ['cities', ['BJ', 'SH']]]));
    const native = await PDFDocument.load(saved);
    expect(native.getForm().getDropdown('city').getSelected()).toEqual(['SH']);
    expect(native.getForm().getDropdown('city').isMultiselect()).toBe(false);
    expect(native.getForm().getOptionList('cities').getSelected()).toEqual(['BJ', 'SH']);
    const document = new mupdf.PDFDocument(saved);
    try {
      for (let index = 0; index < document.countPages(); index++) {
        const page = document.loadPage(index);
        try {
          const widgets = page.getWidgets();
          for (const widget of widgets) {
            const display = widget.toDisplayList();
            const text = display.toStructuredText('');
            try { expect(text.asText().replace(/\s/g, '')).toBe(widget.getName() === 'city' ? '上海' : '北京上海'); }
            finally { text.destroy(); display.destroy(); widget.destroy(); }
          }
        } finally { page.destroy(); }
      }
    } finally { document.destroy(); }
    const next = await updateFormFieldValues(asBuffer(saved), new Map<string, string | string[]>([['city', 'BJ'], ['cities', []]]));
    expect((await extractFormFields(asBuffer(next))).find(field => field.name === 'city')?.value).toBe('BJ');
    expect((await extractFormFields(asBuffer(next))).find(field => field.name === 'cities')?.value).toEqual([]);
  });

  it('repairs missing Chinese choice appearances when updating another field', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const text = pdf.getForm().createTextField('name');
    text.addToPage(page, position);
    const list = pdf.getForm().createOptionList('cities');
    list.addToPage(page, { x: 40, y: 100, width: 250, height: 100 });
    list.acroField.setOptions([{ value: PDFHexString.fromText('BJ'), display: PDFHexString.fromText('北京') }]);
    list.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    const saved = await updateFormFieldValues(asBuffer(await pdf.save({ updateFieldAppearances: false })), new Map([['name', 'Updated']]));
    expect((await PDFDocument.load(saved)).getForm().getTextField('name').getText()).toBe('Updated');
    expect((await extractFormFields(asBuffer(saved))).find(field => field.name === 'cities')?.options).toEqual([{ value: 'BJ', label: '北京' }]);
  });

  it('fits multiline Unicode and reports unsupported layout instead of losing characters', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const field = pdf.getForm().createTextField('notes');
    field.enableMultiline();
    field.addToPage(page, { x: 30, y: 400, width: 140, height: 80 });
    const data = asBuffer(await pdf.save());
    const value = '第一行中文测试\n第二行 English\n第三行中文测试中文测试中文测试';
    const modified = await updateFormFieldValues(data, new Map([['notes', value]]));
    const document = new mupdf.PDFDocument(modified);
    const widget = document.loadPage(0).getWidgets()[0];
    const text = widget.toDisplayList().toStructuredText('');
    expect(text.asText().replace(/\s/g, '')).toBe(value.replace(/\s/g, ''));
    text.destroy(); widget.destroy(); document.destroy();
    await expect(updateFormFieldValues(data, new Map([['notes', 'العربية']]))).rejects.toThrow(/complex-script layout/);
    await expect(updateFormFieldValues(data, new Map([['notes', '中文😀']]))).rejects.toThrow(/unsupported character/);
  });

  it('locates shared widgets through page annotations when /P is absent and skips orphans', async () => {
    const pdf = await PDFDocument.create();
    const firstPage = pdf.addPage([600, 600]);
    const secondPage = pdf.addPage([600, 800]);
    const field = pdf.getForm().createTextField('shared');
    field.setText('original');
    field.addToPage(firstPage, position);
    field.addToPage(secondPage, position);
    for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('P'));

    const orphan = pdf.getForm().createTextField('orphan');
    orphan.addToPage(firstPage, position);
    const orphanWidget = orphan.acroField.getWidgets()[0];
    orphanWidget.dict.delete(PDFName.of('P'));
    firstPage.node.removeAnnot(pdf.context.getObjectRef(orphanWidget.dict)!);

    const fields = await extractFormFields(asBuffer(await pdf.save()));
    expect(fields.map(widget => [widget.name, widget.pageNumber])).toEqual([
      ['shared', 1], ['shared', 2],
    ]);
    expect(fields[0].rect).toEqual({ x: 10, y: 560, width: 100, height: 20 });
    expect(fields[1].rect).toEqual({ x: 10, y: 760, width: 100, height: 20 });
    expect(fields[0].id).not.toBe(fields[1].id);
    expect(fields.every(widget => widget.value === 'original')).toBe(true);
  });

  it('round-trips shared text and checkboxes, multiple list and dropdown values, and radio options', async () => {
    const pdf = await PDFDocument.create();
    const firstPage = pdf.addPage();
    const secondPage = pdf.addPage();
    const form = pdf.getForm();
    const shared = form.createTextField('shared');
    shared.addToPage(firstPage, position);
    shared.addToPage(secondPage, position);
    shared.setText('before');
    const checkbox = form.createCheckBox('accepted');
    checkbox.addToPage(firstPage);
    checkbox.addToPage(secondPage);
    checkbox.check();
    const list = form.createOptionList('languages');
    list.addOptions(['English', 'French', 'German']);
    list.enableMultiselect();
    list.select(['English', 'French']);
    list.addToPage(firstPage, position);
    const dropdown = form.createDropdown('colors');
    dropdown.addOptions(['Red', 'Green', 'Blue']);
    dropdown.enableMultiselect();
    dropdown.select(['Red', 'Blue']);
    dropdown.addToPage(firstPage, position);
    const radio = form.createRadioGroup('plan');
    radio.addOptionToPage('Basic', firstPage);
    radio.addOptionToPage('Pro', secondPage);
    radio.select('Basic');
    const original = asBuffer(await pdf.save());

    const initial = await extractFormFields(original);
    expect(initial.find(field => field.name === 'languages')).toMatchObject({
      type: 'listbox', value: ['English', 'French'],
    });
    expect(initial.find(field => field.name === 'colors')?.value).toEqual(['Red', 'Blue']);
    expect(initial.filter(field => field.name === 'plan').map(field => [field.value, field.exportValue]))
      .toEqual([['Basic', 'Basic'], ['Basic', 'Pro']]);

    const modified = await updateFormFieldValues(original, new Map<string, string | boolean | string[]>([
      ['shared', 'after'], ['accepted', false], ['languages', ['French', 'German']],
      ['colors', ['Green', 'Blue']], ['plan', 'Pro'],
    ]));
    const fields = await extractFormFields(asBuffer(modified));
    expect(fields.filter(field => field.name === 'shared').map(field => field.value)).toEqual(['after', 'after']);
    expect(fields.filter(field => field.name === 'accepted').map(field => field.value)).toEqual([false, false]);
    expect(fields.find(field => field.name === 'languages')?.value).toEqual(['French', 'German']);
    expect(fields.find(field => field.name === 'colors')?.value).toEqual(['Green', 'Blue']);
    expect(fields.filter(field => field.name === 'plan').map(field => field.value)).toEqual(['Pro', 'Pro']);
    expect(fields.map(field => field.id)).toEqual(initial.map(field => field.id));

    const saved = await PDFDocument.load(modified);
    expect(saved.getForm().getOptionList('languages').getSelected()).toEqual(['French', 'German']);
    expect(saved.getForm().getDropdown('colors').getSelected()).toEqual(['Green', 'Blue']);
    expect(saved.getForm().getRadioGroup('plan').getSelected()).toBe('Pro');
  });

  it('clears radio, dropdown, and list selections instead of silently retaining their old values', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const form = pdf.getForm();
    const radio = form.createRadioGroup('radio');
    radio.addOptionToPage('Yes', page);
    radio.select('Yes');
    const dropdown = form.createDropdown('dropdown');
    dropdown.addOptions(['One', 'Two']);
    dropdown.select('One');
    dropdown.addToPage(page, position);
    const list = form.createOptionList('list');
    list.addOptions(['One', 'Two']);
    list.select(['One', 'Two']);
    list.addToPage(page, position);

    const modified = await updateFormFieldValues(asBuffer(await pdf.save()), new Map<string, string | string[]>([
      ['radio', ''], ['dropdown', ''], ['list', []],
    ]));
    const fields = await extractFormFields(asBuffer(modified));
    expect(fields.find(field => field.name === 'radio')?.value).toBe('');
    expect(fields.find(field => field.name === 'dropdown')?.value).toBe('');
    expect(fields.find(field => field.name === 'list')?.value).toEqual([]);
  });

  it('preserves distinct choice export values and display labels when reading and writing', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const dropdown = pdf.getForm().createDropdown('country');
    const list = pdf.getForm().createOptionList('countries');
    list.enableMultiselect();
    for (const field of [dropdown, list]) {
      field.acroField.setOptions([
        { value: PDFHexString.fromText('CA'), display: PDFHexString.fromText('Canada') },
        { value: PDFHexString.fromText('SG'), display: PDFHexString.fromText('Singapore') },
      ]);
      field.addToPage(page, position);
    }
    const original = asBuffer(await pdf.save());
    const modified = await updateFormFieldValues(original, new Map<string, string | string[]>([
      ['country', 'SG'], ['countries', ['CA', 'SG']],
    ]));
    const fields = await extractFormFields(asBuffer(modified));
    expect(fields.find(field => field.name === 'country')).toMatchObject({
      value: 'SG', options: [{ value: 'CA', label: 'Canada' }, { value: 'SG', label: 'Singapore' }],
    });
    expect(fields.find(field => field.name === 'countries')?.value).toEqual(['CA', 'SG']);
    const saved = await PDFDocument.load(modified);
    expect(saved.getForm().getDropdown('country').getSelected()).toEqual(['SG']);
    expect(saved.getForm().getOptionList('countries').getSelected()).toEqual(['CA', 'SG']);
    expect(saved.getForm().getDropdown('country').isEditable()).toBe(false);

    const roundTrip = await updateFormFieldValues(asBuffer(modified), new Map(fields.map(field => [field.name, field.value])));
    expect(await extractFormFields(asBuffer(roundTrip))).toEqual(fields);
  });

  it.each(['dropdown', 'listbox'] as const)('preserves native single-select %s flags and rejects multiple values', async type => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const field = type === 'dropdown' ? pdf.getForm().createDropdown('single') : pdf.getForm().createOptionList('single');
    field.addOptions(['One', 'Two']);
    field.select('One');
    field.addToPage(page, position);
    const original = asBuffer(await pdf.save());
    expect((await extractFormFields(original))[0]).toMatchObject({ type, multiSelect: false });
    await expect(updateFormFieldValues(original, new Map([['single', ['One', 'Two']]]))).rejects.toThrow('only one option');
    const updated = await updateFormFieldValues(original, new Map([['single', ['Two']]]));
    const native = await PDFDocument.load(updated);
    const saved = type === 'dropdown' ? native.getForm().getDropdown('single') : native.getForm().getOptionList('single');
    expect(saved.isMultiselect()).toBe(false);
    expect(saved.getSelected()).toEqual(['Two']);
    expect((await extractFormFields(asBuffer(updated)))[0]).toMatchObject({ multiSelect: false, value: type === 'dropdown' ? 'Two' : ['Two'] });
    expect((await extractFormFields(original))[0].value).toEqual(type === 'dropdown' ? 'One' : ['One']);
  });

  it('reports every missing, invalid, or incompatible field value instead of exporting partial results', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const form = pdf.getForm();
    const text = form.createTextField('name');
    text.setText('unchanged');
    text.addToPage(page, position);
    const dropdown = form.createDropdown('choice');
    dropdown.addOptions(['Allowed']);
    dropdown.addToPage(page, position);
    const checkbox = form.createCheckBox('checkbox');
    checkbox.addToPage(page);
    const original = asBuffer(await pdf.save());

    const result = updateFormFieldValues(original, new Map<string, string | boolean>([
      ['name', true], ['choice', 'Unknown'], ['checkbox', 'unsupported'], ['missing', 'value'],
    ]));
    await expect(result).rejects.toThrow(/"name"[\s\S]*"choice"[\s\S]*"checkbox"[\s\S]*"missing"/);
    expect((await PDFDocument.load(original)).getForm().getTextField('name').getText()).toBe('unchanged');
  });

  it('rejects XFA before pdf-lib can silently remove the original form data', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const form = pdf.getForm();
    const text = form.createTextField('name');
    text.setText('Original'); text.addToPage(page, position);
    form.acroForm.dict.set(PDFName.of('XFA'), pdf.context.register(pdf.context.stream('<xdp>Original form</xdp>')));
    const input = asBuffer(await pdf.save({ updateFieldAppearances: false }));
    await expect(updateFormFieldValues(input, new Map([['name', 'Changed']]))).rejects.toThrow('XFA');
    const untouched = await PDFDocument.load(input);
    expect(untouched.catalog.lookup(PDFName.of('AcroForm'), PDFDict).has(PDFName.of('XFA'))).toBe(true);
  });

  it('preserves read-only fields and marks hidden widgets correctly', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const text = pdf.getForm().createTextField('locked');
    text.setText('original');
    text.enableReadOnly();
    text.addToPage(page, position);
    text.acroField.getWidgets()[0].setFlag(AnnotationFlags.Hidden);
    const button = pdf.getForm().createButton('button');
    button.addToPage('Submit', page, position);
    const original = asBuffer(await pdf.save());
    const fields = await extractFormFields(original);
    expect(fields.find(field => field.name === 'locked')).toMatchObject({ readOnly: true, hidden: true });
    expect(fields.find(field => field.name === 'button')).toMatchObject({ readOnly: true, type: 'button' });

    const modified = await updateFormFieldValues(original, new Map([
      ['locked', 'changed'], ['button', 'ignored'],
    ]));
    expect((await PDFDocument.load(modified)).getForm().getTextField('locked').getText()).toBe('original');
  });
});
