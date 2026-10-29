import { describe, expect, it } from 'vitest';
import { PDFBool, PDFDocument, PDFDropdown, PDFHexString, PDFName, PDFNumber, PDFOptionList, PDFString, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { updateUnicodeChoiceAppearances } from '../../src/forms/UnicodeChoiceAppearance';

const key = PDFName.of;
const options = [{ value: 'bj', label: '北京 café' }, { value: 'sh', label: '上海 Ελληνικά' }, { value: 'gz', label: '广州 Привет' }];
function setChoices(pdf: PDFDocument, field: PDFDropdown | PDFOptionList, selected: number[], entries = options) {
  field.acroField.setOptions(entries.map(option => ({ value: PDFHexString.fromText(option.value), display: PDFHexString.fromText(option.label) })));
  const values = selected.map(index => PDFHexString.fromText(entries[index].value));
  field.acroField.dict.set(key('V'), values.length === 1 ? values[0] : pdf.context.obj(values));
  field.acroField.dict.set(key('I'), pdf.context.obj(selected));
  field.acroField.dict.set(key('DV'), PDFHexString.fromText(entries[0]?.value ?? ''));
}
function inspect(data: Uint8Array, pageNumber = 0, name?: string) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(pageNumber), widgets = page.getWidgets();
  try {
    const widget = name ? widgets.find(widget => widget.getName() === name)! : widgets[0];
    const list = widget.toDisplayList(), text = list.toStructuredText(''), pixmap = list.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    try {
      return { text: text.asText(), width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: new Uint8Array(pixmap.getPixels()) };
    } finally { pixmap.destroy(); text.destroy(); list.destroy(); }
  } finally { for (const widget of widgets) widget.destroy(); page.destroy(); document.destroy(); }
}
const compact = (value: string) => value.replace(/\s/g, '');

describe('Unicode native choice appearances', () => {
  it('draws Unicode dropdown labels in shared no-P widgets, preserves values/defaults/flags, and embeds CJK only once', async () => {
    const pdf = await PDFDocument.create(), form = pdf.getForm();
    pdf.setCreator('Original creator'); pdf.setProducer('Original producer'); pdf.setModificationDate(new Date('2020-01-02T00:00:00Z'));
    const field = form.createDropdown('country'); field.enableEditing(); field.enableRequired();
    for (let index = 0; index < 2; index++) field.addToPage(pdf.addPage([400, 600]), { x: 30, y: 400, width: 300, height: 40 });
    field.setFontSize(14); setChoices(pdf, field, [1]);
    for (const widget of field.acroField.getWidgets()) widget.dict.delete(key('P'));
    form.acroForm.dict.set(key('NeedAppearances'), PDFBool.True);
    const before = await pdf.save({ updateFieldAppearances: false }), copied = before.slice();
    const output = await updateUnicodeChoiceAppearances(before, new Set(['country']));
    const saved = await PDFDocument.load(output, { updateMetadata: false }), restored = saved.getForm().getDropdown('country');
    expect(restored.getSelected()).toEqual(['sh']); expect(restored.isEditable()).toBe(true); expect(restored.isRequired()).toBe(true); expect(restored.isReadOnly()).toBe(false);
    expect(restored.acroField.getOptions().map(item => [item.value.decodeText(), item.display!.decodeText()])).toEqual(options.map(item => [item.value, item.label]));
    for (const entry of ['V', 'I', 'DV', 'Ff']) expect(restored.acroField.dict.get(key(entry))?.toString()).toBe(field.acroField.dict.get(key(entry))?.toString());
    expect(restored.acroField.dict.lookup(key('DA'), PDFString).decodeText()).toBe(field.acroField.dict.lookup(key('DA'), PDFString).decodeText());
    expect(saved.getCreator()).toBe('Original creator'); expect(saved.getProducer()).toBe('Original producer'); expect(saved.getModificationDate()).toEqual(new Date('2020-01-02T00:00:00Z'));
    expect(saved.getForm().acroForm.dict.get(key('NeedAppearances'))?.toString()).toBe('false');
    for (let index = 0; index < 2; index++) expect(compact(inspect(output, index).text)).toBe(compact(options[1].label));
    const native = new mupdf.PDFDocument(output), fonts = new Set<string>();
    try {
      for (let index = 0; index < 2; index++) {
        const page = native.loadPage(index), widget = page.getWidgets()[0], object = widget.getObject();
        const resources = object.get('AP', 'N', 'Resources', 'XObject', 'PDFEditorChoiceText', 'Resources', 'Font');
        try { resources.forEach(font => { const name = font.get('BaseFont'); try { if (name.asName().includes('Droid')) fonts.add(font.toString()); } finally { name.destroy(); font.destroy(); } }); }
        finally { resources.destroy(); object.destroy(); widget.destroy(); page.destroy(); }
      }
    } finally { native.destroy(); }
    expect(fonts.size).toBe(1); expect(before).toEqual(copied);
    // Updating an existing appearance replaces it instead of accumulating text.
    setChoices(saved, restored, [2]);
    const again = await updateUnicodeChoiceAppearances(await saved.save({ updateFieldAppearances: false }), new Set(['country']));
    expect(compact(inspect(again).text)).toBe(compact(options[2].label));
  });

  it('highlights all selected list rows and preserves custom background and border colors', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([400, 600]), field = pdf.getForm().createOptionList('cities');
    field.enableMultiselect(); field.addToPage(page, { x: 30, y: 300, width: 300, height: 100, backgroundColor: rgb(1, 1, 0), borderColor: rgb(1, 0, 0), borderWidth: 3 });
    field.setFontSize(14); setChoices(pdf, field, [0, 2]);
    const output = await updateUnicodeChoiceAppearances(await pdf.save({ updateFieldAppearances: false }), new Set(['cities']));
    const saved = await PDFDocument.load(output), restored = saved.getForm().getOptionList('cities');
    expect(restored.getSelected()).toEqual(['bj', 'gz']); expect(restored.isMultiselect()).toBe(true);
    expect(restored.acroField.dict.get(key('I'))?.toString()).toBe('[ 0 2 ]');
    const rendered = inspect(output);
    for (const option of options) expect(compact(rendered.text)).toContain(compact(option.label));
    let red = 0, yellow = 0, blueRows = 0, previousBlue = false;
    for (let y = 0; y < rendered.height; y++) {
      let rowBlue = 0;
      for (let x = 0; x < rendered.width; x++) {
        const [r, g, b] = rendered.pixels.slice((y * rendered.width + x) * 3, (y * rendered.width + x) * 3 + 3);
        if (r > 220 && g < 50 && b < 50) red++;
        if (r > 220 && g > 220 && b < 50) yellow++;
        if (r < 70 && g > 60 && g < 120 && b > 150) rowBlue++;
      }
      const blue = rowBlue > rendered.width / 2;
      if (blue && !previousBlue) blueRows++;
      previousBlue = blue;
    }
    expect(red).toBeGreaterThan(100); expect(yellow).toBeGreaterThan(100); expect(blueRows).toBe(2);
  });

  it.each([90, 180, 270])('positions Unicode text inside a rotated widget (%d) on CropBox/Rotate/UserUnit pages', async rotation => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([600, 700]);
    page.setCropBox(40, 70, 450, 500); page.setRotation(degrees(90)); page.node.set(key('UserUnit'), PDFNumber.of(2));
    const field = pdf.getForm().createDropdown('rotated');
    field.addToPage(page, { x: 250, y: 250, width: 160, height: 40, rotate: degrees(rotation), borderWidth: 2, borderColor: rgb(1, 0, 0), backgroundColor: rgb(1, 1, 0) });
    field.setFontSize(12); setChoices(pdf, field, [0]);
    const output = await updateUnicodeChoiceAppearances(await pdf.save({ updateFieldAppearances: false }), new Set(['rotated']));
    expect(compact(inspect(output).text)).toBe(compact(options[0].label));
    const native = new mupdf.PDFDocument(output), nativePage = native.loadPage(0), widget = nativePage.getWidgets()[0];
    const list = widget.toDisplayList(), text = list.toStructuredText(''), bounds = widget.getBounds();
    try {
      const boxes: number[][] = []; text.walk({ beginTextBlock(box) { boxes.push(box); } });
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) { expect(box[0]).toBeGreaterThanOrEqual(bounds[0]); expect(box[1]).toBeGreaterThanOrEqual(bounds[1]); expect(box[2]).toBeLessThanOrEqual(bounds[2]); expect(box[3]).toBeLessThanOrEqual(bounds[3]); }
      expect((await PDFDocument.load(output)).getForm().getDropdown('rotated').getSelected()).toEqual(['bj']);
    } finally { text.destroy(); list.destroy(); widget.destroy(); nativePage.destroy(); native.destroy(); }
  });

  it('scrolls a list to later selections without losing them and keeps labels in native Opt', async () => {
    const pdf = await PDFDocument.create(), field = pdf.getForm().createOptionList('many');
    field.enableMultiselect(); field.addToPage(pdf.addPage(), { x: 40, y: 300, width: 200, height: 45 }); field.setFontSize(12);
    const many = Array.from({ length: 20 }, (_, index) => ({ value: `v${index}`, label: `选项 ${index}` }));
    setChoices(pdf, field, [17, 19], many); field.acroField.dict.set(key('TI'), PDFNumber.of(17));
    const result = await updateUnicodeChoiceAppearances(await pdf.save({ updateFieldAppearances: false }), new Set(['many']));
    const restored = (await PDFDocument.load(result)).getForm().getOptionList('many');
    expect(restored.acroField.getOptions()).toHaveLength(20); expect(restored.getSelected()).toEqual(['v17', 'v19']);
    expect(restored.acroField.dict.get(key('TI'))?.toString()).toBe('17');
    const text = inspect(result).text; expect(text).toContain('17'); expect(text).toContain('19'); expect(text).not.toContain('选项 0');
  });

  it('rejects unsupported labels, unrenderable selections, and orphan widgets without modifying input bytes', async () => {
    for (const label of ['العربية', '中文😀', '跨\n行', '中文\0隐藏', '极'.repeat(3000)]) {
      const pdf = await PDFDocument.create(), page = pdf.addPage(), good = pdf.getForm().createDropdown('good'), bad = pdf.getForm().createDropdown('bad');
      for (const field of [good, bad]) field.addToPage(page, { x: 40, y: field === good ? 400 : 300, width: 120, height: 30 });
      setChoices(pdf, good, [0]); setChoices(pdf, bad, [0], [{ label, value: 'bad' }]);
      const data = await pdf.save({ updateFieldAppearances: false }), before = data.slice();
      await expect(updateUnicodeChoiceAppearances(data, new Set(['good', 'bad']))).rejects.toThrow(/complex-script|unsupported character|line break|legibly/);
      expect(data).toEqual(before);
    }
    const pdf = await PDFDocument.create(), page = pdf.addPage(), field = pdf.getForm().createDropdown('orphan');
    field.addToPage(page, { x: 40, y: 300, width: 120, height: 30 }); setChoices(pdf, field, [0]);
    const widget = field.acroField.getWidgets()[0]; page.node.removeAnnot(pdf.context.getObjectRef(widget.dict)!); widget.dict.delete(key('P'));
    const data = await pdf.save({ updateFieldAppearances: false }), before = data.slice();
    await expect(updateUnicodeChoiceAppearances(data, new Set(['orphan']))).rejects.toThrow('unambiguous page'); expect(data).toEqual(before);
  });
});
