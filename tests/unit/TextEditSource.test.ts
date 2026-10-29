import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { assertTextEditSource } from '../../src/editing/TextEditSource';
import { ALL_PDF_PERMISSIONS, encryptPDF } from '../../src/core/PDFEncryption';

const bytes = (value: Uint8Array) => new Uint8Array(value).buffer;
async function fixture() {
  const document = await PDFDocument.create(), page = document.addPage([200, 200]);
  page.drawText('Editable original text', { x: 10, y: 150, size: 12 });
  return document;
}

describe('raw source safeguards for original-text editing', () => {
  it('allows an ordinary PDF without changing bytes or requiring embedded fonts', async () => {
    const source = bytes(await (await fixture()).save()), before = Buffer.from(source).toString('hex');
    await expect(assertTextEditSource(source)).resolves.toBeUndefined(); expect(Buffer.from(source).toString('hex')).toBe(before);
  });

  it.each(['certification', 'signature', 'timestamp', 'signed-field', 'signature-dictionary'] as const)('rejects a real PDF with %s data before rewriting', async kind => {
    const document = await fixture();
    const value = document.context.register(document.context.obj({
      ...(kind === 'signature-dictionary' ? {} : { Type: kind === 'timestamp' ? 'DocTimeStamp' : 'Sig' }), ByteRange: [0, 10, 20, 30], Contents: PDFHexString.of('12345678'),
    }));
    if (kind === 'certification') document.catalog.set(PDFName.of('Perms'), document.context.obj({ DocMDP: value }));
    else if (kind === 'signed-field') document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ Fields: [document.context.register(document.context.obj({ FT: 'Sig', V: value }))] }));
    else document.catalog.set(PDFName.of('RetainedSignature'), value);
    const source = bytes(await document.save({ updateFieldAppearances: false })), before = Buffer.from(source).toString('hex');
    await expect(assertTextEditSource(source)).rejects.toThrow(/Signed or certified/);
    expect(Buffer.from(source).toString('hex')).toBe(before);
  });

  it('permits unsigned signature fields but rejects XFA even without ordinary fields', async () => {
    const document = await fixture();
    document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ Fields: [document.context.register(document.context.obj({ FT: 'Sig', T: PDFHexString.fromText('Unsigned') }))] }));
    await expect(assertTextEditSource(bytes(await document.save({ updateFieldAppearances: false })))).resolves.toBeUndefined();
    document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ XFA: document.context.register(document.context.stream('<xfa>Dynamic content</xfa>')) }));
    await expect(assertTextEditSource(bytes(await document.save({ updateFieldAppearances: false })))).rejects.toThrow(/XFA/);
  });

  it('accepts legal Font and XObject resources named ByteRange or Contents', async () => {
    const document = await PDFDocument.create(), page = document.addPage([200, 200]), font = await document.embedFont(StandardFonts.Helvetica);
    const form = document.context.register(document.context.stream('0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
    page.node.set(PDFName.of('Resources'), document.context.obj({ Font: { ByteRange: font.ref, Contents: font.ref }, XObject: { ByteRange: form, Contents: form } }));
    page.node.addContentStream(document.context.register(document.context.stream('BT /ByteRange 12 Tf 10 150 Td (Keep me) Tj ET /Contents Do')));
    await expect(assertTextEditSource(bytes(await document.save()))).resolves.toBeUndefined();
  });

  it('rejects locked and owner-protected raw files, corrupted input, and cancellation', async () => {
    const original = bytes(await (await fixture()).save());
    for (const userPassword of ['read-password', '']) {
      const encrypted = await encryptPDF(original, { userPassword, ownerPassword: 'independent-owner', permissions: { ...ALL_PDF_PERMISSIONS } });
      await expect(assertTextEditSource(encrypted)).rejects.toThrow(/Unlock/);
    }
    await expect(assertTextEditSource(bytes(new TextEncoder().encode('%PDF-1.7\nbroken')))).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(assertTextEditSource(original, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
