/**
 * Annotation Serializer - Saves annotations to PDF using pdf-lib
 */
import {
  AnnotationFlags, PDFDocument, PDFPage, PDFHexString, PDFString, PDFName,
  rgb, appendBezierCurve, clip, closePath, concatTransformationMatrix,
  endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState, setDashPattern,
  setGraphicsState, setLineWidth, setStrokingColor, stroke,
} from 'pdf-lib';
import type {
  Annotation,
  TextMarkupAnnotation,
  InkAnnotation,
  RectangleAnnotation,
  EllipseAnnotation,
  LineAnnotation,
  StickyNoteAnnotation,
  StickyNoteReply,
  NativeTextMetadata,
  StampAnnotation,
  FreeTextAnnotation,
  ImageAnnotation,
} from './types';
import { createFreeTextAppearance, type FreeTextAppearance } from './FreeTextAppearance';
import { addNativeAnnotation, annotationBounds } from './NativeAnnotation';

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
  annotations: Map<number, Annotation[]>,
  options: { flattenAnnotations?: boolean } = {},
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfData, { updateMetadata: false });
  const pages = pdfDoc.getPages();

  // Process each page's annotations
  for (const [pageNumber, pageAnnotations] of annotations) {
    const pageIndex = pageNumber - 1;
    if (!Number.isInteger(pageNumber) || pageIndex < 0 || pageIndex >= pages.length) {
      if (pageAnnotations.length > 0) throw new Error(`Cannot export annotations on missing page ${pageNumber}`);
      continue;
    }

    const page = pages[pageIndex];

    for (const original of [...pageAnnotations].sort((a, b) => ('zIndex' in a ? a.zIndex ?? 0 : 0) - ('zIndex' in b ? b.zIndex ?? 0 : 0))) {
      let annotation = original;
      try {
        let textAppearance: FreeTextAppearance | undefined;
        if (annotation.type === 'freetext') {
          textAppearance = await createFreeTextAppearance(annotation);
          const rect = annotation.rect;
          annotation = { ...annotation, rect: [rect[0], rect[1] + rect[3] - textAppearance.height, rect[2], textAppearance.height] };
          const media = page.getMediaBox();
          if (annotation.rect[1] + annotation.rect[3] - textAppearance.contentHeight < media.y - .01) throw new Error('Text exceeds the page height. Move the text box upward or widen it; no text was truncated.');
        }
        if (annotation.type === 'sticky-note' || options.flattenAnnotations) {
          await addAnnotationToPage(pdfDoc, page, annotation, textAppearance);
        } else {
          const bounds = annotationBounds(annotation);
          const scratch = pdfDoc.addPage([page.getWidth(), page.getHeight()]);
          try {
            await addAnnotationToPage(pdfDoc, scratch, annotation, textAppearance);
            const appearance = await pdfDoc.embedPage(scratch, { left: bounds[0], bottom: bounds[1], right: bounds[2], top: bounds[3] });
            await appearance.embed();
            await addNativeAnnotation(pdfDoc, page, annotation, appearance.ref, bounds);
          } finally { pdfDoc.removePage(pdfDoc.getPageCount() - 1); }
        }
      } catch (error) {
        throw new Error(`Failed to export ${annotation.type} annotation "${annotation.id}" on page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
  textAppearance?: FreeTextAppearance,
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
      addStickyNoteAnnotation(pdfDoc, page, annotation);
      break;
    case 'stamp':
      await addStampAnnotation(pdfDoc, page, annotation);
      break;
    case 'freetext':
      await addFreeTextAnnotation(pdfDoc, page, annotation, textAppearance!);
      break;
    case 'image':
      await addImageAnnotation(pdfDoc, page, annotation);
      break;
    default:
      throw new Error('Unsupported annotation type');
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
 * Add a native PDF text note. Contents and replies remain readable text in
 * standard PDF annotation dictionaries; the reader supplies the note icon.
 */
function addStickyNoteAnnotation(pdfDoc: PDFDocument, page: PDFPage, annotation: StickyNoteAnnotation): void {
  if (!Number.isFinite(annotation.position.x) || !Number.isFinite(annotation.position.y)) {
    throw new Error('Note position is invalid');
  }
  const iconNames: Record<StickyNoteAnnotation['iconType'], string> = {
    comment: 'Comment', key: 'Key', note: 'Note', help: 'Help',
    newparagraph: 'NewParagraph', paragraph: 'Paragraph', insert: 'Insert',
  };
  const originalRect = annotation.nativeText?.rectangle;
  const deltaX = originalRect ? annotation.position.x - originalRect[0] : 0;
  const deltaY = originalRect ? annotation.position.y - originalRect[3] : 0;
  const translateRect = (rectangle: [number, number, number, number]) => [
    rectangle[0] + deltaX, rectangle[1] + deltaY, rectangle[2] + deltaX, rectangle[3] + deltaY,
  ];
  // DrawingAnnotationLayer positions the icon by its top-left. PDF Rect uses
  // bottom-left/top-right corners, so extend down from that point.
  const rectangle = originalRect ? translateRect(originalRect)
    : [annotation.position.x, annotation.position.y - 24, annotation.position.x + 24, annotation.position.y];
  const createNote = (item: StickyNoteAnnotation | StickyNoteReply, isReply: boolean) => {
    const metadata: NativeTextMetadata | undefined = item.nativeText;
    const color = item.color ?? annotation.color;
    const { r, g, b } = hexToRgb(color);
    // Preserve source RGB precision until the user actually changes its color.
    const originalColor = metadata?.color;
    const originalHex = originalColor && `#${originalColor.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
    const note = pdfDoc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      P: page.ref,
      Rect: isReply && metadata ? translateRect(metadata.rectangle) : rectangle,
      Contents: PDFHexString.fromText(item.content),
      T: item.author === undefined ? undefined : PDFHexString.fromText(item.author),
      NM: PDFHexString.fromText(item.sourceNM ?? (isReply ? `${annotation.id}:reply:${item.id}` : item.id)),
      CreationDate: metadata && !metadata.hasCreationDate ? undefined : annotationDate(item.createdAt),
      M: metadata && !metadata.hasModifiedDate && (item.modifiedAt?.getTime() ?? 0) === item.createdAt.getTime()
        ? undefined : annotationDate(item.modifiedAt ?? item.createdAt),
      Name: iconNames[item.iconType ?? 'comment'],
      C: metadata && !originalColor && color.toLowerCase() === '#ffff00' ? undefined
        : originalHex === color.toLowerCase() ? originalColor : [r, g, b],
      CA: item.opacity ?? annotation.opacity,
      Open: item.isOpen ?? false,
      F: metadata?.flags ?? (AnnotationFlags.Print | AnnotationFlags.NoZoom | AnnotationFlags.NoRotate),
      Subj: metadata?.subject === undefined ? undefined : PDFHexString.fromText(metadata.subject),
    });
    const reference = pdfDoc.context.register(note);
    page.node.addAnnot(reference);
    if (metadata?.popup) {
      const popup = pdfDoc.context.register(pdfDoc.context.obj({
        Type: 'Annot', Subtype: 'Popup', P: page.ref, Parent: reference,
        Rect: translateRect(metadata.popup.rectangle), F: metadata.popup.flags,
        Open: metadata.popup.isOpen,
      }));
      note.set(PDFName.of('Popup'), popup);
      page.node.addAnnot(popup);
    }
    return { note, reference };
  };
  const parent = createNote(annotation, false);
  for (const reply of annotation.replies ?? []) {
    const child = createNote(reply, true);
    child.note.set(PDFName.of('IRT'), parent.reference);
    child.note.set(PDFName.of('RT'), PDFName.of('R'));
  }
}

function annotationDate(date: Date): PDFString {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('Annotation contains an invalid date');
  }
  return PDFString.fromDate(date);
}

/**
 * Add stamp annotation
 */
async function addStampAnnotation(pdfDoc: PDFDocument, page: PDFPage, annotation: StampAnnotation): Promise<void> {
  const { rect, stampName, color } = annotation;
  const { r, g, b } = hexToRgb(color);

  if (annotation.stampType === 'custom') {
    if (!annotation.customImageData) throw new Error('Custom stamp image is missing');
    const image = await embedImageData(pdfDoc, annotation.customImageData);
    page.drawImage(image, {
      x: rect[0], y: rect[1], width: rect[2], height: rect[3], opacity: annotation.opacity,
    });
    return;
  }

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

/** Paint the measured vector appearance with the same clockwise center rotation as the editor. */
async function addFreeTextAnnotation(pdfDoc: PDFDocument, page: PDFPage, annotation: FreeTextAnnotation, appearance: FreeTextAppearance): Promise<void> {
  const [embedded] = await pdfDoc.embedPdf(appearance.bytes);
  const [x, y, width, height] = annotation.rect;
  const radians = -(annotation.rotation ?? 0) * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const centerX = x + width / 2, centerY = y + height / 2;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos,
    centerX - cos * width / 2 + sin * height / 2, centerY - sin * width / 2 - cos * height / 2));
  try { page.drawPage(embedded, { x: 0, y: 0, width, height }); }
  finally { page.pushOperators(popGraphicsState()); }
}

/**
 * Add image annotation to PDF page
 */
async function addImageAnnotation(
  pdfDoc: PDFDocument,
  page: PDFPage,
  annotation: ImageAnnotation
): Promise<void> {
  const [x, y, width, height] = annotation.rect;
  const rotation = annotation.rotation ?? 0;
  const opacity = annotation.opacity ?? 1;
  const borderWidth = annotation.borderWidth ?? 0;
  const radius = annotation.borderRadius ?? 0;
  const crop = annotation.cropBounds ?? { top: 0, right: 0, bottom: 0, left: 0 };
  if (![x, y, width, height, rotation, opacity, borderWidth, radius].every(Number.isFinite)
    || width <= 0 || height <= 0 || borderWidth < 0 || radius < 0 || opacity < 0 || opacity > 1) {
    throw new Error('Invalid image dimensions, rotation, opacity, or border');
  }
  if (![crop.top, crop.right, crop.bottom, crop.left].every(value => Number.isFinite(value) && value >= 0 && value <= 100)
    || crop.left + crop.right >= 100 || crop.top + crop.bottom >= 100) {
    throw new Error('Image crop must leave a nonempty visible area');
  }
  const embeddedImage = await embedImageData(pdfDoc, annotation.imageData);
  // Canvas uses clockwise screen rotation about the center. PDF coordinates
  // point upwards, so negate the angle and apply flips in the local image axes.
  const angle = -(rotation % 360) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const flipX = annotation.flipHorizontal ? -1 : 1;
  const flipY = annotation.flipVertical ? -1 : 1;
  const a = cos * flipX;
  const b = sin * flipX;
  const c = -sin * flipY;
  const d = cos * flipY;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const cornerRadius = Math.min(radius, width / 2, height / 2);

  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(a, b, c, d,
      centerX - a * width / 2 - c * height / 2,
      centerY - b * width / 2 - d * height / 2),
  );
  try {
    // The editor draws the border first, then the clipped image covers its
    // inside half. Keep that order and opacity in the exported appearance.
    if (borderWidth > 0 && annotation.borderStyle !== 'none') {
      const { r, g, b: blue } = hexToRgb(annotation.borderColor || '#000000');
      const dash = annotation.borderStyle === 'dashed' ? [6, 3]
        : annotation.borderStyle === 'dotted' ? [2, 2] : [];
      const graphicsState = page.node.newExtGState('ImageBorderOpacity', pdfDoc.context.register(
        pdfDoc.context.obj({ Type: 'ExtGState', CA: opacity }),
      ));
      page.pushOperators(setGraphicsState(graphicsState), setStrokingColor(rgb(r, g, blue)),
        setLineWidth(borderWidth), setDashPattern(dash, 0),
        ...imageFramePath(width, height, cornerRadius), stroke());
    }

    // A non-destructive crop expands and offsets the image behind a clipping
    // path. This retains image pixels and applies the same crop as the editor.
    const fullWidth = width / (1 - (crop.left + crop.right) / 100);
    const fullHeight = height / (1 - (crop.top + crop.bottom) / 100);
    page.pushOperators(...imageFramePath(width, height, cornerRadius), clip(), endPath());
    page.drawImage(embeddedImage, {
      x: -fullWidth * crop.left / 100,
      y: -fullHeight * crop.bottom / 100,
      width: fullWidth,
      height: fullHeight,
      opacity,
    });
  } finally {
    page.pushOperators(popGraphicsState());
  }
}

function imageFramePath(width: number, height: number, radius: number) {
  if (radius === 0) {
    return [moveTo(0, 0), lineTo(width, 0), lineTo(width, height), lineTo(0, height), closePath()];
  }
  // Cubic equivalents of the editor canvas's quadratic corner curves.
  const third = radius / 3;
  return [
    moveTo(radius, 0), lineTo(width - radius, 0),
    appendBezierCurve(width - third, 0, width, third, width, radius),
    lineTo(width, height - radius),
    appendBezierCurve(width, height - third, width - third, height, width - radius, height),
    lineTo(radius, height),
    appendBezierCurve(third, height, 0, height - third, 0, height - radius),
    lineTo(0, radius),
    appendBezierCurve(0, third, third, 0, radius, 0), closePath(),
  ];
}

async function embedImageData(pdfDoc: PDFDocument, dataUrl: string) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match) throw new Error('Image must be a base64 PNG or JPEG data URL');
  const mimeType = match[1].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType)) {
    throw new Error(`Unsupported image format "${mimeType}"; use PNG or JPEG`);
  }
  try {
    const binary = atob(match[2]);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return mimeType === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  } catch (error) {
    throw new Error(`Unable to embed ${mimeType} image: ${error instanceof Error ? error.message : String(error)}`);
  }
}
