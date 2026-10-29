import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, degrees, rgb } from 'pdf-lib';
import { applyFormDesign, inspectFormDesign } from '../../src/forms/FormDesigner';
import type { FormDesignOperation, NewFormDesignField } from '../../src/forms/FormDesigner';
import { extractFormFields, updateFormFieldValues } from '../../src/forms/FormFieldExtractor';
import { loadMuPDF } from '../../src/utils/mupdf';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
const widget = (pageNumber = 1, y = 40) => ({ pageNumber, rect: { x: 20, y, width: 180, height: 36 } });
const create = (field: NewFormDesignField): FormDesignOperation => ({ type: 'create-field', field });
async function fixture() {
  const pdf = await PDFDocument.create();
  const first = pdf.addPage([400, 600]);
  first.drawText('UNCHANGED PAGE CONTENT', { x: 30, y: 30, size: 12 });
  const second = pdf.addPage([600, 800]);
  second.setCropBox(50, 100, 300, 400); second.setRotation(degrees(90));
  second.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  pdf.setTitle('Existing title');
  const kept = pdf.getForm().createTextField('untouched');
  kept.setText('KEPT VALUE'); kept.addToPage(first, { x: 20, y: 100, width: 180, height: 30 });
  first.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [300, 30, 320, 50], Contents: PDFHexString.fromText('Keep this note'), P: first.ref })));
  await pdf.attach(new Uint8Array([1, 7, 9]), 'kept.bin');
  const outlines = pdf.context.obj({ Type: 'Outlines', Count: 1 }), outlineRef = pdf.context.register(outlines);
  const item = pdf.context.register(pdf.context.obj({ Title: PDFHexString.fromText('Bookmark'), Parent: outlineRef, Dest: [first.ref, 'Fit'] }));
  outlines.set(PDFName.of('First'), item); outlines.set(PDFName.of('Last'), item); pdf.catalog.set(PDFName.of('Outlines'), outlineRef);
  return buffer(await pdf.save());
}
async function appearance(data: Uint8Array, name: string) {
  const engine = await loadMuPDF(), pdf = new engine.PDFDocument(data);
  const found: string[] = [];
  try {
    for (let index = 0; index < pdf.countPages(); index++) {
      const page = pdf.loadPage(index);
      try {
        for (const widget of page.getWidgets()) {
          try {
            if (widget.getName() !== name) continue;
            const display = widget.toDisplayList(), text = display.toStructuredText('');
            try { found.push(text.asText().replace(/\s/g, '')); }
            finally { text.destroy(); display.destroy(); }
          } finally { widget.destroy(); }
        }
      } finally { page.destroy(); }
    }
  } finally { pdf.destroy(); }
  return found;
}
async function pagePixels(data: Uint8Array | ArrayBuffer) {
  const engine = await loadMuPDF(), pdf = new engine.PDFDocument(data), page = pdf.loadPage(0);
  const pixmap = page.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, true);
  try { return new Uint8Array(pixmap.getPixels()); }
  finally { pixmap.destroy(); page.destroy(); pdf.destroy(); }
}

describe('native PDF form designer', () => {
  it('creates all five native field types with Unicode values/options and reopens them as fillable fields', async () => {
    const original = await fixture();
    const data = await applyFormDesign(original, [
      create({ type: 'text', name: '客户.姓名', widgets: [widget()], value: '张三 café', defaultValue: '默认姓名', required: true, fontSize: 14, textAlign: 'center', maxLength: 80 }),
      create({ type: 'checkbox', name: 'accepted', widgets: [{ ...widget(1, 100), rect: { x: 20, y: 100, width: 24, height: 24 } }], value: true, defaultValue: false }),
      create({ type: 'radio', name: 'plan', widgets: [{ ...widget(1, 145), optionValue: 'basic' }, { ...widget(2, 145), optionValue: '高级' }], value: '高级', defaultValue: 'basic' }),
      create({ type: 'dropdown', name: 'country', widgets: [widget(1, 210)], options: [{ value: 'SG', label: '新加坡' }, { value: 'CA', label: 'Canada' }], value: 'SG', defaultValue: 'CA' }),
      create({ type: 'listbox', name: 'languages', widgets: [{ ...widget(2, 260), rect: { x: 20, y: 260, width: 200, height: 100 } }], multiSelect: true,
        options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }], value: ['zh', 'en'], defaultValue: ['fr'] }),
    ]);
    const design = await inspectFormDesign(buffer(data));
    expect(design.fields.map(field => field.type)).toEqual(['text', 'text', 'checkbox', 'radio', 'dropdown', 'listbox']);
    expect(design.fields.find(field => field.name === '客户.姓名')).toMatchObject({ value: '张三 café', defaultValue: '默认姓名', required: true, fontSize: 14, textAlign: 'center', maxLength: 80 });
    expect(design.fields.find(field => field.name === 'country')).toMatchObject({ value: 'SG', defaultValue: 'CA', options: [{ value: 'SG', label: '新加坡' }, { value: 'CA', label: 'Canada' }] });
    expect(design.fields.find(field => field.name === 'languages')).toMatchObject({ value: ['zh', 'en'], defaultValue: ['fr'], multiSelect: true });
    expect(await appearance(data, '客户.姓名')).toEqual(['张三café']);
    expect((await appearance(data, 'country'))[0]).toContain('新加坡');
    expect((await appearance(data, 'languages'))[0]).toContain('中文');
    const filled = await updateFormFieldValues(buffer(data), new Map([
      ['客户.姓名', '李四'], ['country', 'CA'], ['languages', ['en', 'fr']], ['plan', 'basic'], ['accepted', false],
    ] as Array<[string, string | string[] | boolean]>));
    const fields = await extractFormFields(buffer(filled));
    expect(fields.find(field => field.name === '客户.姓名')?.value).toBe('李四');
    expect(fields.find(field => field.name === 'country')?.value).toBe('CA');
    expect(fields.find(field => field.name === 'languages')?.value).toEqual(['en', 'fr']);
    expect(fields.filter(field => field.name === 'plan').every(field => field.value === 'basic')).toBe(true);
    const pdf = await PDFDocument.load(data);
    expect(pdf.getTitle()).toBe('Existing title');
    expect(pdf.getForm().getTextField('untouched').getText()).toBe('KEPT VALUE');
    expect(pdf.catalog.has(PDFName.of('Names'))).toBe(true);
    expect(pdf.catalog.has(PDFName.of('Outlines'))).toBe(true);
    const notes = pdf.getPage(0).node.Annots()!.asArray().map(ref => pdf.context.lookup(ref)).filter((object): object is PDFDict => object instanceof PDFDict && object.get(PDFName.of('Subtype')) === PDFName.of('Text'));
    expect(notes).toHaveLength(1);
    expect(notes[0].lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Keep this note');
    expect((await pagePixels(data)).slice(400 * 400 * 3)).toEqual((await pagePixels(original)).slice(400 * 400 * 3));
    const engine = await loadMuPDF(), native = new engine.PDFDocument(data);
    try { expect(native.loadOutline()?.[0].title).toBe('Bookmark'); }
    finally { native.destroy(); }
  });

  it('moves and resizes a no-/P shared widget across cropped UserUnit pages without changing native refs', async () => {
    const first = await applyFormDesign(await fixture(), [create({ type: 'text', name: 'shared', widgets: [widget(), widget(2)], value: '共享', fontSize: 14 })]);
    const parsed = await PDFDocument.load(first);
    const shared = parsed.getForm().getTextField('shared');
    shared.acroField.getWidgets()[0].dict.delete(PDFName.of('P'));
    const source = buffer(await parsed.save({ updateFieldAppearances: false }));
    const before = (await inspectFormDesign(source)).fields.find(field => field.name === 'shared')!;
    const rect = { x: 60, y: 120, width: 260, height: 60 };
    const output = await applyFormDesign(source, [{ type: 'update-widget', fieldId: before.id, widgetId: before.widgets[0].id, patch: { pageNumber: 2, rect } }]);
    const after = (await inspectFormDesign(buffer(output))).fields.find(field => field.id === before.id)!;
    expect(after.widgets.map(widget => widget.id)).toEqual(before.widgets.map(widget => widget.id));
    expect(after.widgets[0]).toMatchObject({ pageNumber: 2, rect });
    expect(after.widgets[1]).toEqual(before.widgets[1]);
    expect(after.fontSize).toBe(14);
    const filled = await updateFormFieldValues(buffer(output), new Map([['shared', '仍可填写']]));
    expect(await appearance(filled, 'shared')).toEqual(['仍可填写', '仍可填写']);
    expect((await extractFormFields(buffer(output))).filter(field => field.name === 'shared').map(field => field.rect)).toEqual([rect, before.widgets[1].rect]);
  });

  it('deletes a single widget independently and removes the logical field only with its final widget', async () => {
    let data = await applyFormDesign(await fixture(), [create({ type: 'text', name: 'shared', widgets: [widget(), widget(2)], value: 'KEEP' })]);
    let field = (await inspectFormDesign(buffer(data))).fields.find(field => field.name === 'shared')!;
    const siblingId = field.widgets[1].id;
    data = await applyFormDesign(buffer(data), [{ type: 'delete-widget', fieldId: field.id, widgetId: field.widgets[0].id }]);
    field = (await inspectFormDesign(buffer(data))).fields.find(field => field.name === 'shared')!;
    expect(field.widgets).toHaveLength(1); expect(field.widgets[0].id).toBe(siblingId);
    expect((await PDFDocument.load(data)).getForm().getTextField('shared').getText()).toBe('KEEP');
    data = await applyFormDesign(buffer(data), [{ type: 'delete-widget', fieldId: field.id, widgetId: siblingId }]);
    expect((await inspectFormDesign(buffer(data))).fields.some(field => field.name === 'shared')).toBe(false);
    expect((await PDFDocument.load(data)).getForm().getTextField('untouched').getText()).toBe('KEPT VALUE');
  });

  it('renames logical fields and changes flags/defaults without changing sibling widget refs', async () => {
    const source = await applyFormDesign(await fixture(), [create({ type: 'text', name: 'group.old', widgets: [widget(), widget(2)], value: 'current' })]);
    const before = (await inspectFormDesign(buffer(source))).fields.find(field => field.name === 'group.old')!;
    const output = await applyFormDesign(buffer(source), [
      { type: 'update-field', fieldId: before.id, patch: { name: 'group.new', required: true, readOnly: true, defaultValue: 'default', multiline: true, maxLength: 90, textAlign: 'right', fontSize: 10 } },
      { type: 'update-widget', fieldId: before.id, widgetId: before.widgets[1].id, patch: { hidden: true } },
    ]);
    const after = (await inspectFormDesign(buffer(output))).fields.find(field => field.id === before.id)!;
    expect(after).toMatchObject({ name: 'group.new', value: 'current', defaultValue: 'default', required: true, readOnly: true, multiline: true, maxLength: 90, textAlign: 'right' });
    expect(after.widgets.map(widget => widget.id)).toEqual(before.widgets.map(widget => widget.id));
    expect(after.widgets.map(widget => widget.hidden)).toEqual([false, true]);
  });

  it('preserves text and choice appearance colors when moving across UserUnit pages and changing font size', async () => {
    const pdf = await PDFDocument.load(await fixture());
    const text = pdf.getForm().createTextField('red'); text.setText('RED TEXT');
    text.addToPage(pdf.getPage(0), { x: 20, y: 500, width: 180, height: 36, textColor: rgb(1, 0, 0), borderWidth: 0 });
    text.setFontSize(14);
    const choice = pdf.getForm().createDropdown('blue'); choice.addOptions(['BLUE CHOICE']); choice.select('BLUE CHOICE');
    choice.addToPage(pdf.getPage(0), { x: 20, y: 400, width: 180, height: 36, textColor: rgb(0, 0, 1), borderWidth: 0 });
    choice.setFontSize(14);
    const source = buffer(await pdf.save());
    const design = await inspectFormDesign(source);
    const operations = ['red', 'blue'].flatMap((name, index): FormDesignOperation[] => {
      const field = design.fields.find(field => field.name === name)!;
      return [
        { type: 'update-field', fieldId: field.id, patch: { fontSize: 18 } },
        { type: 'update-widget', fieldId: field.id, widgetId: field.widgets[0].id, patch: { pageNumber: 2, rect: { x: 40, y: 80 + index * 100, width: 300, height: 60 } } },
      ];
    });
    const output = await applyFormDesign(source, operations);
    const after = await inspectFormDesign(buffer(output));
    expect(after.fields.filter(field => ['red', 'blue'].includes(field.name)).map(field => field.fontSize)).toEqual([18, 18]);
    const engine = await loadMuPDF(), rendered = new engine.PDFDocument(output), page = rendered.loadPage(1);
    try {
      for (const widget of page.getWidgets()) {
        try {
          const isRed = widget.getName() === 'red';
          const pixmap = widget.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false);
          try {
            const pixels = pixmap.getPixels();
            let colored = 0;
            for (let offset = 0; offset < pixels.length; offset += 3) {
              if (isRed ? pixels[offset] > 150 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100 : pixels[offset + 2] > 150 && pixels[offset] < 100 && pixels[offset + 1] < 100) colored++;
            }
            expect(colored).toBeGreaterThan(20);
          } finally { pixmap.destroy(); }
        } finally { widget.destroy(); }
      }
    } finally { page.destroy(); rendered.destroy(); }
  });

  it.each([0, 1])('updates radio values after all option changes and avoids on-state collisions after deleting widget %i', async removedIndex => {
    let data = await applyFormDesign(await fixture(), [create({ type: 'radio', name: 'radio', widgets: ['A', 'B', 'C'].map((optionValue, index) => ({ ...widget(1, 40 + index * 60), optionValue })), value: 'C', defaultValue: 'C' })]);
    let field = (await inspectFormDesign(buffer(data))).fields.find(field => field.name === 'radio')!;
    data = await applyFormDesign(buffer(data), [
      { type: 'update-field', fieldId: field.id, patch: { value: '新选项', defaultValue: '新选项' } },
      { type: 'update-widget', fieldId: field.id, widgetId: field.widgets[2].id, patch: { optionValue: '新选项' } },
      { type: 'delete-widget', fieldId: field.id, widgetId: field.widgets[removedIndex].id },
      { type: 'add-widget', fieldId: field.id, widget: { ...widget(2), optionValue: 'D' } },
    ]);
    field = (await inspectFormDesign(buffer(data))).fields.find(field => field.name === 'radio')!;
    expect(field).toMatchObject({ value: '新选项', defaultValue: '新选项' });
    expect(field.widgets.map(widget => widget.optionValue)).toEqual([removedIndex === 0 ? 'B' : 'A', '新选项', 'D']);
    const parsed = await PDFDocument.load(data), radio = parsed.getForm().getRadioGroup('radio');
    const states = radio.acroField.getWidgets().map(widget => widget.getOnValue()?.toString());
    expect(new Set(states).size).toBe(3);
    const filled = await updateFormFieldValues(buffer(data), new Map([['radio', 'D']]));
    const widgets = (await PDFDocument.load(filled)).getForm().getRadioGroup('radio').acroField.getWidgets();
    expect(widgets.map(widget => widget.getAppearanceState()?.toString())).toEqual(['/Off', '/Off', states[2]]);
  });

  it('clears only a deleted radio default option while retaining a different current selection', async () => {
    const source = await applyFormDesign(await fixture(), [create({ type: 'radio', name: 'radio', widgets: ['A', 'B', 'C'].map((optionValue, index) => ({ ...widget(1, 40 + index * 60), optionValue })), value: 'C', defaultValue: 'B' })]);
    const field = (await inspectFormDesign(buffer(source))).fields.find(field => field.name === 'radio')!;
    const output = await applyFormDesign(buffer(source), [{ type: 'delete-widget', fieldId: field.id, widgetId: field.widgets[1].id }]);
    expect((await inspectFormDesign(buffer(output))).fields.find(field => field.name === 'radio')).toMatchObject({ value: 'C', defaultValue: '' });
  });

  it('adds shared checkbox widgets and retains one logical value', async () => {
    const source = await applyFormDesign(await fixture(), [create({ type: 'checkbox', name: 'shared-check', widgets: [widget()], value: true })]);
    const field = (await inspectFormDesign(buffer(source))).fields.find(field => field.name === 'shared-check')!;
    const output = await applyFormDesign(buffer(source), [{ type: 'add-widget', fieldId: field.id, widget: widget(2) }]);
    expect((await extractFormFields(buffer(output))).filter(field => field.name === 'shared-check').map(field => field.value)).toEqual([true, true]);
    const parsed = await PDFDocument.load(output), check = parsed.getForm().getCheckBox('shared-check');
    expect(check.acroField.getWidgets().every(widget => widget.getAppearanceState() === widget.getOnValue())).toBe(true);
  });

  it('preserves distinct option labels/values and refuses dropping a selected or default value implicitly', async () => {
    const source = await applyFormDesign(await fixture(), [create({ type: 'dropdown', name: 'choice', widgets: [widget()], options: [{ value: 'a', label: '相同' }, { value: 'b', label: '相同' }], value: 'a', defaultValue: 'b' })]);
    const field = (await inspectFormDesign(buffer(source))).fields.find(field => field.name === 'choice')!;
    await expect(applyFormDesign(buffer(source), [{ type: 'update-field', fieldId: field.id, patch: { options: [{ value: 'c', label: '新的' }] } }])).rejects.toThrow('missing from the choices');
    const output = await applyFormDesign(buffer(source), [{ type: 'update-field', fieldId: field.id, patch: { options: [{ value: 'c', label: '新的' }], value: 'c', defaultValue: 'c' } }]);
    expect((await inspectFormDesign(buffer(output))).fields.find(field => field.name === 'choice')).toMatchObject({ value: 'c', defaultValue: 'c' });
  });

  it('rejects invalid geometry, duplicate names, unsupported characters and destructive option changes atomically', async () => {
    const data = await fixture(), copy = data.slice(0);
    const invalid: FormDesignOperation[][] = [
      [create({ type: 'text', name: 'untouched', widgets: [widget()] })],
      [create({ type: 'text', name: 'new', widgets: [{ ...widget(), rect: { x: -1, y: 40, width: 20, height: 20 } }] })],
      [create({ type: 'text', name: 'new', widgets: [widget()], value: '中文😀' })],
      [create({ type: 'text', name: 'new', widgets: [widget()], value: 'too long', maxLength: 2 })],
      [create({ type: 'listbox', name: 'new', widgets: [widget()], options: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }], value: ['1', '2'] })],
    ];
    for (const operations of invalid) await expect(applyFormDesign(data, operations)).rejects.toThrow();
    expect(data).toEqual(copy);
  });

  it.each(['xfa', 'signed', 'script', 'inline-script'])('reports and refuses %s PDFs without stripping their original data', async kind => {
    const pdf = await PDFDocument.load(await fixture());
    if (kind === 'xfa') pdf.getForm().acroForm.dict.set(PDFName.of('XFA'), pdf.context.register(pdf.context.stream('<xfa/>')));
    if (kind === 'signed') pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 100, 200, 100] })) }));
    if (kind === 'script') pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.register(pdf.context.obj({ S: 'JavaScript', JS: PDFHexString.fromText('app.alert("keep")') })));
    if (kind === 'inline-script') pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj({ S: 'JavaScript', JS: PDFHexString.fromText('app.alert("keep")') }));
    const data = buffer(await pdf.save({ updateFieldAppearances: false })), copy = data.slice(0);
    expect((await inspectFormDesign(data)).canEdit).toBe(false);
    await expect(applyFormDesign(data, [create({ type: 'text', name: 'new', widgets: [widget()] })])).rejects.toThrow(/XFA|Signed|scripts/);
    expect(data).toEqual(copy);
  });

  it('preserves unsupported buttons and rejects designing one instead of pretending it is a text field', async () => {
    const pdf = await PDFDocument.load(await fixture());
    pdf.getForm().createButton('action').addToPage('Action', pdf.getPage(0), { x: 250, y: 350, width: 100, height: 30 });
    const data = buffer(await pdf.save());
    const button = (await inspectFormDesign(data)).fields.find(field => field.name === 'action')!;
    expect(button).toMatchObject({ type: 'button', supported: false });
    await expect(applyFormDesign(data, [{ type: 'delete-field', fieldId: button.id }])).rejects.toThrow('button');
    const output = await applyFormDesign(data, [create({ type: 'text', name: 'new', widgets: [widget()] })]);
    expect((await PDFDocument.load(output)).getForm().getButton('action')).toBeDefined();
  });

  it('preserves an unsigned signature with /V null while allowing other fields to be designed', async () => {
    const pdf = await PDFDocument.load(await fixture());
    const unsigned = pdf.getForm().createTextField('unsigned-signature');
    unsigned.addToPage(pdf.getPage(0), { x: 220, y: 100, width: 150, height: 30 });
    unsigned.acroField.dict.set(PDFName.of('FT'), PDFName.of('Sig'));
    unsigned.acroField.dict.set(PDFName.of('V'), PDFNull);
    const source = buffer(await pdf.save({ updateFieldAppearances: false }));
    const design = await inspectFormDesign(source);
    expect(design.canEdit).toBe(true);
    expect(design.fields.find(field => field.name === 'unsigned-signature')).toMatchObject({ type: 'signature', supported: false });
    const output = await applyFormDesign(source, [create({ type: 'text', name: 'new', widgets: [widget()] })]);
    const preserved = (await PDFDocument.load(output)).getForm().getSignature('unsigned-signature');
    expect(preserved.ref.toString()).toBe(design.fields.find(field => field.name === 'unsigned-signature')!.id);
    expect(preserved.acroField.dict.get(PDFName.of('V')) ?? PDFNull).toBe(PDFNull);
  });
});
