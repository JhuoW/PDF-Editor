/**
 * Annotation Serializer - Saves annotations to PDF using pdf-lib
 */
import { PDFDocument, PDFPage, rgb, StandardFonts } from 'pdf-lib';
import type {
  Annotation,
  TextMarkupAnnotation,
  InkAnnotation,
  RectangleAnnotation,
  EllipseAnnotation,
  LineAnnotation,
  StickyNoteAnnotation,
  StampAnnotation,
  FreeTextAnnotation,
  TextStyle,
} from './types';
import { DEFAULT_TEXT_STYLE } from './types';

// Convert hex color to RGB values (0-1 range)
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

// Map font family names to Standard PDF fonts
function mapFontToStandard(fontFamily: string, fontWeight: string, fontStyle: string): StandardFonts {
  const isBold = fontWeight === 'bold';
  const isItalic = fontStyle === 'italic';

  // Normalize font family
  const normalizedFont = fontFamily.toLowerCase().replace(/[^a-z]/g, '');

  // Times/Times New Roman
  if (normalizedFont.includes('times') || normalizedFont.includes('roman')) {
    if (isBold && isItalic) return StandardFonts.TimesRomanBoldItalic;
    if (isBold) return StandardFonts.TimesRomanBold;
    if (isItalic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }

  // Courier
  if (normalizedFont.includes('courier') || normalizedFont.includes('mono')) {
    if (isBold && isItalic) return StandardFonts.CourierBoldOblique;
    if (isBold) return StandardFonts.CourierBold;
    if (isItalic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }

  // Default to Helvetica (covers Arial, Helvetica, sans-serif, etc.)
  if (isBold && isItalic) return StandardFonts.HelveticaBoldOblique;
  if (isBold) return StandardFonts.HelveticaBold;
  if (isItalic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * Serialize annotations to a PDF document
 * Returns a new PDF with annotations embedded
 */
export async function serializeAnnotationsToPDF(
  pdfData: ArrayBuffer,
  annotations: Map<number, Annotation[]>
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfData);
  const pages = pdfDoc.getPages();

  // Embed standard fonts that might be used
  const embeddedFonts = new Map<string, Awaited<ReturnType<typeof pdfDoc.embedFont>>>();

  // Process each page's annotations
  for (const [pageNumber, pageAnnotations] of annotations) {
    const pageIndex = pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];

    for (const annotation of pageAnnotations) {
      await addAnnotationToPage(pdfDoc, page, annotation, embeddedFonts);
    }
  }

  return pdfDoc.save();
}

/**
 * Add a single annotation to a PDF page
 */
async function addAnnotationToPage(
  pdfDoc: PDFDocument,
  page: PDFPage,
  annotation: Annotation,
  embeddedFonts: Map<string, Awaited<ReturnType<typeof pdfDoc.embedFont>>>
): Promise<void> {
  switch (annotation.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      addTextMarkupAnnotation(page, annotation);
      break;
    case 'ink':
      addInkAnnotation(page, annotation);
      break;
    case 'rectangle':
      addRectangleAnnotation(page, annotation);
      break;
    case 'ellipse':
      addEllipseAnnotation(page, annotation);
      break;
    case 'line':
    case 'arrow':
      addLineAnnotation(page, annotation);
      break;
    case 'sticky-note':
      addStickyNoteAnnotation(page, annotation);
      break;
    case 'stamp':
      addStampAnnotation(page, annotation);
      break;
    case 'freetext':
      await addFreeTextAnnotation(pdfDoc, page, annotation, embeddedFonts);
      break;
  }
}

/**
 * Add text markup annotation (highlight, underline, strikeout)
 * For now, we draw these directly on the page content
 */
function addTextMarkupAnnotation(
  page: PDFPage,
  annotation: TextMarkupAnnotation
): void {
  const { quadPoints, color, opacity, type } = annotation;
  const { r, g, b } = hexToRgb(color);

  for (const quad of quadPoints) {
    // quad is [x1,y1, x2,y2, x3,y3, x4,y4]
    // Extract the bounding box from quad points
    const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
    const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
    const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
    const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);

    if (type === 'highlight') {
      // Draw a semi-transparent rectangle
      page.drawRectangle({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        color: rgb(r, g, b),
        opacity: opacity,
        borderWidth: 0,
      });
    } else if (type === 'underline') {
      // Draw a line at the bottom
      page.drawLine({
        start: { x: minX, y: minY },
        end: { x: maxX, y: minY },
        color: rgb(r, g, b),
        thickness: 1,
        opacity: opacity,
      });
    } else if (type === 'strikeout') {
      // Draw a line through the middle
      const midY = (minY + maxY) / 2;
      page.drawLine({
        start: { x: minX, y: midY },
        end: { x: maxX, y: midY },
        color: rgb(r, g, b),
        thickness: 1,
        opacity: opacity,
      });
    }
  }
}

/**
 * Add ink annotation (freehand drawing)
 */
function addInkAnnotation(page: PDFPage, annotation: InkAnnotation): void {
  const { paths, color, strokeWidth } = annotation;
  const { r, g, b } = hexToRgb(color);

  for (const path of paths) {
    if (path.length < 2) continue;

    // Draw each segment of the path
    for (let i = 0; i < path.length - 1; i++) {
      page.drawLine({
        start: { x: path[i][0], y: path[i][1] },
        end: { x: path[i + 1][0], y: path[i + 1][1] },
        color: rgb(r, g, b),
        thickness: strokeWidth,
      });
    }
  }
}

/**
 * Add rectangle annotation
 */
function addRectangleAnnotation(page: PDFPage, annotation: RectangleAnnotation): void {
  const { rect, strokeColor, strokeWidth, fillColor, opacity } = annotation;
  const stroke = hexToRgb(strokeColor);

  page.drawRectangle({
    x: rect[0],
    y: rect[1],
    width: rect[2],
    height: rect[3],
    borderColor: rgb(stroke.r, stroke.g, stroke.b),
    borderWidth: strokeWidth,
    color: fillColor ? rgb(...Object.values(hexToRgb(fillColor)) as [number, number, number]) : undefined,
    opacity: opacity,
  });
}

/**
 * Add ellipse annotation
 */
function addEllipseAnnotation(page: PDFPage, annotation: EllipseAnnotation): void {
  const { rect, strokeColor, strokeWidth, fillColor, opacity } = annotation;
  const stroke = hexToRgb(strokeColor);

  page.drawEllipse({
    x: rect[0] + rect[2] / 2,
    y: rect[1] + rect[3] / 2,
    xScale: rect[2] / 2,
    yScale: rect[3] / 2,
    borderColor: rgb(stroke.r, stroke.g, stroke.b),
    borderWidth: strokeWidth,
    color: fillColor ? rgb(...Object.values(hexToRgb(fillColor)) as [number, number, number]) : undefined,
    opacity: opacity,
  });
}

/**
 * Add line or arrow annotation
 */
function addLineAnnotation(page: PDFPage, annotation: LineAnnotation): void {
  const { start, end, color, strokeWidth, endArrow, type } = annotation;
  const { r, g, b } = hexToRgb(color);

  // Draw the main line
  page.drawLine({
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
    color: rgb(r, g, b),
    thickness: strokeWidth,
  });

  // Draw arrow head if needed
  if (endArrow || type === 'arrow') {
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const arrowLength = 10;
    const arrowAngle = Math.PI / 6;

    const arrow1End = {
      x: end[0] - arrowLength * Math.cos(angle - arrowAngle),
      y: end[1] - arrowLength * Math.sin(angle - arrowAngle),
    };
    const arrow2End = {
      x: end[0] - arrowLength * Math.cos(angle + arrowAngle),
      y: end[1] - arrowLength * Math.sin(angle + arrowAngle),
    };

    page.drawLine({
      start: { x: end[0], y: end[1] },
      end: arrow1End,
      color: rgb(r, g, b),
      thickness: strokeWidth,
    });
    page.drawLine({
      start: { x: end[0], y: end[1] },
      end: arrow2End,
      color: rgb(r, g, b),
      thickness: strokeWidth,
    });
  }
}

/**
 * Add sticky note annotation
 * For now, we draw a simple note icon
 */
function addStickyNoteAnnotation(page: PDFPage, annotation: StickyNoteAnnotation): void {
  const { position, color } = annotation;
  const { r, g, b } = hexToRgb(color);
  const size = 20;

  // Draw note icon as a rectangle
  page.drawRectangle({
    x: position.x,
    y: position.y,
    width: size,
    height: size,
    color: rgb(r, g, b),
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });

  // Draw corner fold
  page.drawLine({
    start: { x: position.x + size - 5, y: position.y + size },
    end: { x: position.x + size, y: position.y + size - 5 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
}

/**
 * Add stamp annotation
 */
function addStampAnnotation(page: PDFPage, annotation: StampAnnotation): void {
  const { rect, stampName, color } = annotation;
  const { r, g, b } = hexToRgb(color);

  // Draw stamp border
  page.drawRectangle({
    x: rect[0],
    y: rect[1],
    width: rect[2],
    height: rect[3],
    borderColor: rgb(r, g, b),
    borderWidth: 2,
  });

  // Draw stamp text
  page.drawText(stampName.toUpperCase(), {
    x: rect[0] + 10,
    y: rect[1] + rect[3] / 2 - 6,
    size: Math.min(rect[3] * 0.4, 16),
    color: rgb(r, g, b),
  });
}

/**
 * Get style from annotation (handle legacy format)
 */
function getAnnotationStyle(annotation: FreeTextAnnotation): TextStyle {
  if (annotation.style) {
    return annotation.style;
  }
  // Legacy format conversion
  return {
    ...DEFAULT_TEXT_STYLE,
    fontSize: annotation.fontSize || DEFAULT_TEXT_STYLE.fontSize,
    fontFamily: annotation.fontFamily || DEFAULT_TEXT_STYLE.fontFamily,
    color: annotation.textColor || annotation.color || DEFAULT_TEXT_STYLE.color,
    backgroundColor: annotation.backgroundColor || 'transparent',
    borderColor: annotation.borderColor || DEFAULT_TEXT_STYLE.borderColor,
    borderWidth: annotation.borderWidth || DEFAULT_TEXT_STYLE.borderWidth,
  };
}

/**
 * Add free text annotation with full styling support
 */
async function addFreeTextAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  annotation: FreeTextAnnotation,
  embeddedFonts: Map<string, Awaited<ReturnType<typeof pdfDoc.embedFont>>>
): Promise<void> {
  const { rect, content } = annotation;
  const style = getAnnotationStyle(annotation);

  // Get or embed the required font
  const fontKey = `${style.fontFamily}-${style.fontWeight}-${style.fontStyle}`;
  let font = embeddedFonts.get(fontKey);
  if (!font) {
    const standardFont = mapFontToStandard(style.fontFamily, style.fontWeight, style.fontStyle);
    font = await pdfDoc.embedFont(standardFont);
    embeddedFonts.set(fontKey, font);
  }

  const textColor = hexToRgb(style.color);

  // Draw background if set
  if (style.backgroundColor && style.backgroundColor !== 'transparent') {
    const bg = hexToRgb(style.backgroundColor);
    page.drawRectangle({
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      color: rgb(bg.r, bg.g, bg.b),
    });
  }

  // Draw border if set
  if (style.borderWidth > 0) {
    const border = hexToRgb(style.borderColor);
    page.drawRectangle({
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      borderColor: rgb(border.r, border.g, border.b),
      borderWidth: style.borderWidth,
    });
  }

  // Calculate text position based on alignment
  const fontSize = style.fontSize;
  const lineHeight = fontSize * 1.2;
  const padding = 4;

  // Word wrap the text
  const maxWidth = rect[2] - padding * 2;
  const wrappedLines: string[] = [];

  const inputLines = content.split('\n');
  for (const inputLine of inputLines) {
    const words = inputLine.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (textWidth > maxWidth && currentLine) {
        wrappedLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      wrappedLines.push(currentLine);
    }
  }

  // Draw text lines
  let y = rect[1] + rect[3] - fontSize - padding;
  for (const line of wrappedLines) {
    if (y < rect[1]) break;

    // Calculate x position based on alignment
    let x = rect[0] + padding;
    if (style.textAlign === 'center') {
      const lineWidth = font.widthOfTextAtSize(line, fontSize);
      x = rect[0] + (rect[2] - lineWidth) / 2;
    } else if (style.textAlign === 'right') {
      const lineWidth = font.widthOfTextAtSize(line, fontSize);
      x = rect[0] + rect[2] - lineWidth - padding;
    }

    page.drawText(line, {
      x: x,
      y: y,
      size: fontSize,
      font: font,
      color: rgb(textColor.r, textColor.g, textColor.b),
    });

    // Draw underline if needed
    if (style.textDecoration === 'underline') {
      const lineWidth = font.widthOfTextAtSize(line, fontSize);
      page.drawLine({
        start: { x: x, y: y - 2 },
        end: { x: x + lineWidth, y: y - 2 },
        color: rgb(textColor.r, textColor.g, textColor.b),
        thickness: 1,
      });
    }

    y -= lineHeight;
  }
}
