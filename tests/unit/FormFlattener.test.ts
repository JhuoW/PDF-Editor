import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { flattenForm, getFormFieldCount, isFlattened } from '../../src/forms/FormFlattener';
import { updateFormFieldValues } from '../../src/forms/FormFieldExtractor';

const asBuffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
const position = { x: 50, y: 250, width: 250, height: 35, borderWidth: 0 };

function render(data: ArrayBuffer | Uint8Array, pageNumber = 0) {
  const document = new mupdf.PDFDocument(data);
  const trailer = document.getTrailer();
  const form = trailer.get('Root', 'AcroForm');
  try { if (form.isDictionary()) form.put('NeedAppearances', false); }
  finally { form.destroy(); trailer.destroy(); }
  const page = document.loadPage(pageNumber);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return Buffer.from(pixmap.getPixels()); }
  finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}

function remainingAnnotations(pdf: PDFDocument, pageNumber = 0) {
  const annotations = pdf.getPage(pageNumber).node.Annots();
  return annotations?.asArray().map(reference => {
    if (reference instanceof PDFRef) expect(pdf.context.lookup(reference)).toBeDefined();
    const object = pdf.context.lookup(reference);
    expect(object).toBeInstanceOf(PDFDict);
    expect((object as PDFDict).get(PDFName.of('Subtype'))).not.toBe(PDFName.of('Widget'));
    return object as PDFDict;
  }) ?? [];
}

describe('form flattening', () => {
  it('removes real widget references, including widgets without /P, while retaining Link and Text annotations', async () => {
    const pdf = await PDFDocument.create();
    const first = pdf.addPage([400, 400]), second = pdf.addPage([400, 400]);
    const field = pdf.getForm().createTextField('Shared');
    field.setText('STATIC FIELD');
    field.addToPage(first, position); field.addToPage(second, position);
    for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('P'));
    const checkbox = pdf.getForm().createCheckBox('Checked');
    checkbox.addToPage(first, { x: 30, y: 100, width: 20, height: 20 }); checkbox.check();
    const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 100, 40],
      A: { S: 'URI', URI: PDFString.of('https://example.org/keep') } }));
    const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [200, 20, 224, 44],
      Contents: PDFString.of('Keep this note'), NM: PDFString.of('retained-note'), P: first.ref }));
    first.node.addAnnot(link); first.node.addAnnot(note);
    const input = asBuffer(await pdf.save());
    const output = await flattenForm(input);
    const saved = await PDFDocument.load(output);
    expect(saved.getForm().getFields()).toHaveLength(0);
    expect(remainingAnnotations(saved).map(annotation => annotation.get(PDFName.of('Subtype'))))
      .toEqual([PDFName.of('Link'), PDFName.of('Text')]);
    expect(remainingAnnotations(saved, 1)).toEqual([]);
    expect(saved.context.lookup(link, PDFDict).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText())
      .toBe('https://example.org/keep');
    expect(saved.context.lookup(note, PDFDict).lookup(PDFName.of('Contents'), PDFString).decodeText()).toBe('Keep this note');
    expect(render(output).equals(render(input))).toBe(true);
    expect(render(output, 1).equals(render(input, 1))).toBe(true);
  });

  it('preserves embedded Unicode appearances even with NeedAppearances and shared widgets without /P', async () => {
    const pdf = await PDFDocument.create();
    const pages = [pdf.addPage([400, 400]), pdf.addPage([400, 400])];
    const field = pdf.getForm().createTextField('Unicode');
    for (const page of pages) field.addToPage(page, position);
    const value = '客户 中文 café Ελληνικά Привет';
    const filled = await updateFormFieldValues(asBuffer(await pdf.save()), new Map([['Unicode', value]]));
    const source = await PDFDocument.load(filled);
    for (const widget of source.getForm().getTextField('Unicode').acroField.getWidgets()) widget.dict.delete(PDFName.of('P'));
    source.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('NeedAppearances'), source.context.obj(true));
    const input = asBuffer(await source.save({ updateFieldAppearances: false }));
    const output = await flattenForm(input);
    const document = new mupdf.PDFDocument(output);
    try {
      for (let index = 0; index < 2; index++) {
        expect(render(output, index).equals(render(input, index))).toBe(true);
        const page = document.loadPage(index), text = page.toStructuredText('');
        try { expect(text.asText().replace(/\s/g, '')).toBe(value.replace(/\s/g, '')); }
        finally { text.destroy(); page.destroy(); }
      }
    } finally { document.destroy(); }
    expect(await isFlattened(asBuffer(output))).toBe(true);
  });

  it.each([false, true])('maps a shifted, rotated AP BBox into its widget Rect (complex page=%s)', async complex => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 400]);
    if (complex) {
      page.setCropBox(40, 50, 300, 300); page.setRotation(degrees(90));
      page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    }
    const button = pdf.getForm().createButton('Transformed');
    button.addToPage('', page, { x: 100, y: 200, width: 100, height: 50, borderWidth: 0 });
    const appearance = pdf.context.register(pdf.context.flateStream('1 0 0 rg 10 20 20 10 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [10, 20, 30, 30], Matrix: [0, 1, -1, 0, 50, 0], Resources: {},
    }));
    button.acroField.getWidgets()[0].dict.set(PDFName.of('AP'), pdf.context.obj({ N: appearance }));
    const input = asBuffer(await pdf.save({ updateFieldAppearances: false }));
    const output = await flattenForm(input);
    expect(render(output).equals(render(input))).toBe(true);
    expect(remainingAnnotations(await PDFDocument.load(output))).toEqual([]);
  });

  it('rejects an orphan between valid fields without returning partially flattened bytes or changing input', async () => {
    const pdf = await PDFDocument.create(), first = pdf.addPage(), second = pdf.addPage();
    const good = pdf.getForm().createTextField('First good'); good.setText('First value'); good.addToPage(first, position);
    const orphan = pdf.getForm().createTextField('Orphan'); orphan.setText('Must not move'); orphan.addToPage(first, position);
    const orphanWidget = orphan.acroField.getWidgets()[0];
    orphanWidget.dict.delete(PDFName.of('P')); first.node.removeAnnot(pdf.context.getObjectRef(orphanWidget.dict)!);
    const last = pdf.getForm().createTextField('Second no P'); last.setText('Second value'); last.addToPage(second, position);
    last.acroField.getWidgets()[0].dict.delete(PDFName.of('P'));
    const input = asBuffer(await pdf.save()), before = new Uint8Array(input.slice(0));
    await expect(flattenForm(input)).rejects.toThrow('Orphan');
    expect(new Uint8Array(input)).toEqual(before);
    const reread = await PDFDocument.load(input);
    expect(reread.getForm().getFields().map(field => reread.getForm().getTextField(field.getName()).getText()))
      .toEqual(['First value', 'Must not move', 'Second value']);
    expect(reread.getPage(1).node.Annots()?.size()).toBe(1);
  });

  it.each(['missing appearance', 'missing selected state', 'invalid matrix', 'XFA'])('rejects %s before any widget is removed', async failure => {
    const pdf = await PDFDocument.create(), page = pdf.addPage();
    const good = pdf.getForm().createTextField('Good'); good.setText('Keep'); good.addToPage(page, position);
    const field = pdf.getForm().createCheckBox('Invalid'); field.addToPage(page); field.check();
    const widget = field.acroField.getWidgets()[0];
    if (failure === 'missing appearance') widget.dict.delete(PDFName.of('AP'));
    else if (failure === 'missing selected state') widget.dict.set(PDFName.of('AS'), PDFName.of('Missing'));
    else if (failure === 'invalid matrix') {
      const appearance = widget.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFDict).lookup(widget.getAppearanceState()!);
      (appearance as import('pdf-lib').PDFStream).dict.set(PDFName.of('Matrix'), pdf.context.obj([1, 0, 0, 0, 0, 0]));
    } else pdf.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('XFA'), pdf.context.obj([]));
    const input = asBuffer(await pdf.save({ updateFieldAppearances: false }));
    await expect(flattenForm(input)).rejects.toThrow('Could not flatten form:');
  });

  it('propagates unreadable input instead of reporting an empty or flattened form', async () => {
    const invalid = new Uint8Array([1, 2, 3]).buffer;
    await expect(flattenForm(invalid)).rejects.toThrow('Could not flatten form:');
    await expect(getFormFieldCount(invalid)).rejects.toThrow();
    await expect(isFlattened(invalid)).rejects.toThrow();
  });

  it('rejects pure XFA and encrypted PDFs in both flattening and inspection helpers', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ XFA: [], Fields: [] }));
    const xfa = asBuffer(await pdf.save({ updateFieldAppearances: false }));
    for (const inspect of [flattenForm, getFormFieldCount, isFlattened]) await expect(inspect(xfa)).rejects.toThrow('XFA');
    const plain = await PDFDocument.create(); plain.addPage();
    const protectedPDF = new mupdf.PDFDocument(await plain.save());
    const encrypted = protectedPDF.saveToBuffer({ encrypt: 'aes-256', 'user-password': 'secret', 'owner-password': 'owner' });
    let protectedBytes: ArrayBuffer;
    try { protectedBytes = new Uint8Array(encrypted.asUint8Array()).buffer; }
    finally { encrypted.destroy(); protectedPDF.destroy(); }
    for (const inspect of [flattenForm, getFormFieldCount, isFlattened]) await expect(inspect(protectedBytes)).rejects.toThrow(/encrypted/);
  });
});
