import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { preparePDFLinksWorkspace, previewPDFLinksWorkspace, applyPDFLinksWorkspace } from '../../src/core/PDFLinksWorkspace';
import { inspectPDFLinks } from '../../src/core/PDFLinks';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { createLinksPDF } from '../fixtures/linksPDF';
import type { PDFLinkOperation } from '../../src/core/PDFLinkTypes';

async function fixture() {
  const data = new Uint8Array(await createLinksPDF()).buffer, workspace = createWorkspace(await extractFormFields(data));
  workspace.form.fields.forEach(field => { field.value = 'Current 中文 form'; }); workspace.form.isDirty = true;
  workspace.editing.textBlocks.set(1, [{ id: 'body', pageNumber: 1, text: 'Edited body', editable: true,
    rect: { x: 30, y: 68, width: 140, height: 12 }, lines: [{ items: [], text: 'Original link body', x: 30, y: 68, width: 100, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } }]);
  workspace.editing.textEdits.push({ blockId: 'body', originalText: 'Original link body', newText: 'Edited body', timestamp: 1 }); workspace.editing.isDirty = true;
  workspace.annotations.set(1, [createStickyNoteAnnotation(1, { x: 250, y: 70 }, 'Link workspace note')]);
  return { data, workspace };
}
function inspectAppearance(data: Uint8Array | ArrayBuffer) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), content = page.toStructuredText('');
  try {
    const notes = page.getAnnotations();
    try { return { text: content.asText(), notes: notes.filter(note => note.getType() === 'Text').map(note => note.getContents()) }; }
    finally { notes.forEach(note => note.destroy()); }
  } finally { content.destroy(); page.destroy(); pdf.destroy(); }
}

describe('native link editing with current workspace drafts', () => {
  it('prepares body and form values once, previews working notes, and commits one editable workspace', async () => {
    const { data, workspace } = await fixture(), before = structuredClone(workspace), source = data.slice(0);
    const prepared = await preparePDFLinksWorkspace(data, workspace);
    expect(prepared.report.links).toHaveLength(4);
    expect(inspectAppearance(prepared.data).text).toContain('Edited body'); expect(inspectAppearance(prepared.data).text).not.toContain('Original link body');
    const link = prepared.report.links.find(item => item.definition?.target.type === 'url')!;
    const operations: PDFLinkOperation[] = [{ type: 'update', id: link.id, definition: { ...link.definition!, target: { type: 'url', url: 'https://example.org/updated' } } }];
    const control = { expectedRevision: prepared.report.revision };
    const preview = await previewPDFLinksWorkspace(prepared.data, workspace, operations, control);
    expect(inspectAppearance(preview).notes).toEqual(['Link workspace note']);
    const result = await applyPDFLinksWorkspace(prepared.data, workspace, operations, control);
    expect(inspectAppearance(result.data).notes).toEqual([]);
    expect(result.workspace.annotations).toEqual(workspace.annotations);
    expect(result.workspace.editing.textEdits).toEqual([]); expect(result.workspace.editing.textBlocks.size).toBe(0);
    expect(result.workspace.form.fields[0].value).toBe('Current 中文 form'); expect(result.workspace.form.isDirty).toBe(false);
    const output = await exportWorkspacePDF(new Uint8Array(result.data).buffer, result.workspace);
    expect(inspectAppearance(output)).toEqual(inspectAppearance(preview));
    expect((await inspectPDFLinks(new Uint8Array(output).buffer)).links.some(item => item.definition?.target.type === 'url' && item.definition.target.url === 'https://example.org/updated')).toBe(true);
    expect((await PDFDocument.load(output)).getForm().getTextField('Contact').getText()).toBe('Current 中文 form');
    expect(workspace).toEqual(before); expect(data).toEqual(source);
  });

  it('shows current notes even for a no-change preview, without consuming any drafts', async () => {
    const { data, workspace } = await fixture(), before = structuredClone(workspace), prepared = await preparePDFLinksWorkspace(data, workspace);
    const preview = await previewPDFLinksWorkspace(prepared.data, workspace, [], { expectedRevision: prepared.report.revision });
    expect(inspectAppearance(preview).notes).toEqual(['Link workspace note']); expect(workspace).toEqual(before);
  });

  it.each(['XFA', 'signature'] as const)('checks original %s before form/content writers normalize the source', async kind => {
    const { data, workspace } = await fixture(), pdf = await PDFDocument.load(data);
    if (kind === 'XFA') pdf.getForm().acroForm.dict.set(PDFName.of('XFA'), pdf.context.register(pdf.context.stream('<xfa/>')));
    else pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('1234') })) }));
    const bytes = new Uint8Array(await pdf.save({ updateFieldAppearances: false })).buffer, before = structuredClone(workspace);
    const result = await preparePDFLinksWorkspace(bytes, workspace);
    expect(result.report.canEdit).toBe(false); expect(result.data).toEqual(bytes); expect(workspace).toEqual(before);
  });

  it('rejects pending removal and canceled or stale work without changing the source snapshot', async () => {
    const { data, workspace } = await fixture(), before = structuredClone(workspace), prepared = await preparePDFLinksWorkspace(data, workspace);
    const controller = new AbortController(); controller.abort();
    await expect(preparePDFLinksWorkspace(data, workspace, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(applyPDFLinksWorkspace(prepared.data, workspace, [], { expectedRevision: 'old revision' })).rejects.toThrow(/changed|revision/i);
    expect(workspace).toEqual(before);
    workspace.editing.redactions.push({ id: 'pending', pageNumber: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, overlayColor: '#000000', applied: false });
    await expect(preparePDFLinksWorkspace(data, workspace)).rejects.toThrow('Apply or discard');
  });
});
