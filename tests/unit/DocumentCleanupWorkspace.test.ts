import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { prepareCleanupPDF, cleanWorkspacePDF, prepareVisibleWorkspacePDF, previewCleanupWorkspace } from '../../src/core/DocumentCleanupWorkspace';
import { inspectPDFCleanup } from '../../src/core/DocumentCleanup';
import { createVisibleCopy } from '../../src/core/VisibleCopy';
import type { CleanupOptions } from '../../src/core/DocumentCleanupTypes';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';
import { createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';
import { applyWorkspaceContent } from '../../src/core/PDFExport';
import { CLEANUP_SECRETS, createCleanupPDF, decodedPDFStrings } from '../fixtures/cleanupPDF';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
const options = (selected: Partial<CleanupOptions> = {}): CleanupOptions => ({ metadata: false, attachments: false, activeContent: false, comments: false, links: false, forms: false, privateData: false, ...selected });
function pageText(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}
function pagePixels(data: Uint8Array | ArrayBuffer) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), pixels = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return Buffer.from(pixels.getPixels()); } finally { pixels.destroy(); page.destroy(); pdf.destroy(); }
}
async function sourceWorkspace() {
  const imported = await importEditableAnnotations(buffer(await createCleanupPDF()));
  const data = new Uint8Array(imported.data);
  const workspace = createWorkspace(await extractFormFields(buffer(data)));
  workspace.annotations = imported.annotations;
  workspace.form.fields.forEach(field => { field.value = 'Current 中文 value'; }); workspace.form.isDirty = true;
  workspace.editing.textBlocks.set(1, [{ id: 'body', pageNumber: 1, text: 'Original body text', editable: true,
    rect: { x: 30, y: 60, width: 220, height: 40 },
    lines: [{ items: [], text: 'Original body text', x: 30, y: 68, width: 120, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } }]);
  workspace.editing.textEdits.push({ blockId: 'body', originalText: 'Original body text', newText: 'Updated body', timestamp: 1 });
  return { data, workspace };
}

describe('document cleanup with the editable workspace', () => {
  it('removes selected native and working comments while committing pending text and Unicode form values once', async () => {
    const { data, workspace } = await sourceWorkspace(), before = structuredClone(workspace);
    const cleaned = await cleanWorkspacePDF(buffer(data), workspace, options({ metadata: true, attachments: true, activeContent: true, comments: true }));
    expect(pageText(cleaned.data)).toContain('Updated body'); expect(pageText(cleaned.data)).not.toContain('Original body text');
    expect(cleaned.workspace.annotations.size).toBe(0); expect(cleaned.workspace.editing.textEdits).toEqual([]);
    expect(cleaned.workspace.form.fields[0].value).toBe('Current 中文 value'); expect(cleaned.workspace.form.isDirty).toBe(false);
    const exported = await exportWorkspacePDF(buffer(cleaned.data), cleaned.workspace), strings = await decodedPDFStrings(exported);
    for (const secret of [CLEANUP_SECRETS.author, CLEANUP_SECRETS.metadata, CLEANUP_SECRETS.attachment, CLEANUP_SECRETS.script, CLEANUP_SECRETS.comment]) expect(strings).not.toContain(secret);
    expect(strings).toContain('Current 中文 value');
    const report = await inspectPDFCleanup(buffer(exported));
    for (const category of ['metadata', 'attachments', 'activeContent', 'comments'] as const) expect(report.counts[category]).toBe(0);
    expect(workspace).toEqual(before);
  });

  it('keeps annotations editable when only metadata is removed and does not recreate Info on subsequent export', async () => {
    const { data, workspace } = await sourceWorkspace();
    const cleaned = await cleanWorkspacePDF(buffer(data), workspace, options({ metadata: true }));
    expect(cleaned.workspace.annotations).toEqual(workspace.annotations);
    const preview = await previewCleanupWorkspace(cleaned.data, cleaned.workspace, options({ metadata: true }));
    expect(await decodedPDFStrings(preview)).toContain(CLEANUP_SECRETS.comment);
    expect((await PDFDocument.load(preview, { updateMetadata: false })).context.trailerInfo.Info).toBeUndefined();
    const exported = await exportWorkspacePDF(buffer(cleaned.data), cleaned.workspace);
    expect((await inspectPDFCleanup(buffer(exported))).counts.metadata).toBe(0);
    expect(await decodedPDFStrings(exported)).toContain(CLEANUP_SECRETS.comment);
    const reopened = await importEditableAnnotations(buffer(exported));
    expect((await inspectPDFCleanup(reopened.data)).counts.metadata).toBe(0);
  });

  it('removes fields, widgets, values and defaults from both the file and the current workspace', async () => {
    const { data, workspace } = await sourceWorkspace();
    const cleaned = await cleanWorkspacePDF(buffer(data), workspace, options({ forms: true, comments: true, links: true }));
    const exported = await exportWorkspacePDF(buffer(cleaned.data), cleaned.workspace);
    expect(cleaned.workspace.form.fields).toEqual([]);
    const pdf = await PDFDocument.load(exported, { updateMetadata: false });
    expect(pdf.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    const strings = await decodedPDFStrings(exported);
    for (const secret of [CLEANUP_SECRETS.form, CLEANUP_SECRETS.defaultValue, 'Current 中文 value', CLEANUP_SECRETS.comment, 'https://example.com/review']) expect(strings).not.toContain(secret);
    expect(pageText(exported)).toContain('Updated body');
  });

  it('rejects pending redaction selections before creating a visible copy and leaves drafts untouched', async () => {
    const { data, workspace } = await sourceWorkspace(), original = new Uint8Array(data);
    workspace.editing.redactions.push({ id: 'pending', pageNumber: 1, rect: { x: 0, y: 0, width: 20, height: 20 }, overlayColor: '#000000', applied: false });
    await expect(prepareVisibleWorkspacePDF(buffer(data), workspace)).rejects.toThrow('Apply or discard');
    expect(data).toEqual(original); expect(workspace.editing.textEdits).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    await expect(prepareCleanupPDF(buffer(data), workspace, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('removes decoration templates without changing their appearance or allowing a later body edit to erase them', async () => {
    const { data, workspace } = await sourceWorkspace();
    workspace.editing.textEdits = [];
    const marked = await applyPageDecorations(buffer(data), [{ type: 'create', definition: {
      kind: 'watermark', name: 'PRIVATE_TEMPLATE_NAME', pages: [1], opacity: .5, angle: 0, layer: 'foreground',
      position: { anchor: 'top-left', offsetX: 30, offsetY: 60 }, content: { type: 'text', text: 'KEEP VISIBLE MARK', fontFamily: 'Helvetica', fontSize: 12, color: '#FF0000' },
    } }]);
    const prepared = await prepareCleanupPDF(buffer(marked), workspace);
    const cleaned = await cleanWorkspacePDF(buffer(marked), workspace, options({ privateData: true }));
    expect(pagePixels(cleaned.data).equals(pagePixels(prepared.data))).toBe(true);
    expect(await decodedPDFStrings(cleaned.data)).not.toContain('PRIVATE_TEMPLATE_NAME');
    expect(pageText(cleaned.data)).toContain('KEEP VISIBLE MARK');
    const report = await inspectPageDecorations(buffer(cleaned.data));
    expect(report.decorations.length).toBeGreaterThan(0); expect(report.decorations.every(item => !item.managed)).toBe(true);
    workspace.editing.textEdits.push({ blockId: 'body', originalText: 'Original body text', newText: 'Changed', timestamp: 1 });
    await expect(applyWorkspaceContent(buffer(cleaned.data), workspace)).rejects.toThrow('missing or changed editing metadata');
  });

  it('creates an independent visible copy with current content and field appearances but no source payloads', async () => {
    const { data, workspace } = await sourceWorkspace();
    workspace.annotations.set(2, [createStickyNoteAnnotation(2, { x: 50, y: 50 }, 'Working note payload')]);
    const prepared = await prepareVisibleWorkspacePDF(buffer(data), workspace);
    const copy = await createVisibleCopy(prepared);
    expect(copy.pageCount).toBe(2); expect(pageText(copy.data).trim()).toBe('');
    const strings = await decodedPDFStrings(copy.data);
    for (const secret of [...Object.values(CLEANUP_SECRETS), 'Working note payload', 'Current 中文 value', 'Updated body']) expect(strings).not.toContain(secret);
    const pdf = new mupdf.PDFDocument(prepared), output = new mupdf.PDFDocument(copy.data);
    try {
      for (let index = 0; index < 2; index++) {
        const before = pdf.loadPage(index), after = output.loadPage(index);
        const first = before.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
        const second = after.toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
        try { expect(Buffer.from(second.getPixels()).equals(Buffer.from(first.getPixels()))).toBe(true); }
        finally { second.destroy(); first.destroy(); after.destroy(); before.destroy(); }
      }
    } finally { output.destroy(); pdf.destroy(); }
    expect(workspace.editing.textEdits).toHaveLength(1); expect(workspace.form.isDirty).toBe(true);
  });
});
