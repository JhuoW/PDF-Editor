import type { PDFDocument as MuPDFDocument } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';

export interface PDFPermissions {
  print: boolean;
  copy: boolean;
  edit: boolean;
  annotate: boolean;
  form: boolean;
  accessibility: boolean;
  assemble: boolean;
  printHighQuality: boolean;
}

export const ALL_PDF_PERMISSIONS: Readonly<PDFPermissions> = Object.freeze({
  print: true, copy: true, edit: true, annotate: true,
  form: true, accessibility: true, assemble: true, printHighQuality: true,
});

export interface PDFEncryptionInfo {
  encrypted: boolean;
  needsPassword: boolean;
  method: string | null;
  /** The original /P restrictions, including when authenticated as owner. */
  permissions: PDFPermissions;
}

export type PDFPasswordAuthentication = 'none' | 'user' | 'owner' | 'user-and-owner';

export interface DecryptedPDF {
  data: ArrayBuffer;
  permissions: PDFPermissions;
  authentication: PDFPasswordAuthentication;
}

export interface PDFEncryptionOptions {
  /** An empty user password creates an encrypted file that opens without a prompt. */
  userPassword: string;
  ownerPassword: string;
  permissions: PDFPermissions;
}

export class InvalidPDFDocumentError extends Error {
  constructor(message = 'Unable to read this PDF. The file may be damaged.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidPDFDocumentError';
  }
}

export class PDFPasswordRequiredError extends Error {
  constructor() {
    super('This PDF requires a password before it can be edited.');
    this.name = 'PDFPasswordRequiredError';
  }
}

export class InvalidPDFPasswordError extends Error {
  constructor() {
    super('The PDF password is incorrect.');
    this.name = 'InvalidPDFPasswordError';
  }
}

export class InvalidPDFEncryptionOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPDFEncryptionOptionsError';
  }
}

const permissionBits: Record<keyof PDFPermissions, number> = {
  print: 1 << 2, edit: 1 << 3, copy: 1 << 4, annotate: 1 << 5,
  form: 1 << 8, accessibility: 1 << 9, assemble: 1 << 10, printHighQuality: 1 << 11,
};

async function openPDF(data: ArrayBuffer): Promise<MuPDFDocument> {
  // MuPDF can repair arbitrary input; do not mistake a fabricated /Encrypt
  // string or an empty repaired document for a real password-protected PDF.
  if (!/%PDF-\d\.\d/.test(new TextDecoder('latin1').decode(data.slice(0, 1024)))) {
    throw new InvalidPDFDocumentError('The file does not contain a PDF header.');
  }
  const mupdf = await loadMuPDF();
  try { return new mupdf.PDFDocument(data); }
  catch (cause) { throw new InvalidPDFDocumentError(undefined, { cause }); }
}

function readEncryption(document: MuPDFDocument): PDFEncryptionInfo {
  const trailer = document.getTrailer();
  try {
    const encryption = trailer.get('Encrypt');
    try {
      const encrypted = !encryption.isNull();
      if (!encrypted) return { encrypted: false, needsPassword: false, method: null, permissions: { ...ALL_PDF_PERMISSIONS } };
      if (!encryption.isDictionary()) throw new InvalidPDFDocumentError('The PDF encryption dictionary is invalid.');
      const permissionObject = encryption.get('P');
      try {
        if (!permissionObject.isNumber()) throw new InvalidPDFDocumentError('The PDF encryption permissions are invalid.');
        const bits = permissionObject.asNumber();
        const permissions = Object.fromEntries(Object.entries(permissionBits)
          .map(([key, mask]) => [key, (bits & mask) !== 0])) as unknown as PDFPermissions;
        return { encrypted: true, needsPassword: document.needsPassword(),
          method: document.getMetaData('encryption') ?? 'Encrypted PDF', permissions };
      } finally { permissionObject.destroy(); }
    } finally { encryption.destroy(); }
  } finally { trailer.destroy(); }
}

function validatePageTree(document: MuPDFDocument) {
  try {
    if (document.countPages() < 1) throw new Error('The PDF has no pages.');
  } catch (cause) {
    throw new InvalidPDFDocumentError('The PDF page structure is missing or damaged.', { cause });
  }
}

/** Inspection never guesses encryption from a parser error or modifies bytes. */
export async function inspectEncryption(data: ArrayBuffer): Promise<PDFEncryptionInfo> {
  const document = await openPDF(data);
  try {
    const information = readEncryption(document);
    // Encrypted object streams can contain the page tree. Reading it before
    // authentication would falsely label a valid locked document as damaged.
    if (!information.needsPassword) validatePageTree(document);
    return information;
  } finally { document.destroy(); }
}

function savedBytes(document: MuPDFDocument, options: Record<string, string | number | boolean>): ArrayBuffer {
  // MuPDF's object overload uses JSON rather than an interpolated comma option
  // string. Password punctuation must never be interpreted as write options.
  const buffer = document.saveToBuffer(options);
  try { return new Uint8Array(buffer.asUint8Array()).buffer; }
  finally { buffer.destroy(); }
}

/** Authenticate and write a genuinely unencrypted working copy. */
export async function decryptPDF(data: ArrayBuffer, password: string): Promise<DecryptedPDF> {
  const document = await openPDF(data);
  try {
    const information = readEncryption(document);
    if (!information.encrypted) {
      validatePageTree(document);
      return { data: data.slice(0), permissions: information.permissions, authentication: 'none' };
    }
    const authentication = document.authenticatePassword(password);
    if (!authentication) {
      if (password === '' && information.needsPassword) throw new PDFPasswordRequiredError();
      throw new InvalidPDFPasswordError();
    }
    validatePageTree(document);
    const output = savedBytes(document, { encrypt: 'none', incremental: false, compress: true, garbage: 'compact' });
    if ((await inspectEncryption(output)).encrypted) throw new Error('The PDF could not be decrypted.');
    return {
      data: output, permissions: information.permissions,
      authentication: (authentication & 6) === 6 ? 'user-and-owner' : (authentication & 4) !== 0 ? 'owner' : 'user',
    };
  } finally { document.destroy(); }
}

function validatePassword(password: string, role: 'User' | 'Owner') {
  if (typeof password !== 'string') throw new InvalidPDFEncryptionOptionsError(`${role} password must be text.`);
  if (role === 'Owner' && password.length === 0) throw new InvalidPDFEncryptionOptionsError('Owner password must not be empty.');
  // The writer has a 127-byte UTF-8 limit. Its JSON option parser does not
  // round-trip control escapes, so reject them instead of exporting a file
  // that the password typed by the user cannot open.
  if (Array.from(password).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    throw new InvalidPDFEncryptionOptionsError(`${role} password cannot contain control characters or line breaks.`);
  if (new TextEncoder().encode(password).length > 127)
    throw new InvalidPDFEncryptionOptionsError(`${role} password must be at most 127 UTF-8 bytes.`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(password))
    throw new InvalidPDFEncryptionOptionsError(`${role} password contains invalid Unicode.`);
}

function permissionsMask(permissions: PDFPermissions) {
  let result = 0;
  for (const key of Object.keys(permissionBits) as (keyof PDFPermissions)[]) {
    if (typeof permissions?.[key] !== 'boolean') throw new InvalidPDFEncryptionOptionsError(`Missing or invalid PDF permission: ${key}.`);
    if (permissions[key]) result |= permissionBits[key];
  }
  if (permissions.printHighQuality && !permissions.print)
    throw new InvalidPDFEncryptionOptionsError('High-quality printing also requires printing permission.');
  return result;
}

/** Encrypt an unlocked export with AES-256, revision 6, and explicit permissions. */
export async function encryptPDF(data: ArrayBuffer, options: PDFEncryptionOptions): Promise<ArrayBuffer> {
  validatePassword(options.userPassword, 'User');
  validatePassword(options.ownerPassword, 'Owner');
  const mask = permissionsMask(options.permissions);
  const document = await openPDF(data);
  try {
    const information = readEncryption(document);
    if (information.needsPassword) throw new PDFPasswordRequiredError();
    validatePageTree(document);
    const output = savedBytes(document, {
      encrypt: 'aes-256', 'user-password': options.userPassword, 'owner-password': options.ownerPassword,
      permissions: mask, incremental: false, compress: true, garbage: 'compact',
    });
    // Verify both credentials using fresh documents. This also catches writer
    // limitations without returning an unusable encrypted download.
    for (const [password, expectedBit] of [[options.userPassword, 2], [options.ownerPassword, 4]] as const) {
      const verification = await openPDF(output);
      try {
        const info = readEncryption(verification);
        if (!info.encrypted || (verification.authenticatePassword(password) & expectedBit) === 0)
          throw new Error('This password could not be encoded reliably. Choose a different password.');
        if (permissionsMask(info.permissions) !== mask) throw new Error('The exported PDF permissions could not be verified.');
        validatePageTree(verification);
      } finally { verification.destroy(); }
    }
    return output;
  } finally { document.destroy(); }
}
