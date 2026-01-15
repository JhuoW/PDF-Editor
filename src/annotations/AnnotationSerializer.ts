/**
 * Annotation Serializer - Saves annotations to PDF using pdf-lib
 */
import { PDFDocument, PDFPage, rgb } from 'pdf-lib';
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
} from './types';

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

  // Process each page's annotations
  for (const [pageNumber, pageAnnotations] of annotations) {
    const pageIndex = pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];

    for (const annotation of pageAnnotations) {
      await addAnnotationToPage(page, annotation);
    }
  }

  return pdfDoc.save();
}

/**
 * Add a single annotation to a PDF page
 */
async function addAnnotationToPage(page: PDFPage, annotation: Annotation): Promise<void> {
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
      addFreeTextAnnotation(page, annotation);
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
 * Add free text annotation
 */
function addFreeTextAnnotation(page: PDFPage, annotation: FreeTextAnnotation): void {
  const { rect, content, fontSize, textColor, backgroundColor, borderColor, borderWidth } = annotation;
  const text = hexToRgb(textColor);

  // Draw background if set
  if (backgroundColor) {
    const bg = hexToRgb(backgroundColor);
    page.drawRectangle({
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      color: rgb(bg.r, bg.g, bg.b),
    });
  }

  // Draw border if set
  if (borderColor && borderWidth > 0) {
    const border = hexToRgb(borderColor);
    page.drawRectangle({
      x: rect[0],
      y: rect[1],
      width: rect[2],
      height: rect[3],
      borderColor: rgb(border.r, border.g, border.b),
      borderWidth: borderWidth,
    });
  }

  // Draw text
  const lines = content.split('\n');
  let y = rect[1] + rect[3] - fontSize - 4;
  for (const line of lines) {
    if (y < rect[1]) break;
    page.drawText(line, {
      x: rect[0] + 4,
      y: y,
      size: fontSize,
      color: rgb(text.r, text.g, text.b),
    });
    y -= fontSize * 1.2;
  }
}
