import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { applyRedactions, verifyRedactions } from '../../src/editing/RedactionApplier';

describe('visual covers', () => {
  it('never certifies recoverable covered text as securely redacted', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 300]).drawText('SECRET123', { x: 10, y: 250 });
    const original = new Uint8Array(await pdf.save()).buffer;
    const covers = [{
      id: 'cover-1', pageNumber: 1, applied: false,
      rect: { x: 0, y: 0, width: 300, height: 100 }, overlayColor: '#000000',
    }];
    const result = await applyRedactions(original, covers);
    expect(result.success).toBe(true);
    const output = new Uint8Array(result.modifiedPdf!).buffer;
    const covered = await PDFDocument.load(output);
    const streams = covered.context.enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFRawStream)
      .map(([, object]) => new TextDecoder().decode(decodePDFRawStream(object as PDFRawStream).decode()))
      .join('\n');
    // The content stream still contains the original hexadecimal text operand.
    expect(streams).toContain('534543524554313233');
    const verification = await verifyRedactions(original, output, covers);
    expect(verification.verified).toBe(false);
    expect(verification.warnings.join(' ')).toContain('underlying text or images');
  });
});
