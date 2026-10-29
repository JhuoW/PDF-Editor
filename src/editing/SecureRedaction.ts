import type { RedactionArea } from './types';
import { loadMuPDF, toMuPDFPageRect } from '../utils/mupdf';

export interface SecureRedactionOptions {
  /** Flatten annotation/widget appearances and discard their interactive dictionaries before removal. */
  flattenInteractive?: boolean;
}

/**
 * Remove page content covered by the supplied areas and add black fills.
 * Text glyphs intersecting an area are removed; covered image pixels are
 * replaced, and touched vector paths are removed. Unselected uses of shared
 * resources remain intact. Overlay color/text do not change this operation.
 *
 * This is page-content redaction, NOT whole-document sanitization: metadata,
 * attachments, unrelated annotations, and other copies outside the selected
 * regions are not searched or purged. The caller must disclose that scope.
 * flattenInteractive converts all form/annotation appearances to static page
 * content first and removes their interactive data. It does not apply existing
 * redaction proposals. No input bytes are mutated; invalid areas fail the entire operation.
 */
export async function applySecureRedactions(
  data: ArrayBuffer,
  areas: RedactionArea[],
  options: SecureRedactionOptions = {},
): Promise<Uint8Array> {
  if (areas.length === 0) return new Uint8Array(data.slice(0));
  if (data.byteLength === 0) throw new Error('Cannot redact an empty PDF');
  for (const area of areas) {
    if (!Number.isInteger(area.pageNumber) || area.pageNumber < 1 ||
      ![area.rect.x, area.rect.y, area.rect.width, area.rect.height].every(Number.isFinite) || area.rect.width <= 0 || area.rect.height <= 0) {
      throw new Error(`Invalid redaction area ${area.id}`);
    }
  }

  const engine = await loadMuPDF();
  const document = new engine.PDFDocument(data);
  try {
    if (document.needsPassword()) throw new Error('Unlock the PDF before removing content');
    const byPage = new Map<number, RedactionArea[]>();
    for (const area of areas) {
      if (area.pageNumber > document.countPages()) throw new Error(`Invalid page number: ${area.pageNumber}`);
      const pageAreas = byPage.get(area.pageNumber) ?? [];
      pageAreas.push(area);
      byPage.set(area.pageNumber, pageAreas);
    }

    // Bake actual appearances first so covered form values and annotation text
    // are processed as page content, then discard their interactive dictionaries.
    // The full save below removes the now-unreachable /V and /Contents objects.
    if (options.flattenInteractive) document.bake(true, true);

    for (const [pageNumber, pageAreas] of byPage) {
      const page = document.loadPage(pageNumber - 1);
      try {
        for (const area of pageAreas) {
          const rect = toMuPDFPageRect(engine, page, area.rect);
          const annotation = page.createAnnotation('Redact');
          try {
            annotation.setRect(rect);
            // Apply only this annotation. Page.applyRedactions would also apply
            // unrelated redaction annotations already present in the source PDF.
            annotation.applyRedaction(
              1,
              engine.PDFPage.REDACT_IMAGE_PIXELS,
              engine.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
              engine.PDFPage.REDACT_TEXT_REMOVE,
            );
          } finally {
            annotation.destroy();
          }
        }
      } finally {
        page.destroy();
      }
    }

    // Rewrite the file, discarding unreachable original objects and prior
    // incremental revisions. Compression is not a substitute for removal.
    // MuPDF 1.28.1 deduplication can corrupt grafted Form XObject streams.
    // Level 1 still discards unreachable objects without unsafe deduplication.
    const output = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try {
      return new Uint8Array(output.asUint8Array()); // Copy out of the WASM heap before destroy().
    } finally {
      output.destroy();
    }
  } finally {
    document.destroy();
  }
}
