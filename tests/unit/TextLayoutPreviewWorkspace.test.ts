import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { previewWorkspaceTextEdit } from '../../src/core/TextLayoutPreviewWorkspace';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { createTextLayoutPDF, LAYOUT_ORIGINAL, LAYOUT_NEIGHBOR } from '../fixtures/textLayoutPDF';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

const block: TextBlock = { id: 'title', pageNumber: 1, text: LAYOUT_ORIGINAL, editable: true,
  rect: { x: 30, y: 68, width: 75, height: 12 },
  lines: [{ text: LAYOUT_ORIGINAL, x: 30, y: 68, width: 75, height: 12, baseline: 80, items: [] }],
  style: { fontName: 'Helvetica-Bold', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
const edit: TextEditOperation = { blockId: 'title', originalText: LAYOUT_ORIGINAL, newText: 'A longer replacement with 中文 and two lines', timestamp: 2,
  layout: { targetRect: { x: 30, y: 150, width: 300, height: 90 }, fontSize: 16, alignment: 'left', lineHeight: 1.3 } };
async function fixture() {
  const data = new Uint8Array(await createTextLayoutPDF()).buffer;
  const workspace = createWorkspace(await extractFormFields(data));
  workspace.form.fields.forEach(field => { field.value = 'Current form draft'; }); workspace.form.isDirty = true;
  workspace.annotations.set(2, [createStickyNoteAnnotation(2, { x: 60, y: 60 }, 'Current note draft')]);
  workspace.editing.textBlocks.set(1, [structuredClone(block)]);
  workspace.editing.textEdits.push({ blockId: 'title', originalText: LAYOUT_ORIGINAL, newText: 'Prior draft', timestamp: 1 });
  workspace.editing.textBlocks.get(1)![0].text = 'Prior draft';
  workspace.editing.isDirty = true;
  return { data, workspace };
}
function inspect(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}

describe('text layout preview of the current workspace', () => {
  it.each(['XFA', 'signature'] as const)('rejects raw %s before writing current form values in preview or regular export', async kind => {
    const { data, workspace } = await fixture(), document = await PDFDocument.load(data);
    if (kind === 'XFA') document.getForm().acroForm.dict.set(PDFName.of('XFA'), document.context.register(document.context.stream('<xfa>dynamic form</xfa>')));
    else document.catalog.set(PDFName.of('Perms'), document.context.obj({ DocMDP: document.context.register(document.context.obj({
      Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('1234'),
    })) }));
    const source = new Uint8Array(await document.save({ updateFieldAppearances: false })).buffer;
    const before = structuredClone(workspace), message = kind === 'XFA' ? /XFA/ : /sign|certif/i;
    await expect(previewWorkspaceTextEdit(source, workspace, edit)).rejects.toThrow(message);
    await expect(exportWorkspacePDF(source, workspace)).rejects.toThrow(message);
    expect(workspace).toEqual(before);
  });

  it('replaces only the selected draft, retains neighboring text and current fields, and leaves its source untouched', async () => {
    const { data, workspace } = await fixture(), source = data.slice(0), snapshot = structuredClone(workspace);
    const output = await previewWorkspaceTextEdit(data, workspace, edit);
    const text = inspect(output).replace(/\s+/g, ' ');
    expect(text).toContain(edit.newText); expect(text).toContain(LAYOUT_NEIGHBOR);
    expect(text).not.toContain(LAYOUT_ORIGINAL); expect(text).not.toContain('Prior draft');
    expect((await PDFDocument.load(output)).getForm().getTextField('Contact').getText()).toBe('Current form draft');
    expect(data).toEqual(source); expect(workspace).toEqual(snapshot);
  });

  it('previews reset to the original text without replaying the prior layout draft', async () => {
    const { data, workspace } = await fixture();
    workspace.editing.textEdits[0].layout = edit.layout;
    const output = await previewWorkspaceTextEdit(data, workspace, { ...edit, newText: LAYOUT_ORIGINAL, layout: undefined });
    expect(inspect(output)).toContain(LAYOUT_ORIGINAL);
    expect(inspect(output)).not.toContain('Prior draft');
    expect(workspace.editing.textEdits[0].layout).toEqual(edit.layout);
  });

  it('rejects missing blocks, pending removal and canceled work without altering drafts', async () => {
    const { data, workspace } = await fixture(), snapshot = structuredClone(workspace);
    await expect(previewWorkspaceTextEdit(data, workspace, { ...edit, blockId: 'missing' })).rejects.toThrow('unavailable');
    const controller = new AbortController(); controller.abort();
    await expect(previewWorkspaceTextEdit(data, workspace, edit, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workspace).toEqual(snapshot);
    workspace.editing.redactions.push({ id: 'removal', pageNumber: 1, rect: block.rect, overlayColor: '#000000', applied: false });
    await expect(previewWorkspaceTextEdit(data, workspace, edit)).rejects.toThrow('Apply or discard');
  });
});
