import { PDFArray, PDFDict, PDFName, PDFRef, PDFString, PDFHexString, PDFDocument } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';

export const SIGNED_PDF_EDIT_ERROR = 'This PDF is digitally signed or certified. Changes cannot be saved without invalidating its signature. The original file has been kept.';

/** Full rewrites cannot retain signatures, even when DocMDP permits incremental edits. */
export function hasPDFSignatures(document: PDFDocument): boolean {
  const permissions = document.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (permissions && ['DocMDP', 'UR', 'UR3'].some(name => permissions.lookup(PDFName.of(name)) !== undefined)) return true;
  const references = new Set<string>(), direct = new Set<PDFObject>();
  let visited = 0;
  const inspect = (entry: PDFObject | undefined, depth = 0): boolean => {
    if (!entry) return false;
    if (depth > 512 || ++visited > 1_000_000) throw new Error('The PDF structure is too complex to validate safely for editing.');
    if (entry instanceof PDFRef) {
      if (references.has(entry.toString())) return false;
      references.add(entry.toString()); entry = document.context.lookup(entry);
    }
    if (!entry || direct.has(entry)) return false;
    direct.add(entry);
    if (entry instanceof PDFDict) {
      const type = entry.get(PDFName.of('Type')), fieldType = entry.get(PDFName.of('FT'));
      const value = entry.lookup(PDFName.of('V')), range = entry.lookup(PDFName.of('ByteRange')), contents = entry.lookup(PDFName.of('Contents'));
      if (type === PDFName.of('Sig') || type === PDFName.of('DocTimeStamp') || (fieldType === PDFName.of('Sig') && value !== undefined)
        || (range instanceof PDFArray && (contents instanceof PDFString || contents instanceof PDFHexString))) return true;
      return entry.entries().some(([, child]) => inspect(child, depth + 1));
    }
    return entry instanceof PDFArray && entry.asArray().some(child => inspect(child, depth + 1));
  };
  return inspect(document.catalog);
}

export async function assertDocumentModificationAllowed(data: ArrayBuffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const document = await PDFDocument.load(data, { updateMetadata: false });
  signal?.throwIfAborted();
  if (hasPDFSignatures(document)) throw new Error(SIGNED_PDF_EDIT_ERROR);
}
