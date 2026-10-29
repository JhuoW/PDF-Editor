import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { prepareOptimizationPDF } from '../../src/core/PDFOptimizationWorkspace';
import { optimizePDF } from '../../src/core/PDFOptimizer';
import { DEFAULT_OPTIMIZER_SETTINGS } from '../../src/core/PDFOptimizerTypes';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';
import { createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { CLEANUP_SECRETS, decodedPDFStrings } from '../fixtures/cleanupPDF';
import { createOptimizationPDF } from '../fixtures/optimizationPDF';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';

// Keep the real preflight, PDF writers and optimizer; only omit the browser worker transport.
vi.mock('../../src/core/PDFOptimizerClient', async () => {
  const core = await import('../../src/core/PDFOptimizer');
  return { inspectPDFOptimizationInWorker: core.inspectPDFOptimization };
});
const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
function text(data: Uint8Array | ArrayBuffer) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), content = page.toStructuredText('');
  try { return content.asText(); } finally { content.destroy(); page.destroy(); pdf.destroy(); }
}
async function sourceWorkspace() {
  const imported = await importEditableAnnotations(buffer(await createOptimizationPDF()));
  const workspace = createWorkspace(await extractFormFields(imported.data));
  workspace.annotations = imported.annotations;
  workspace.form.fields.forEach(field => { field.value = 'Current 中文 field'; }); workspace.form.isDirty = true;
  workspace.annotations.set(2, [createStickyNoteAnnotation(2, { x: 50, y: 50 }, 'Working compression note')]);
  workspace.editing.textBlocks.set(1, [{ id: 'body', pageNumber: 1, text: 'Original body text', editable: true,
    rect: { x: 30, y: 60, width: 220, height: 40 },
    lines: [{ items: [], text: 'Original body text', x: 30, y: 68, width: 120, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } }]);
  workspace.editing.textEdits.push({ blockId: 'body', originalText: 'Original body text', newText: 'Updated compression body', timestamp: 1 });
  return { data: imported.data, workspace };
}

describe('compression of an editable workspace snapshot', () => {
  it('preserves current text, Unicode fields, native/working notes and document structures without changing the workspace', async () => {
    const { data, workspace } = await sourceWorkspace(), before = structuredClone(workspace), original = Buffer.from(data);
    const prepared = await prepareOptimizationPDF(data, workspace);
    const result = await optimizePDF(prepared, DEFAULT_OPTIMIZER_SETTINGS);
    expect(result.outputBytes).toBeLessThanOrEqual(prepared.byteLength);
    expect(text(result.data)).toContain('Updated compression body'); expect(text(result.data)).not.toContain('Original body text');
    const output = await PDFDocument.load(result.data, { updateMetadata: false });
    expect(output.getForm().getTextField('Contact').getText()).toBe('Current 中文 field');
    expect(output.catalog.has(PDFName.of('Outlines'))).toBe(true);
    const strings = await decodedPDFStrings(result.data);
    for (const retained of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.metadata, CLEANUP_SECRETS.comment, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.script, CLEANUP_SECRETS.defaultValue,
      'Working compression note', 'Second page bookmark', 'https://example.com/review']) expect(strings).toContain(retained);
    const source = new mupdf.PDFDocument(prepared), copy = new mupdf.PDFDocument(result.data);
    try {
      for (let index = 0; index < 2; index++) {
        const a = source.loadPage(index), b = copy.loadPage(index);
        const first = a.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true), second = b.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
        try { expect(Buffer.from(first.getPixels()).equals(Buffer.from(second.getPixels()))).toBe(true); }
        finally { second.destroy(); first.destroy(); b.destroy(); a.destroy(); }
      }
    } finally { copy.destroy(); source.destroy(); }
    expect(workspace).toEqual(before); expect(Buffer.from(data).equals(original)).toBe(true);
  }, 20_000);

  it('rejects a pending content-removal selection and an aborted preparation without consuming drafts', async () => {
    const { data, workspace } = await sourceWorkspace();
    workspace.editing.redactions.push({ id: 'pending', pageNumber: 1, rect: { x: 0, y: 0, width: 20, height: 20 }, overlayColor: '#000000', applied: false });
    const before = structuredClone(workspace);
    await expect(prepareOptimizationPDF(data, workspace)).rejects.toThrow('Apply or discard');
    const controller = new AbortController(); controller.abort();
    await expect(prepareOptimizationPDF(data, workspace, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(workspace).toEqual(before);
  });

  it.each(['XFA', 'signature'] as const)('checks the raw %s source before form export can rewrite it', async kind => {
    const { data, workspace } = await sourceWorkspace(), pdf = await PDFDocument.load(data, { updateMetadata: false });
    if (kind === 'XFA') pdf.getForm().acroForm.dict.set(PDFName.of('XFA'), pdf.context.register(pdf.context.stream('<xfa>dynamic form</xfa>')));
    else {
      const signature = pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: PDFHexString.of('1234') }));
      pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: signature }));
    }
    const source = new Uint8Array(await pdf.save({ updateFieldAppearances: false })), before = structuredClone(workspace);
    await expect(prepareOptimizationPDF(buffer(source), workspace)).rejects.toThrow(kind === 'XFA' ? /XFA/ : /sign|certif/i);
    expect(workspace).toEqual(before);
  });

  it.each(['lossless', 'images'] as const)('keeps decorations manageable after %s compression with pending form edits', async mode => {
    const data = await createOptimizationPDF();
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 48, 32], true);
    let png: Uint8Array;
    try {
      const pixels = pixmap.getPixels();
      for (let index = 0; index < pixels.length; index += 4) { pixels[index] = 220; pixels[index + 1] = 30; pixels[index + 2] = 40; pixels[index + 3] = 255; }
      png = new Uint8Array(pixmap.asPNG());
    } finally { pixmap.destroy(); }
    const decorated = await applyPageDecorations(buffer(data), [{ type: 'create', definition: {
      kind: 'watermark', name: 'Preserve image mark', pages: [1, 2], opacity: .5, angle: 0, layer: 'foreground',
      position: { anchor: 'top-right', offsetX: -15, offsetY: 15 }, content: { type: 'image', name: 'mark.png', data: png, width: 48, height: 32 },
    } }]);
    const workspace = createWorkspace(await extractFormFields(buffer(decorated)));
    workspace.form.fields.forEach(field => { field.value = 'Keep 中文'; }); workspace.form.isDirty = true;
    const prepared = await prepareOptimizationPDF(buffer(decorated), workspace);
    const result = await optimizePDF(prepared, { ...DEFAULT_OPTIMIZER_SETTINGS, mode });
    const inspection = await inspectPageDecorations(buffer(result.data));
    expect(inspection.decorations).toHaveLength(1); expect(inspection.decorations[0].managed).toBe(true);
    expect(inspection.decorations[0].pages).toEqual([1, 2]);
    const removed = await applyPageDecorations(buffer(result.data), [{ type: 'remove', id: inspection.decorations[0].id }]);
    expect((await inspectPageDecorations(buffer(removed))).decorations).toHaveLength(0);
    expect((await PDFDocument.load(removed, { updateMetadata: false })).getForm().getTextField('Contact').getText()).toBe('Keep 中文');
    expect(workspace.form.isDirty).toBe(true);
  }, 20_000);
});
