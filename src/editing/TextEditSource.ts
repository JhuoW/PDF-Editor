import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';

/** Check raw bytes before form/annotation export can normalize an unsupported source. */
export async function assertTextEditSource(data: ArrayBuffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!data.byteLength) throw new Error('The PDF source is empty.');
  const engine = await loadMuPDF(); signal?.throwIfAborted();
  let document: PDFDocument | undefined;
  const diagnostics: string[] = [];
  // Keep the global engine log handler within this synchronous inspection only.
  engine.setLog(message => { if (diagnostics.length < 4) diagnostics.push(message); });
  try {
    document = new engine.PDFDocument(data); document.disableJS();
    const trailer = document.getTrailer();
    try {
      const encryption = trailer.get('Encrypt');
      try { if (document.needsPassword() || !encryption.isNull()) throw new Error('Unlock this PDF before editing original text.'); }
      finally { encryption.destroy(); }
      if (document.wasRepaired()) throw new Error('This PDF required repair and cannot be safely edited.');
      const xfa = trailer.get('Root', 'AcroForm', 'XFA'), permissions = trailer.get('Root', 'Perms');
      try {
        if (!xfa.isNull()) throw new Error('XFA forms cannot be changed by original-text editing.');
        for (const name of permissions.isDictionary() ? ['DocMDP', 'UR', 'UR3'] : []) {
          const value = permissions.get(name);
          try { if (!value.isNull()) throw new Error('Signed or certified PDFs cannot be changed by original-text editing.'); }
          finally { value.destroy(); }
        }
      } finally { xfa.destroy(); permissions.destroy(); }
      const seen = new Set<number>(); let visited = 0;
      const inspect = (object: PDFObject, depth = 0) => {
        if (depth > 512 || ++visited > 1_000_000) throw new Error('The PDF structure is too complex to validate safely for text editing.');
        if ((visited & 255) === 0) signal?.throwIfAborted();
        if (object.isIndirect()) { const ref = object.asIndirect(); if (seen.has(ref)) return; seen.add(ref); }
        if (object.isDictionary()) {
          const type = object.get('Type'), fieldType = object.get('FT'), value = object.get('V');
          const range = object.get('ByteRange'), contents = object.get('Contents');
          try {
            // Names in resource maps are arbitrary. /ByteRange alone is not a signature.
            if (['Sig', 'DocTimeStamp'].includes(type.asName()) || (fieldType.asName() === 'Sig' && !value.isNull())
              || (range.isArray() && contents.isString())) throw new Error('Signed or certified PDFs cannot be changed by original-text editing.');
          } finally { type.destroy(); fieldType.destroy(); value.destroy(); range.destroy(); contents.destroy(); }
        }
        if (object.isDictionary() || object.isArray()) object.forEach(child => { try { inspect(child, depth + 1); } finally { child.destroy(); } });
      };
      inspect(trailer);
      if (document.wasRepaired() || diagnostics.length) throw new Error(`The PDF source could not be verified for text editing${diagnostics.length ? `: ${diagnostics.join('; ').slice(0, 500)}` : '.'}`);
      signal?.throwIfAborted();
    } finally { trailer.destroy(); }
  } finally { document?.destroy(); engine.setLog(null); }
}
