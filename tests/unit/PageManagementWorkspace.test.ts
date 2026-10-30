import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { performPageManagement } from '../../src/core/PageManagementWorkspace';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { createFreeTextAnnotation, createRectangleAnnotation, createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { serializeAnnotationsToPDF } from '../../src/annotations/AnnotationSerializer';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
async function fixture() {
  const pdf = await PDFDocument.create(), first = pdf.addPage([400, 300]);
  first.drawText('Original page body', { x: 30, y: 240, size: 12 });
  pdf.addPage([400, 300]).drawText('Second page body', { x: 30, y: 240, size: 12 });
  const field = pdf.getForm().createTextField('Contact'); field.setText('Original form');
  field.addToPage(first, { x: 30, y: 140, width: 230, height: 24 });
  const data = buffer(await pdf.save()), workspace = createWorkspace(await extractFormFields(data));
  workspace.form.fields[0].value = 'Current 中文 form'; workspace.form.isDirty = true;
  workspace.editing.textBlocks.set(1, [{ id: 'body', pageNumber: 1, text: 'Edited page body', editable: true,
    rect: { x: 30, y: 48, width: 180, height: 12 }, lines: [{ items: [], text: 'Original page body', x: 30, y: 48, width: 120, height: 12, baseline: 60 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } }]);
  workspace.editing.textEdits.push({ blockId: 'body', originalText: 'Original page body', newText: 'Edited page body', timestamp: 1 }); workspace.editing.isDirty = true;
  const note = createStickyNoteAnnotation(1, { x: 300, y: 250 }, 'Editable note');
  note.sourceNM = 'original-note'; note.replies = [{ id: 'original-reply', sourceNM: 'original-reply-nm', content: 'Editable reply', createdAt: new Date(0) }];
  workspace.annotations.set(1, [note, createFreeTextAnnotation(1, [30, 60, 220, 30], 'Editable overlay', { fontSize: 12 })]);
  workspace.annotations.set(2, [createRectangleAnnotation(2, [20, 20, 30, 40])]);
  return { data, workspace };
}
function inspect(data: Uint8Array | ArrayBuffer) {
  const pdf = new mupdf.PDFDocument(data);
  try {
    return Array.from({ length: pdf.countPages() }, (_, index) => {
      const page = pdf.loadPage(index), text = page.toStructuredText(''), notes = page.getAnnotations();
      try { return { text: text.asText(), notes: notes.filter(note => note.getType() === 'Text').map(note => note.getContents()) }; }
      finally { notes.forEach(note => note.destroy()); text.destroy(); page.destroy(); }
    });
  } finally { pdf.destroy(); }
}

describe('page management with editable workspace state', () => {
  it('keeps a form reset when a later page operation follows an operation that baked edited values', async () => {
    const { data, workspace } = await fixture();
    const first = await performPageManagement(data, workspace, { action: 'duplicate', pages: [1], beforePage: 1 });
    const reset = structuredClone(first.workspace);
    for (const field of reset.form.fields) field.value = structuredClone(reset.form.originalValues.get(field.id)!);
    reset.form.isDirty = false;
    const second = await performPageManagement(buffer(first.data), reset, { action: 'crop', pages: [2], margins: { top: 2, right: 2, bottom: 2, left: 2 } });
    const native = await PDFDocument.load(second.data);
    expect(native.getForm().getTextField('Contact').getText()).toBe('Original form');
    expect(native.getForm().getTextField('Contact_2').getText()).toBe('Current 中文 form');
    expect(second.workspace.form.fields.find(field => field.name === 'Contact')!.value).toBe('Original form');
    expect(second.workspace.form.isDirty).toBe(false);
  });

  it('duplicates current body/form edits and independent editable annotations while preserving the input snapshot', async () => {
    const { data, workspace } = await fixture(), source = data.slice(0), before = structuredClone(workspace);
    workspace.editing.redactions.push({ id: 'pending', pageNumber: 1, rect: { x: 280, y: 180, width: 20, height: 10 }, overlayColor: '#000000', applied: false });
    const withMark = structuredClone(workspace);
    const result = await performPageManagement(data, workspace, { action: 'duplicate', pages: [1], beforePage: 2 });
    expect([...result.pageMap]).toEqual([[1, 1], [2, 3]]);
    expect(inspect(result.data).map(page => page.text.includes('Edited page body'))).toEqual([true, true, false]);
    expect(inspect(result.data).every(page => page.notes.length === 0)).toBe(true);
    expect(result.workspace.editing.textEdits).toEqual([]); expect(result.workspace.editing.textBlocks.size).toBe(0);
    expect(result.workspace.annotations.get(3)).toEqual(before.annotations.get(2)!.map(annotation => ({ ...annotation, pageNumber: 3 })));
    const original = result.workspace.annotations.get(1)!, copy = result.workspace.annotations.get(2)!;
    expect(copy.map(annotation => annotation.id).some(id => original.some(annotation => annotation.id === id))).toBe(false);
    expect(copy[0].type).toBe('sticky-note');
    if (copy[0].type !== 'sticky-note') throw new Error('Expected copied note');
    expect(copy[0].sourceNM).toBeUndefined(); expect(copy[0].replies![0].sourceNM).toBeUndefined();
    expect(copy[0].replies![0].id).not.toBe('original-reply');
    expect(result.workspace.editing.redactions.map(area => area.pageNumber)).toEqual([1, 2]);
    expect(result.workspace.editing.redactions[1].id).not.toBe('pending');
    const native = await PDFDocument.load(result.data);
    expect(native.getForm().getTextField('Contact').getText()).toBe('Current 中文 form');
    expect(native.getForm().getTextField('Contact_2').getText()).toBe('Current 中文 form');
    const output = await exportWorkspacePDF(buffer(result.data), result.workspace);
    expect(inspect(output).slice(0, 2).map(page => page.notes)).toEqual([['Editable note', 'Editable reply'], ['Editable note', 'Editable reply']]);
    expect(inspect(output).slice(0, 2).every(page => page.text.match(/Editable overlay/g)?.length === 1)).toBe(true);
    expect(workspace).toEqual(withMark); expect(data).toEqual(source);
  });

  it('replaces target overlays and values with editable donor notes and fresh fields, retaining other pages', async () => {
    const { data, workspace } = await fixture(), before = structuredClone(workspace);
    const donor = await PDFDocument.create(), sheet = donor.addPage([250, 350]); sheet.drawText('Replacement body', { x: 20, y: 300, size: 12 });
    const field = donor.getForm().createTextField('Contact'); field.setText('Donor value'); field.addToPage(sheet, { x: 20, y: 200, width: 150, height: 24 });
    const donorNote = createStickyNoteAnnotation(1, { x: 200, y: 300 }, 'Incoming editable note');
    const incoming = await serializeAnnotationsToPDF(buffer(await donor.save()), new Map([[1, [donorNote]]]));
    const result = await performPageManagement(data, workspace, { action: 'replace', pages: [1], source: { data: buffer(incoming), pages: [1] } });
    expect(inspect(result.data)[0].text).toContain('Replacement body'); expect(inspect(result.data)[0].text).not.toContain('Edited page body');
    expect(inspect(result.data)[0].notes).toEqual([]);
    expect(result.workspace.annotations.get(1)).toHaveLength(1);
    expect(result.workspace.annotations.get(1)![0]).toMatchObject({ type: 'sticky-note', content: 'Incoming editable note', pageNumber: 1 });
    expect(result.workspace.annotations.get(2)).toEqual(before.annotations.get(2));
    expect(result.workspace.form.fields).toHaveLength(1); expect(result.workspace.form.fields[0].value).toBe('Donor value');
    expect(result.workspace.form.originalValues.get(result.workspace.form.fields[0].id)).toBe('Donor value');
    const output = await exportWorkspacePDF(buffer(result.data), result.workspace);
    expect(inspect(output)[0].notes).toEqual(['Incoming editable note']);
    expect((await PDFDocument.load(output)).getForm().getTextField('Contact').getText()).toBe('Donor value');
    expect(workspace).toEqual(before);
  });

  it('crops and resets rotated/UserUnit pages without moving absolute PDF annotations, and refreshes form geometry', async () => {
    const { data, workspace } = await fixture(), pdf = await PDFDocument.load(data), first = pdf.getPage(0);
    first.setCropBox(10, 20, 370, 260); first.setRotation(degrees(90)); first.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const source = buffer(await pdf.save());
    // The cached text block came from the uncropped page: this case only tests crop geometry.
    workspace.editing.textBlocks.clear(); workspace.editing.textEdits = []; workspace.form = createWorkspace(await extractFormFields(source)).form;
    workspace.editing.redactions.push({ id: 'applied', pageNumber: 1, rect: { x: 100, y: 60, width: 20, height: 10 }, overlayColor: '#000000', applied: true });
    const result = await performPageManagement(source, workspace, { action: 'crop', pages: [1], margins: { top: 10, right: 20, bottom: 30, left: 40 } });
    expect(result.workspace.annotations).toEqual(workspace.annotations);
    const crop = (await PDFDocument.load(result.data)).getPage(0).getCropBox();
    const area = result.workspace.editing.redactions[0].rect;
    expect(area.x).toBeCloseTo(100 + (10 - crop.x) * 2);
    expect(area.y).toBeCloseTo(60 + (crop.y + crop.height - 280) * 2);
    expect(result.workspace.form.fields[0].rect).not.toEqual(workspace.form.fields[0].rect);
    const reset = await performPageManagement(buffer(result.data), result.workspace, { action: 'crop', pages: [1], resetCrop: true });
    const resetPage = (await PDFDocument.load(reset.data)).getPage(0);
    expect(resetPage.getCropBox()).toEqual(resetPage.getMediaBox()); expect(reset.workspace.annotations).toEqual(workspace.annotations);
    expect(inspect(reset.data)[0].text).toContain('Original page body');
  });

  it('blocks cropping marked pages but allows cropping another page without losing pending marks', async () => {
    const { data, workspace } = await fixture();
    workspace.editing.redactions.push({ id: 'pending', pageNumber: 1, rect: { x: 280, y: 180, width: 20, height: 10 }, overlayColor: '#000000', applied: false });
    const before = structuredClone(workspace);
    await expect(performPageManagement(data, workspace, { action: 'crop', pages: [1], margins: { top: 5, right: 5, bottom: 5, left: 5 } })).rejects.toThrow('Apply or discard');
    const result = await performPageManagement(data, workspace, { action: 'crop', pages: [2], margins: { top: 5, right: 5, bottom: 5, left: 5 } });
    expect(result.workspace.editing.redactions).toEqual(workspace.editing.redactions); expect(workspace).toEqual(before);
  });

  it('rejects unsupported original sources and canceled requests before consuming drafts', async () => {
    const { data, workspace } = await fixture(), pdf = await PDFDocument.load(data), before = structuredClone(workspace);
    pdf.getForm().acroForm.dict.set(PDFName.of('XFA'), pdf.context.register(pdf.context.stream('<xfa/>')));
    await expect(performPageManagement(buffer(await pdf.save({ updateFieldAppearances: false })), workspace, { action: 'duplicate', pages: [1] })).rejects.toThrow('XFA');
    const controller = new AbortController(); controller.abort();
    await expect(performPageManagement(data, workspace, { action: 'duplicate', pages: [1] }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workspace).toEqual(before);
  });

  it('checks signed replacement sources before importing their notes or changing the current workspace', async () => {
    const { data, workspace } = await fixture(), donor = await PDFDocument.create(); donor.addPage();
    donor.catalog.set(PDFName.of('Perms'), donor.context.obj({ DocMDP: donor.context.register(donor.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('1234') })) }));
    const before = structuredClone(workspace);
    await expect(performPageManagement(data, workspace, { action: 'replace', pages: [1], source: { data: buffer(await donor.save()), pages: [1] } })).rejects.toThrow('Signed');
    expect(workspace).toEqual(before);
  });
});
