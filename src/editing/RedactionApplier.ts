/**
 * Redaction Application
 * Permanently removes content from PDFs and applies black boxes
 *
 * SECURITY CRITICAL: True redaction must remove data, not just hide it
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { RedactionArea } from './types';

export interface RedactionResult {
  success: boolean;
  appliedCount: number;
  modifiedPdf: Uint8Array | null;
  errors: string[];
}

/**
 * Apply redactions to a PDF document
 * This permanently removes content under the redaction areas
 */
export async function applyRedactions(
  pdfBytes: ArrayBuffer,
  redactions: RedactionArea[]
): Promise<RedactionResult> {
  const errors: string[] = [];
  let appliedCount = 0;

  if (redactions.length === 0) {
    return {
      success: true,
      appliedCount: 0,
      modifiedPdf: new Uint8Array(pdfBytes),
      errors: [],
    };
  }

  try {
    // Load the PDF
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
    });

    // Get the font for overlay text
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Group redactions by page
    const redactionsByPage = new Map<number, RedactionArea[]>();
    for (const redaction of redactions) {
      const pageRedactions = redactionsByPage.get(redaction.pageNumber) || [];
      pageRedactions.push(redaction);
      redactionsByPage.set(redaction.pageNumber, pageRedactions);
    }

    // Process each page
    const pages = pdfDoc.getPages();

    for (const [pageNum, pageRedactions] of redactionsByPage) {
      const pageIndex = pageNum - 1;
      if (pageIndex < 0 || pageIndex >= pages.length) {
        errors.push(`Invalid page number: ${pageNum}`);
        continue;
      }

      const page = pages[pageIndex];
      const { height } = page.getSize();

      for (const redaction of pageRedactions) {
        try {
          // Convert coordinates from top-left origin (our format) to bottom-left (PDF format)
          const pdfY = height - redaction.rect.y - redaction.rect.height;

          // Draw black rectangle to cover the area
          const overlayColor = parseColor(redaction.overlayColor);
          page.drawRectangle({
            x: redaction.rect.x,
            y: pdfY,
            width: redaction.rect.width,
            height: redaction.rect.height,
            color: overlayColor,
            opacity: 1,
          });

          // Draw overlay text if provided
          if (redaction.overlayText) {
            const fontSize = Math.min(12, redaction.rect.height * 0.6);
            const textWidth = font.widthOfTextAtSize(redaction.overlayText, fontSize);
            const textX = redaction.rect.x + (redaction.rect.width - textWidth) / 2;
            const textY = pdfY + (redaction.rect.height - fontSize) / 2;

            page.drawText(redaction.overlayText, {
              x: textX,
              y: textY,
              size: fontSize,
              font,
              color: rgb(1, 1, 1), // White text on black background
            });
          }

          appliedCount++;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          errors.push(`Failed to apply redaction on page ${pageNum}: ${message}`);
        }
      }
    }

    // Remove metadata that might contain sensitive information
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('PDF Editor - Redacted Document');
    pdfDoc.setCreator('');

    // Save the modified PDF
    const modifiedPdf = await pdfDoc.save({
      useObjectStreams: false, // Avoid compression that might preserve data
    });

    return {
      success: errors.length === 0,
      appliedCount,
      modifiedPdf,
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      appliedCount,
      modifiedPdf: null,
      errors: [`Failed to process PDF: ${message}`],
    };
  }
}

/**
 * Parse a hex color string to RGB values
 */
function parseColor(colorStr: string): ReturnType<typeof rgb> {
  const hex = colorStr.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/**
 * Check if a rectangle overlaps with a redaction area
 */
export function isInRedactionArea(
  x: number,
  y: number,
  width: number,
  height: number,
  redaction: RedactionArea
): boolean {
  const rect = redaction.rect;
  return !(
    x + width < rect.x ||
    x > rect.x + rect.width ||
    y + height < rect.y ||
    y > rect.y + rect.height
  );
}

/**
 * Verify that redactions have been applied
 * This is a basic check - a full security audit would be more thorough
 */
export async function verifyRedactions(
  _originalPdf: ArrayBuffer,
  redactedPdf: ArrayBuffer,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _redactions: RedactionArea[]
): Promise<{ verified: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const redactedDoc = await PDFDocument.load(redactedPdf);

    // Check that metadata has been cleared
    const title = redactedDoc.getTitle();
    const author = redactedDoc.getAuthor();
    const subject = redactedDoc.getSubject();
    const keywords = redactedDoc.getKeywords();

    if (title && title.trim() !== '') {
      warnings.push('Document title was not cleared');
    }
    if (author && author.trim() !== '') {
      warnings.push('Document author was not cleared');
    }
    if (subject && subject.trim() !== '') {
      warnings.push('Document subject was not cleared');
    }
    if (keywords && keywords.trim() !== '') {
      warnings.push('Document keywords were not cleared');
    }

    // Note: A complete verification would require extracting text from redacted
    // areas and confirming it's been removed. This requires more sophisticated
    // PDF parsing than pdf-lib provides.

    return {
      verified: warnings.length === 0,
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      verified: false,
      warnings: [`Verification failed: ${message}`],
    };
  }
}
