import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { deletePages, reorderPages } from '../../src/core/PDFManipulator';
import { extractFormFields, updateFormFieldValues } from '../../src/forms/FormFieldExtractor';

const asBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const position = { x: 10, y: 20, width: 100, height: 20, borderWidth: 0 };

describe('page operations preserve forms and metadata', () => {
  it('deletes page one while keeping page two fields, their identities, and metadata', async () => {
    const pdf = await PDFDocument.create();
    const firstPage = pdf.addPage();
    const secondPage = pdf.addPage();
    pdf.setTitle('Document title');
    pdf.setAuthor('Author');
    const deleted = pdf.getForm().createTextField('first');
    deleted.addToPage(firstPage, position);
    const retained = pdf.getForm().createTextField('second');
    retained.setText('retained');
    retained.addToPage(secondPage, position);
    retained.acroField.getWidgets()[0].dict.delete(PDFName.of('P'));
    const original = asBuffer(await pdf.save());
    const retainedId = (await extractFormFields(original)).find(field => field.name === 'second')!.id;

    const modified = await deletePages(original, [1]);
    const loaded = await PDFDocument.load(modified);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe('Document title');
    expect(loaded.getAuthor()).toBe('Author');
    expect(loaded.getForm().getFields().map(field => field.getName())).toEqual(['second']);
    expect(await extractFormFields(asBuffer(modified))).toMatchObject([
      { id: retainedId, name: 'second', pageNumber: 1, value: 'retained' },
    ]);
    const filled = await updateFormFieldValues(asBuffer(modified), new Map([['second', 'filled after deletion']]));
    expect((await PDFDocument.load(filled)).getForm().getTextField('second').getText()).toBe('filled after deletion');
  });

  it('removes only the deleted widget of a shared field, preserving its surviving ID and editability', async () => {
    const pdf = await PDFDocument.create();
    const firstPage = pdf.addPage();
    const secondPage = pdf.addPage();
    const shared = pdf.getForm().createTextField('shared');
    shared.addToPage(firstPage, position);
    shared.addToPage(secondPage, position);
    for (const widget of shared.acroField.getWidgets()) widget.dict.delete(PDFName.of('P'));
    const original = asBuffer(await pdf.save());
    const survivingId = (await extractFormFields(original)).find(field => field.pageNumber === 2)!.id;

    const modified = await deletePages(original, [1]);
    const fields = await extractFormFields(asBuffer(modified));
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: survivingId, pageNumber: 1, name: 'shared' });
    const filled = await updateFormFieldValues(asBuffer(modified), new Map([['shared', 'updated']]));
    const loaded = await PDFDocument.load(filled);
    expect(loaded.getForm().getTextField('shared').acroField.getWidgets()).toHaveLength(1);
    expect(loaded.getForm().getTextField('shared').getText()).toBe('updated');
  });

  it('reorders existing pages without changing widget identities, values, or metadata', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage(), pdf.addPage(), pdf.addPage()];
    pdf.setTitle('Reordering test');
    pdf.setSubject('Keep the catalog');
    for (const [index, page] of pages.entries()) {
      const field = pdf.getForm().createTextField(`field-${index + 1}`);
      field.setText(`value-${index + 1}`);
      field.addToPage(page, position);
      field.acroField.getWidgets()[0].dict.delete(PDFName.of('P'));
    }
    const original = asBuffer(await pdf.save());
    const before = await extractFormFields(original);

    const modified = await reorderPages(original, [3, 1, 2]);
    const loaded = await PDFDocument.load(modified);
    const after = await extractFormFields(asBuffer(modified));
    expect(loaded.getTitle()).toBe('Reordering test');
    expect(loaded.getSubject()).toBe('Keep the catalog');
    expect(after.map(field => [field.name, field.pageNumber, field.value])).toEqual([
      ['field-1', 2, 'value-1'], ['field-2', 3, 'value-2'], ['field-3', 1, 'value-3'],
    ]);
    expect(after.map(field => field.id)).toEqual(before.map(field => field.id));
  });

  it('keeps a surviving radio option selectable after deleting a sibling widget', async () => {
    const pdf = await PDFDocument.create();
    const radio = pdf.getForm().createRadioGroup('plan');
    radio.addOptionToPage('Basic', pdf.addPage());
    radio.addOptionToPage('Pro', pdf.addPage());
    radio.select('Basic');

    const modified = await deletePages(asBuffer(await pdf.save()), [1]);
    const filled = await updateFormFieldValues(asBuffer(modified), new Map([['plan', 'Pro']]));
    expect((await PDFDocument.load(filled)).getForm().getRadioGroup('plan').getSelected()).toBe('Pro');
    expect(await extractFormFields(asBuffer(filled))).toMatchObject([
      { name: 'plan', pageNumber: 1, value: 'Pro', exportValue: 'Pro' },
    ]);
  });
});
