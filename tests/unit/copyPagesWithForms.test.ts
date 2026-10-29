import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { copyPagesWithForms } from '../../src/core/copyPagesWithForms';
import { insertPagesFromPDF, mergePDFs, splitPDF } from '../../src/core/PDFManipulator';
import { extractFormFields, updateFormFieldValues } from '../../src/forms/FormFieldExtractor';

const asBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const position = { x: 20, y: 30, width: 150, height: 30, borderWidth: 0 };

async function textDocument(name: string, value: string) {
  const pdf = await PDFDocument.create();
  const field = pdf.getForm().createTextField(name);
  field.setText(value);
  field.addToPage(pdf.addPage(), position);
  return pdf;
}

async function sharedDocument() {
  const pdf = await PDFDocument.create();
  const pages = [pdf.addPage(), pdf.addPage(), pdf.addPage()];
  const shared = pdf.getForm().createTextField('shared');
  shared.setText('shared value');
  shared.addToPage(pages[0], position);
  shared.addToPage(pages[2], position);
  const list = pdf.getForm().createOptionList('languages');
  list.addOptions(['English', 'French', 'German']);
  list.select(['English', 'German']);
  list.addToPage(pages[1], position);
  return pdf;
}

describe('copying PDF pages with native forms', () => {
  it('copies only selected calculation-order fields and retains the existing destination order', async () => {
    const source = await sharedDocument();
    const sourceForm = source.getForm();
    source.catalog.getOrCreateAcroForm().dict.set(PDFName.of('CO'), source.context.obj([
      sourceForm.getOptionList('languages').ref,
      sourceForm.getTextField('shared').ref,
    ]));
    const target = await textDocument('shared', 'target value');
    const targetField = target.getForm().getTextField('shared');
    target.catalog.getOrCreateAcroForm().dict.set(PDFName.of('CO'), target.context.obj([targetField.ref]));
    for (const page of await copyPagesWithForms(target, source, [2])) target.addPage(page);
    const saved = await PDFDocument.load(await target.save());
    const order = saved.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('CO'), PDFArray);
    expect(order.asArray().map(ref => saved.getForm().getFields().find(field => field.ref === ref)?.getName()))
      .toEqual(['shared', 'shared_2']);
    expect(saved.getForm().getFields().map(field => field.getName())).toEqual(['shared', 'shared_2']);
    expect(source.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('CO'), PDFArray).size()).toBe(2);
  });

  it('appends calculation orders across multiple merged sources after deterministic field renaming', async () => {
    const documents = await Promise.all(['first', 'second', 'third'].map(value => textDocument('value', value)));
    for (const pdf of documents) {
      const total = pdf.getForm().createTextField('total');
      total.setText('123');
      total.addToPage(pdf.getPage(0), { ...position, y: 100 });
      pdf.catalog.getOrCreateAcroForm().dict.set(PDFName.of('CO'), pdf.context.obj([
        pdf.getForm().getTextField('value').ref, total.ref,
      ]));
    }
    const merged = await mergePDFs(await Promise.all(documents.map(async pdf => asBuffer(await pdf.save()))));
    const saved = await PDFDocument.load(merged);
    const order = saved.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('CO'), PDFArray);
    expect(order.asArray().map(ref => saved.getForm().getFields().find(field => field.ref === ref)?.getName()))
      .toEqual(['value', 'total', 'value_2', 'total_2', 'value_3', 'total_3']);
  });

  it('inserts different fields without losing their values, options, or editability', async () => {
    const target = await textDocument('recipient', 'target value');
    const source = await sharedDocument();
    const bytes = await insertPagesFromPDF(asBuffer(await target.save()), asBuffer(await source.save()), 1);
    const extracted = await extractFormFields(asBuffer(bytes));
    expect(extracted.filter(field => field.name === 'shared').map(field => field.pageNumber)).toEqual([1, 3]);
    expect(extracted.find(field => field.name === 'recipient')).toMatchObject({ pageNumber: 4, value: 'target value' });
    expect(extracted.find(field => field.name === 'languages')).toMatchObject({
      pageNumber: 2, value: ['English', 'German'],
      options: ['English', 'French', 'German'].map(value => ({ label: value, value })),
    });

    const filled = await updateFormFieldValues(asBuffer(bytes), new Map<string, string | string[]>([
      ['recipient', 'updated target'], ['shared', 'updated source'], ['languages', ['French']],
    ]));
    const form = (await PDFDocument.load(filled)).getForm();
    expect(form.getTextField('recipient').getText()).toBe('updated target');
    expect(form.getTextField('shared').getText()).toBe('updated source');
    expect(form.getOptionList('languages').getSelected()).toEqual(['French']);
  });

  it('renames conflicts deterministically when merging instead of connecting unrelated values', async () => {
    const documents = await Promise.all(['first', 'second', 'third'].map(value => textDocument('name', value)));
    const bytes = await mergePDFs(await Promise.all(documents.map(async pdf => asBuffer(await pdf.save()))));
    const fields = await extractFormFields(asBuffer(bytes));
    expect(fields.map(field => [field.name, field.value, field.pageNumber])).toEqual([
      ['name', 'first', 1], ['name_2', 'second', 2], ['name_3', 'third', 3],
    ]);
    const filled = await updateFormFieldValues(asBuffer(bytes), new Map([['name_2', 'only the second form']]));
    const form = (await PDFDocument.load(filled)).getForm();
    expect(form.getTextField('name').getText()).toBe('first');
    expect(form.getTextField('name_2').getText()).toBe('only the second form');
    expect(form.getTextField('name_3').getText()).toBe('third');
  });

  it('imports only selected shared widgets and points /P to their new pages without copying hidden pages', async () => {
    const source = await sharedDocument();
    for (let i = 0; i < 20; i++) source.addPage();
    const target = await PDFDocument.create();
    const originalWidgets = source.getForm().getTextField('shared').acroField.getWidgets();
    originalWidgets[1].dict.delete(PDFName.of('P'));
    const originalPageRefs = originalWidgets.map(widget => widget.P());
    const copied = await copyPagesWithForms(target, source, [2]);
    copied.forEach(page => target.addPage(page));

    expect(target.getForm().getFields().map(field => field.getName())).toEqual(['shared']);
    const widgets = target.getForm().getTextField('shared').acroField.getWidgets();
    expect(widgets).toHaveLength(1);
    expect(widgets[0].P()).toBe(copied[0].ref);
    const pageObjects = target.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFDict && object.lookup(PDFName.of('Type')) === PDFName.of('Page'));
    expect(pageObjects).toHaveLength(1);
    expect(source.getForm().getTextField('shared').acroField.getWidgets().map(widget => widget.P())).toEqual(originalPageRefs);
    expect(source.getForm().getTextField('shared').acroField.getWidgets()).toHaveLength(2);
    expect(source.getPageCount()).toBe(23);

    const fields = await extractFormFields(asBuffer(await target.save()));
    expect(fields).toMatchObject([{ name: 'shared', value: 'shared value', pageNumber: 1 }]);
  });

  it('retains nested field hierarchies and renames only the conflicting imported root', async () => {
    const target = await textDocument('contact.name', 'target name');
    const source = await textDocument('contact.name', 'source name');
    const sourceOther = source.getForm().createTextField('contact.email');
    sourceOther.setText('source@example.com');
    sourceOther.addToPage(source.getPage(0), { ...position, y: 100 });
    const excluded = source.getForm().createTextField('contact.excluded');
    excluded.setText('not imported');
    excluded.addToPage(source.addPage(), position);
    const bytes = await insertPagesFromPDF(asBuffer(await target.save()), asBuffer(await source.save()), 0, [1]);
    const form = (await PDFDocument.load(bytes)).getForm();
    expect(form.getFields().map(field => field.getName())).toEqual([
      'contact.name', 'contact_2.name', 'contact_2.email',
    ]);
    const filled = await updateFormFieldValues(asBuffer(bytes), new Map([['contact_2.email', 'changed@example.com']]));
    expect((await PDFDocument.load(filled)).getForm().getTextField('contact_2.email').getText()).toBe('changed@example.com');
    expect(source.getForm().getTextField('contact.excluded').getText()).toBe('not imported');
  });

  it('filters radio options alongside widgets and clears a selection on an excluded page', async () => {
    const source = await PDFDocument.create();
    const radio = source.getForm().createRadioGroup('plan');
    radio.addOptionToPage('Basic', source.addPage());
    radio.addOptionToPage('Pro', source.addPage());
    radio.select('Basic');
    const target = await PDFDocument.create();
    for (const page of await copyPagesWithForms(target, source, [1])) target.addPage(page);
    const imported = target.getForm().getRadioGroup('plan');
    expect(imported.getOptions()).toEqual(['Pro']);
    expect(imported.getSelected()).toBeUndefined();
    imported.select('Pro');
    expect((await PDFDocument.load(await target.save())).getForm().getRadioGroup('plan').getSelected()).toBe('Pro');
    expect(radio.getOptions()).toEqual(['Basic', 'Pro']);
    expect(radio.getSelected()).toBe('Basic');
  });

  it('copies repeated pages with separate widgets and independently named fields', async () => {
    const source = await textDocument('name', 'original');
    const target = await PDFDocument.create();
    for (const page of await copyPagesWithForms(target, source, [0, 0])) target.addPage(page);
    const fields = await extractFormFields(asBuffer(await target.save()));
    expect(fields.map(field => [field.name, field.pageNumber])).toEqual([['name', 1], ['name_2', 2]]);
    const firstWidget = target.getForm().getTextField('name').acroField.getWidgets()[0];
    const secondWidget = target.getForm().getTextField('name_2').acroField.getWidgets()[0];
    expect(firstWidget.dict).not.toBe(secondWidget.dict);
    expect(firstWidget.P()).toBe(target.getPage(0).ref);
    expect(secondWidget.P()).toBe(target.getPage(1).ref);
  });

  it('keeps form default fonts distinct when source and target resource names conflict', async () => {
    const source = await textDocument('source', 'source value');
    const target = await textDocument('target', 'target value');
    const sourceFont = await source.embedFont(StandardFonts.Courier);
    const targetFont = await target.embedFont(StandardFonts.Helvetica);
    source.catalog.getOrCreateAcroForm().dict.set(PDFName.of('DR'), source.context.obj({ Font: { Helv: sourceFont.ref } }));
    source.catalog.getOrCreateAcroForm().dict.set(PDFName.of('DA'), PDFString.of('/Helv 12 Tf 0 g'));
    target.catalog.getOrCreateAcroForm().dict.set(PDFName.of('DR'), target.context.obj({ Font: { Helv: targetFont.ref } }));
    source.getForm().getTextField('source').acroField.dict.delete(PDFName.of('DA'));
    for (const widget of source.getForm().getTextField('source').acroField.getWidgets()) widget.dict.delete(PDFName.of('DA'));
    for (const page of await copyPagesWithForms(target, source, [0])) target.addPage(page);

    expect(target.getForm().getTextField('source').acroField.getDefaultAppearance()).toContain('/Helv_2 12 Tf');
    const resources = target.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('DR'), PDFDict);
    const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.get(PDFName.of('Helv'))).toBe(targetFont.ref);
    expect(fonts.lookup(PDFName.of('Helv_2'), PDFDict).lookup(PDFName.of('BaseFont'))).toBe(PDFName.of('Courier'));
  });

  it.each(['ranges', 'every-n-pages', 'extract-pages'] as const)('preserves only exported widgets when splitting by %s', async mode => {
    const source = await sharedDocument();
    const original = asBuffer(await source.save());
    const options = mode === 'ranges' ? { mode, ranges: [{ start: 2, end: 3 }] }
      : mode === 'every-n-pages' ? { mode, everyN: 2 }
        : { mode, pages: [3] };
    const parts = await splitPDF(original, options);
    const last = parts[parts.length - 1];
    const fields = await extractFormFields(asBuffer(last));
    expect(fields.filter(field => field.name === 'shared')).toHaveLength(1);
    expect(fields.find(field => field.name === 'shared')?.pageNumber).toBe(mode === 'ranges' ? 2 : 1);
    const filled = await updateFormFieldValues(asBuffer(last), new Map([['shared', 'filled split PDF']]));
    expect((await PDFDocument.load(filled)).getForm().getTextField('shared').getText()).toBe('filled split PDF');
    if (mode !== 'ranges') expect(fields.map(field => field.name)).toEqual(['shared']);
    expect((await extractFormFields(original)).filter(field => field.name === 'shared')).toHaveLength(2);
  });

  it('rejects a malformed widget instead of silently copying an unfillable form', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage();
    const invalid = source.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 10, 10] });
    page.node.addAnnot(source.context.register(invalid));
    const target = await PDFDocument.create();
    await expect(copyPagesWithForms(target, source, [0])).rejects.toThrow('without a form field');
    expect(target.getPageCount()).toBe(0);
  });
});
