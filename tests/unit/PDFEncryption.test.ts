import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFNumber } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { getDocument, PasswordResponses, PermissionFlag } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  ALL_PDF_PERMISSIONS, decryptPDF, encryptPDF, inspectEncryption,
  InvalidPDFDocumentError, InvalidPDFEncryptionOptionsError, InvalidPDFPasswordError, PDFPasswordRequiredError,
} from '../../src/core/PDFEncryption';
import type { PDFEncryptionOptions, PDFPermissions } from '../../src/core/PDFEncryption';

const permissions: PDFPermissions = {
  print: true, copy: false, edit: false, annotate: true,
  form: true, accessibility: true, assemble: false, printHighQuality: false,
};
const encryptionOptions: PDFEncryptionOptions = { userPassword: 'reader', ownerPassword: 'owner', permissions };

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Private 文档');
  const first = pdf.addPage([600, 800]);
  const second = pdf.addPage([500, 700]);
  first.drawText('Sensitive page content', { x: 50, y: 600, size: 12 });
  second.drawText('Second page retained');
  const field = pdf.getForm().createTextField('customer');
  field.setText('Retained value');
  field.addToPage(first, { x: 50, y: 500, width: 150, height: 25 });
  field.addToPage(second, { x: 50, y: 500, width: 150, height: 25 });
  first.node.addAnnot(pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [100, 400, 124, 424],
    Contents: PDFHexString.fromText('便签 😀'), T: PDFHexString.fromText('作者'), P: first.ref,
  })));
  return new Uint8Array(await pdf.save()).buffer;
}

async function independentRead(data: ArrayBuffer, password?: string) {
  const task = getDocument({ data: new Uint8Array(data.slice(0)), password, useSystemFonts: true });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    const metadata = await document.getMetadata();
    return {
      pageCount: document.numPages,
      text: text.items.map(item => 'str' in item ? item.str : '').join(' '),
      permissions: await document.getPermissions(),
      annotations: await page.getAnnotations(),
      title: (metadata.info as { Title: string }).Title,
    };
  } finally { await task.destroy(); }
}

describe('PDFEncryption with genuine encrypted documents', () => {
  it('writes AES-256 revision 6 with explicit permissions, independently readable with either credential', async () => {
    const input = await fixture();
    const original = input.slice(0);
    const encrypted = await encryptPDF(input, encryptionOptions);
    expect(input).toEqual(original);
    expect(await inspectEncryption(encrypted)).toEqual({
      encrypted: true, needsPassword: true, method: 'Standard V5 R6 256-bit AES', permissions,
    });
    const structure = await PDFDocument.load(encrypted, { ignoreEncryption: true });
    // Inspection only: pdf-lib's ignoreEncryption does not decrypt page data.
    const encryption = structure.context.lookup(structure.context.trailerInfo.Encrypt)!;
    expect('lookup' in encryption).toBe(true);
    if ('lookup' in encryption) {
      expect(encryption.lookup(PDFName.of('V'), PDFNumber).asNumber()).toBe(5);
      expect(encryption.lookup(PDFName.of('R'), PDFNumber).asNumber()).toBe(6);
      expect(encryption.lookup(PDFName.of('Length'), PDFNumber).asNumber()).toBe(256);
    }
    for (const password of ['reader', 'owner']) {
      const result = await independentRead(encrypted, password);
      expect(result.pageCount).toBe(2);
      expect(result.text).toContain('Sensitive page content');
      expect(result.title).toBe('Private 文档');
      expect(result.permissions).toEqual([
        PermissionFlag.PRINT, PermissionFlag.MODIFY_ANNOTATIONS, PermissionFlag.FILL_INTERACTIVE_FORMS,
        PermissionFlag.COPY_FOR_ACCESSIBILITY,
      ]);
      expect(result.annotations.find(item => item.subtype === 'Text')?.contentsObj.str).toBe('便签 😀');
      expect(result.annotations.find(item => item.subtype === 'Widget')?.fieldValue).toBe('Retained value');
    }
    await expect(independentRead(encrypted)).rejects.toMatchObject({ code: PasswordResponses.NEED_PASSWORD });
    await expect(independentRead(encrypted, 'wrong')).rejects.toMatchObject({ code: PasswordResponses.INCORRECT_PASSWORD });
  });

  it.each([
    '中文密碼 😀 Ελληνικά',
    'comma,encrypt=none,permissions=-1',
    'quotes "double" and \'single\'',
    'back\\slash & equals=value?percent%20',
    ' spaces remain on both ends ',
    `${'密'.repeat(40)}abcdefg`, // Exactly 127 UTF-8 bytes.
  ])('round-trips literal special password %s through MuPDF and PDF.js', async userPassword => {
    const ownerPassword = `所有者,"secure"\\=${userPassword.slice(0, 12)}`;
    const encrypted = await encryptPDF(await fixture(), { ...encryptionOptions, userPassword, ownerPassword });
    expect((await independentRead(encrypted, userPassword)).text).toContain('Sensitive page content');
    expect((await independentRead(encrypted, ownerPassword)).pageCount).toBe(2);
    await expect(independentRead(encrypted, 'comma')).rejects.toMatchObject({ code: PasswordResponses.INCORRECT_PASSWORD });
    expect((await decryptPDF(encrypted, userPassword)).authentication).toBe('user');
    expect((await decryptPDF(encrypted, ownerPassword)).authentication).toBe('owner');
  });

  it('returns an unencrypted editable copy while retaining original permissions and all supported content', async () => {
    const encrypted = await encryptPDF(await fixture(), encryptionOptions);
    const before = encrypted.slice(0);
    const decrypted = await decryptPDF(encrypted, 'owner');
    expect(decrypted.authentication).toBe('owner');
    // MuPDF grants owners every operation, but our return value reports the
    // original file restrictions so UI can accurately describe the source.
    expect(decrypted.permissions).toEqual(permissions);
    expect(encrypted).toEqual(before);
    expect(await inspectEncryption(decrypted.data)).toEqual({
      encrypted: false, needsPassword: false, method: null, permissions: ALL_PDF_PERMISSIONS,
    });
    const editable = await PDFDocument.load(decrypted.data);
    expect(editable.getTitle()).toBe('Private 文档');
    expect(editable.getForm().getTextField('customer').getText()).toBe('Retained value');
    expect(editable.getForm().getTextField('customer').acroField.getWidgets()).toHaveLength(2);
    editable.getForm().getTextField('customer').setText('Editable after unlock');
    const read = await independentRead(new Uint8Array(await editable.save()).buffer);
    expect(read.text).toContain('Sensitive page content');
    expect(read.annotations.find(item => item.subtype === 'Widget')?.fieldValue).toBe('Editable after unlock');
    expect(read.annotations.find(item => item.subtype === 'Text')?.contentsObj.str).toBe('便签 😀');
  });

  it('distinguishes owner-only protection from an unencrypted PDF and authenticates an empty user password', async () => {
    const allDenied = Object.fromEntries(Object.keys(permissions).map(key => [key, false])) as unknown as PDFPermissions;
    const encrypted = await encryptPDF(await fixture(), { ...encryptionOptions, userPassword: '', permissions: allDenied });
    expect(await inspectEncryption(encrypted)).toMatchObject({ encrypted: true, needsPassword: false, permissions: allDenied });
    expect((await independentRead(encrypted)).permissions).toEqual([]);
    expect(await decryptPDF(encrypted, '')).toMatchObject({ authentication: 'user', permissions: allDenied });
    expect((await decryptPDF(encrypted, 'owner')).authentication).toBe('owner');
  });

  it('handles documents whose encrypted object streams contain their page tree', async () => {
    const document = new mupdf.PDFDocument(await fixture());
    let encrypted: ArrayBuffer;
    try {
      const buffer = document.saveToBuffer({ encrypt: 'aes-256', 'user-password': 'reader', 'owner-password': 'owner', objstms: true });
      try { encrypted = new Uint8Array(buffer.asUint8Array()).buffer; }
      finally { buffer.destroy(); }
    } finally { document.destroy(); }
    expect(await inspectEncryption(encrypted)).toMatchObject({ encrypted: true, needsPassword: true });
    const decrypted = await decryptPDF(encrypted, 'reader');
    expect((await independentRead(decrypted.data)).pageCount).toBe(2);
  });

  it('raises typed password failures and does not treat ignoring encryption as decryption', async () => {
    const encrypted = await encryptPDF(await fixture(), encryptionOptions);
    await expect(decryptPDF(encrypted, '')).rejects.toBeInstanceOf(PDFPasswordRequiredError);
    await expect(decryptPDF(encrypted, 'incorrect')).rejects.toBeInstanceOf(InvalidPDFPasswordError);
    await expect(encryptPDF(encrypted, encryptionOptions)).rejects.toBeInstanceOf(PDFPasswordRequiredError);
    expect((await inspectEncryption(encrypted)).needsPassword).toBe(true);
  });

  it('returns an independent unencrypted working buffer without changing an already unencrypted PDF', async () => {
    const input = await fixture();
    const result = await decryptPDF(input, 'irrelevant');
    expect(result).toMatchObject({ permissions: ALL_PDF_PERMISSIONS, authentication: 'none' });
    expect(result.data).toEqual(input);
    expect(result.data).not.toBe(input);
  });

  it.each(['', 'not a PDF /Encrypt', '%PDF-1.7\ntrailer << /Encrypt 99 0 R >>\n%%EOF', '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'])(
    'does not misclassify a damaged PDF as merely needing a password: %s', async content => {
      const input = new TextEncoder().encode(content).buffer;
      await expect(inspectEncryption(input)).rejects.toBeInstanceOf(InvalidPDFDocumentError);
      await expect(decryptPDF(input, 'anything')).rejects.toBeInstanceOf(InvalidPDFDocumentError);
    });

  it.each(['line\nbreak', 'tab\tcharacter', 'nul\0character', 'a'.repeat(128), '密'.repeat(43), '\ud800'])(
    'rejects passwords the writer cannot preserve instead of silently changing them', async userPassword => {
      await expect(encryptPDF(await fixture(), { ...encryptionOptions, userPassword }))
        .rejects.toBeInstanceOf(InvalidPDFEncryptionOptionsError);
    });

  it('requires a nonempty owner password and complete, consistent permission choices', async () => {
    const input = await fixture();
    await expect(encryptPDF(input, { ...encryptionOptions, ownerPassword: '' })).rejects.toThrow('Owner password must not be empty');
    await expect(encryptPDF(input, { ...encryptionOptions, permissions: { ...permissions, print: false, printHighQuality: true } }))
      .rejects.toThrow('High-quality printing');
    await expect(encryptPDF(input, { ...encryptionOptions, permissions: {} as PDFPermissions })).rejects.toThrow('Missing or invalid PDF permission');
  });
});
