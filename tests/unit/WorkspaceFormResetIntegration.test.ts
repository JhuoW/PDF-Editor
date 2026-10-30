import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { performPageManagement } from '../../src/core/PageManagementWorkspace';
import { preparePDFLinksWorkspace } from '../../src/core/PDFLinksWorkspace';
import { preparePDFBookmarksWorkspace } from '../../src/core/PDFBookmarksWorkspace';
import { prepareCleanupPDF, prepareVisibleWorkspacePDF } from '../../src/core/DocumentCleanupWorkspace';

describe('form resets across native editing workflows', () => {
  it.each(['links', 'bookmarks', 'cleanup', 'visible-copy'] as const)('keeps reset values after prior page edits when preparing %s', async workflow => {
    const pdf = await PDFDocument.create(), sheet = pdf.addPage([400, 500]);
    const field = pdf.getForm().createTextField('Contact'); field.setText('Original');
    field.addToPage(sheet, { x: 30, y: 300, width: 200, height: 30 });
    const data = new Uint8Array(await pdf.save()).buffer;
    const workspace = createWorkspace(await extractFormFields(data));
    workspace.form.fields[0].value = 'Edited'; workspace.form.isDirty = true;
    const cropped = await performPageManagement(data, workspace, { action: 'crop', pages: [1], margins: { top: 1, right: 1, bottom: 1, left: 1 } });
    expect((await extractFormFields(new Uint8Array(cropped.data).buffer))[0].value).toBe('Edited');
    const next = cropped.workspace;
    next.form.fields.forEach(item => { item.value = structuredClone(next.form.originalValues.get(item.id)!); });
    next.form.isDirty = false;
    const source = new Uint8Array(cropped.data).buffer;
    const prepared = workflow === 'links' ? (await preparePDFLinksWorkspace(source, next)).data
      : workflow === 'bookmarks' ? (await preparePDFBookmarksWorkspace(source, next)).data
      : workflow === 'cleanup' ? (await prepareCleanupPDF(source, next)).data
      : await prepareVisibleWorkspacePDF(source, next);
    expect((await extractFormFields(new Uint8Array(prepared).buffer))[0].value).toBe('Original');
    expect(next.form.fields[0].value).toBe('Original');
    expect((await extractFormFields(source))[0].value).toBe('Edited');
  });
});
