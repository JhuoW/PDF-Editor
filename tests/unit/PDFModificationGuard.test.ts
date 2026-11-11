import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFHexString, PDFNull } from 'pdf-lib';
import { assertDocumentModificationAllowed, hasPDFSignatures } from '../../src/core/PDFModificationGuard';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { createRectangleAnnotation } from '../../src/store/annotationStore';
import { importEditableAnnotations } from '../../src/annotations/AnnotationImporter';

async function signedSource() {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
  const signature = pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('00') }));
  pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({ DocMDP: signature }));
  return new Uint8Array(await pdf.save()).buffer;
}
describe('consistent protection for full PDF rewrites', () => {
  it('keeps an unchanged signed source byte-for-byte and refuses every editing path', async () => {
    const source = await signedSource();
    expect(await exportWorkspacePDF(source, createWorkspace())).toEqual(new Uint8Array(source));
    for (const kind of ['annotation', 'image', 'form'] as const) {
      const workspace = createWorkspace();
      if (kind === 'annotation') workspace.annotations.set(1, [createRectangleAnnotation(1, [10, 20, 50, 60])]);
      if (kind === 'image') workspace.editing.imageEdits = [{ type: 'delete', imageId: 'native-image', timestamp: 1 }];
      if (kind === 'form') workspace.form.isDirty = true;
      await expect(exportWorkspacePDF(source, workspace)).rejects.toThrow('digitally signed or certified');
    }
    await expect(assertDocumentModificationAllowed(source)).rejects.toThrow('digitally signed or certified');
  });
  it('never strips annotations or rewrites bytes when opening a signed source', async () => {
    const source = await signedSource();
    const imported = await importEditableAnnotations(source);
    expect(imported.data).toBe(source); expect(imported.annotations.size).toBe(0);
  });
  it('allows empty signature fields and arbitrary resource names', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [pdf.context.obj({ FT: 'Sig', V: PDFNull })] }));
    pdf.catalog.set(PDFName.of('CustomData'), pdf.context.obj({ ByteRange: [1, 2, 3], Sig: 'a resource name' }));
    expect(hasPDFSignatures(pdf)).toBe(false);
    await expect(assertDocumentModificationAllowed(new Uint8Array(await pdf.save()).buffer)).resolves.toBeUndefined();
  });
});
