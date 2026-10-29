import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { exportWorkspacePDF, flattenWorkspaceForm } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { extractFormFields } from '../../src/forms/FormFieldExtractor';
import { createStickyNoteAnnotation } from '../../src/store/annotationStore';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';

it('exports original image and text edits together with Unicode form values and native notes', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  page.drawText('OLD CONTENT', { x: 30, y: 520, size: 12 });
  page.drawText('UNCHANGED OUTSIDE', { x: 30, y: 200, size: 12 });
  const image = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64'));
  page.drawImage(image, { x: 300, y: 510, width: 20, height: 20 });
  const field = pdf.getForm().createTextField('Name');
  field.setText('Original form');
  field.addToPage(page, { x: 30, y: 100, width: 250, height: 30 });
  const data = new Uint8Array(await pdf.save()).buffer;
  const workspace = createWorkspace(await extractFormFields(data));
  workspace.form.fields.forEach(field => { field.value = '客户 中文 Alice'; });
  workspace.editing.images.set(1, [{
    id: 'image', pageNumber: 1, objectName: 'source',
    rect: { x: 300, y: 70, width: 20, height: 20 }, originalRect: { x: 300, y: 70, width: 20, height: 20 },
    source: { occurrence: 0, occurrenceCount: 1, transform: [20, 0, 0, 20, 300, 510], pixelWidth: 1, pixelHeight: 1 },
  }]);
  workspace.editing.imageEdits = [{ type: 'delete', imageId: 'image', timestamp: 1 }];
  workspace.editing.textBlocks.set(1, [{
    id: 'text', pageNumber: 1, text: 'NEW 中文', editable: true,
    rect: { x: 30, y: 60, width: 220, height: 40 },
    lines: [{ items: [], text: 'OLD CONTENT', x: 30, y: 68, width: 90, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 },
  }]);
  workspace.editing.textEdits = [{ blockId: 'text', originalText: 'OLD CONTENT', newText: 'NEW 中文', timestamp: 1 }];
  const note = createStickyNoteAnnotation(1, { x: 200, y: 400 }, 'Review 中文');
  workspace.annotations.set(1, [note]);

  const first = await exportWorkspacePDF(data, workspace);
  const output = new mupdf.PDFDocument(first);
  const outputPage = output.loadPage(0);
  const text = outputPage.toStructuredText('preserve-images');
  try {
    expect(text.asText()).toContain('NEW 中文');
    expect(text.asText()).not.toContain('OLD CONTENT');
    expect(text.asText()).toContain('UNCHANGED OUTSIDE');
    let images = 0;
    text.walk({ onImageBlock() { images++; } });
    expect(images).toBe(0);
  } finally { text.destroy(); outputPage.destroy(); output.destroy(); }
  expect((await extractFormFields(new Uint8Array(first).buffer))[0].value).toBe('客户 中文 Alice');
  expect([...(await importEditableAnnotations(new Uint8Array(first).buffer)).annotations.values()].flat()).toMatchObject([
    { type: 'sticky-note', content: 'Review 中文' },
  ]);
  // Export operates on a captured workspace, never commits edits back into it.
  expect(workspace.editing.imageEdits).toHaveLength(1);
  expect(workspace.editing.textEdits).toHaveLength(1);
  const second = await exportWorkspacePDF(data, workspace);
  expect((await extractFormFields(new Uint8Array(second).buffer))[0].value).toBe('客户 中文 Alice');
});

it('applies pending image edits before flattening widgets with image appearances', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  const image = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64'));
  page.drawImage(image, { x: 300, y: 510, width: 20, height: 20 });
  const button = pdf.getForm().createButton('Image button');
  button.addToPage('', page, { x: 40, y: 300, width: 100, height: 100 });
  button.setImage(image);
  const data = new Uint8Array(await pdf.save()).buffer;
  const workspace = createWorkspace(await extractFormFields(data));
  workspace.editing.images.set(1, [{
    id: 'image', pageNumber: 1, objectName: 'source',
    rect: { x: 300, y: 70, width: 20, height: 20 }, originalRect: { x: 300, y: 70, width: 20, height: 20 },
    source: { occurrence: 0, occurrenceCount: 1, transform: [20, 0, 0, 20, 300, 510], pixelWidth: 1, pixelHeight: 1 },
  }]);
  workspace.editing.imageEdits = [{ type: 'delete', imageId: 'image', timestamp: 1 }];
  const flattened = await flattenWorkspaceForm(data, workspace);
  expect(flattened.workspace.editing.imageEdits).toEqual([]);
  expect(flattened.workspace.editing.images.size).toBe(0);
  expect(workspace.editing.imageEdits).toHaveLength(1);
  const exported = await exportWorkspacePDF(new Uint8Array(flattened.data).buffer, flattened.workspace);
  expect((await PDFDocument.load(exported)).getForm().getFields()).toHaveLength(0);
  const document = new mupdf.PDFDocument(exported);
  const outputPage = document.loadPage(0);
  const text = outputPage.toStructuredText('preserve-images');
  try {
    let images = 0;
    text.walk({ onImageBlock() { images++; } });
    expect(images).toBe(1); // Only the formerly interactive button image remains.
  } finally { text.destroy(); outputPage.destroy(); document.destroy(); }
});
