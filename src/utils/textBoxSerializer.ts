import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFString, rgb, PDFRef } from 'pdf-lib';
import type { FreeTextAnnotation, TextStyle, BoxStyle } from '../annotations/types';
import { DEFAULT_TEXT_STYLE, DEFAULT_BOX_STYLE } from '../annotations/types';

/**
 * Serializer for FreeText annotations to/from PDF format
 */

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

// Convert RGB (0-1 range) to hex
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const hex = Math.round(n * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Generate unique annotation ID
function generateId(): string {
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Save a FreeText annotation to a PDF page
 */
export async function saveTextBoxToPDF(
  textBox: FreeTextAnnotation,
  pdfDoc: PDFDocument
): Promise<void> {
  const page = pdfDoc.getPage(textBox.pageNumber - 1);

  const style = textBox.style || DEFAULT_TEXT_STYLE;
  const boxStyle = textBox.boxStyle || DEFAULT_BOX_STYLE;
  const [x, y, width, height] = textBox.rect;

  // Create the annotation dictionary
  const annotDict = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [x, y, x + width, y + height],
    Contents: textBox.content || '',
    DA: `/${style.fontFamily.replace(/\s/g, '')} ${style.fontSize} Tf ${hexToRgb(style.color).r} ${hexToRgb(style.color).g} ${hexToRgb(style.color).b} rg`,
    Q: style.textAlign === 'center' ? 1 : style.textAlign === 'right' ? 2 : 0,
  });

  // Add border if specified
  if (boxStyle.borderWidth > 0 && boxStyle.borderStyle !== 'none') {
    const borderColor = hexToRgb(boxStyle.borderColor);
    annotDict.set(PDFName.of('C'), pdfDoc.context.obj([borderColor.r, borderColor.g, borderColor.b]));
    annotDict.set(PDFName.of('BS'), pdfDoc.context.obj({
      W: boxStyle.borderWidth,
      S: boxStyle.borderStyle === 'dashed' ? 'D' : boxStyle.borderStyle === 'dotted' ? 'D' : 'S',
    }));
  }

  // Add background color if not transparent
  if (boxStyle.backgroundColor && boxStyle.backgroundColor !== 'transparent') {
    const bgColor = hexToRgb(boxStyle.backgroundColor);
    annotDict.set(PDFName.of('IC'), pdfDoc.context.obj([bgColor.r, bgColor.g, bgColor.b]));
  }

  // Add rotation if specified
  if (textBox.rotation && textBox.rotation !== 0) {
    // FreeText annotations don't have native rotation in PDF spec
    // We can store it as a custom property or in the appearance stream
    annotDict.set(PDFName.of('Rotate'), PDFNumber.of(textBox.rotation));
  }

  // Add a reference to the annotation in the page's Annots array
  const annotsRef = page.node.get(PDFName.of('Annots'));
  const annotRef = pdfDoc.context.register(annotDict);

  if (annotsRef instanceof PDFArray) {
    annotsRef.push(annotRef);
  } else if (annotsRef instanceof PDFRef) {
    const annotsArray = pdfDoc.context.lookup(annotsRef);
    if (annotsArray instanceof PDFArray) {
      annotsArray.push(annotRef);
    }
  } else {
    // Create new Annots array
    const newAnnotsArray = pdfDoc.context.obj([annotRef]);
    page.node.set(PDFName.of('Annots'), newAnnotsArray);
  }
}

/**
 * Load FreeText annotations from a PDF
 */
export async function loadTextBoxesFromPDF(
  pdfDoc: PDFDocument
): Promise<FreeTextAnnotation[]> {
  const textBoxes: FreeTextAnnotation[] = [];
  const pages = pdfDoc.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const annotsRef = page.node.get(PDFName.of('Annots'));

    if (!annotsRef) continue;

    let annots: PDFArray | null = null;

    if (annotsRef instanceof PDFArray) {
      annots = annotsRef;
    } else if (annotsRef instanceof PDFRef) {
      const resolved = pdfDoc.context.lookup(annotsRef);
      if (resolved instanceof PDFArray) {
        annots = resolved;
      }
    }

    if (!annots) continue;

    for (let i = 0; i < annots.size(); i++) {
      const annotRef = annots.get(i);
      if (!(annotRef instanceof PDFRef)) continue;

      const annotDict = pdfDoc.context.lookup(annotRef);
      if (!(annotDict instanceof PDFDict)) continue;

      const subtype = annotDict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'FreeText') continue;

      const textBox = parseFreeTextAnnotation(annotDict, pageIndex + 1);
      if (textBox) {
        textBoxes.push(textBox);
      }
    }
  }

  return textBoxes;
}

/**
 * Parse a FreeText annotation dictionary into a FreeTextAnnotation object
 */
function parseFreeTextAnnotation(
  annotDict: PDFDict,
  pageNumber: number
): FreeTextAnnotation | null {
  try {
    // Get rectangle
    const rectArray = annotDict.get(PDFName.of('Rect'));
    if (!(rectArray instanceof PDFArray)) return null;

    const rectValues: number[] = [];
    for (let i = 0; i < Math.min(4, rectArray.size()); i++) {
      const val = rectArray.get(i);
      if (val instanceof PDFNumber) {
        rectValues.push(val.asNumber());
      }
    }

    if (rectValues.length !== 4) return null;

    const [x1, y1, x2, y2] = rectValues;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    // Get content
    const contents = annotDict.get(PDFName.of('Contents'));
    let content = '';
    if (contents instanceof PDFString) {
      content = contents.decodeText();
    }

    // Parse default appearance (DA) for font and color
    let style: TextStyle = { ...DEFAULT_TEXT_STYLE };
    const da = annotDict.get(PDFName.of('DA'));
    if (da instanceof PDFString) {
      const daText = da.decodeText();
      // Parse font size (e.g., "/Helvetica 12 Tf")
      const fontMatch = daText.match(/\/(\w+)\s+(\d+(?:\.\d+)?)\s+Tf/);
      if (fontMatch) {
        style.fontFamily = fontMatch[1];
        style.fontSize = parseFloat(fontMatch[2]);
      }
      // Parse color (e.g., "0 0 0 rg")
      const colorMatch = daText.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+rg/);
      if (colorMatch) {
        style.color = rgbToHex(
          parseFloat(colorMatch[1]),
          parseFloat(colorMatch[2]),
          parseFloat(colorMatch[3])
        );
      }
    }

    // Parse text alignment (Q)
    const q = annotDict.get(PDFName.of('Q'));
    if (q instanceof PDFNumber) {
      const qValue = q.asNumber();
      style.textAlign = qValue === 1 ? 'center' : qValue === 2 ? 'right' : 'left';
    }

    // Parse box style
    let boxStyle: BoxStyle = { ...DEFAULT_BOX_STYLE };

    // Border
    const bs = annotDict.get(PDFName.of('BS'));
    if (bs instanceof PDFDict) {
      const w = bs.get(PDFName.of('W'));
      if (w instanceof PDFNumber) {
        boxStyle.borderWidth = w.asNumber();
      }
      const s = bs.get(PDFName.of('S'));
      if (s instanceof PDFName) {
        const sValue = s.decodeText();
        boxStyle.borderStyle = sValue === 'D' ? 'dashed' : 'solid';
      }
    }

    // Border color (C)
    const c = annotDict.get(PDFName.of('C'));
    if (c instanceof PDFArray && c.size() >= 3) {
      const r = c.get(0);
      const g = c.get(1);
      const b = c.get(2);
      if (r instanceof PDFNumber && g instanceof PDFNumber && b instanceof PDFNumber) {
        boxStyle.borderColor = rgbToHex(r.asNumber(), g.asNumber(), b.asNumber());
      }
    }

    // Background/Interior color (IC)
    const ic = annotDict.get(PDFName.of('IC'));
    if (ic instanceof PDFArray && ic.size() >= 3) {
      const r = ic.get(0);
      const g = ic.get(1);
      const b = ic.get(2);
      if (r instanceof PDFNumber && g instanceof PDFNumber && b instanceof PDFNumber) {
        boxStyle.backgroundColor = rgbToHex(r.asNumber(), g.asNumber(), b.asNumber());
      }
    }

    // Rotation
    let rotation = 0;
    const rotate = annotDict.get(PDFName.of('Rotate'));
    if (rotate instanceof PDFNumber) {
      rotation = rotate.asNumber();
    }

    return {
      id: generateId(),
      type: 'freetext',
      pageNumber,
      rect: [x, y, width, height],
      content,
      style,
      boxStyle,
      rotation,
      color: style.color,
      opacity: 1,
      createdAt: new Date(),
      modifiedAt: new Date(),
    };
  } catch (error) {
    console.error('Error parsing FreeText annotation:', error);
    return null;
  }
}

/**
 * Save all text boxes to a PDF document
 */
export async function saveAllTextBoxesToPDF(
  textBoxes: FreeTextAnnotation[],
  pdfBytes: ArrayBuffer
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);

  for (const textBox of textBoxes) {
    await saveTextBoxToPDF(textBox, pdfDoc);
  }

  return pdfDoc.save();
}

/**
 * Load all text boxes from a PDF document
 */
export async function loadAllTextBoxesFromPDF(
  pdfBytes: ArrayBuffer
): Promise<FreeTextAnnotation[]> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return loadTextBoxesFromPDF(pdfDoc);
}

/**
 * Flatten a text box into the PDF content (make it permanent/non-editable)
 */
export async function flattenTextBox(
  textBox: FreeTextAnnotation,
  pdfBytes: ArrayBuffer
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const page = pdfDoc.getPage(textBox.pageNumber - 1);

  const style = textBox.style || DEFAULT_TEXT_STYLE;
  const boxStyle = textBox.boxStyle || DEFAULT_BOX_STYLE;
  const [x, y, width, height] = textBox.rect;

  // Draw background if not transparent
  if (boxStyle.backgroundColor && boxStyle.backgroundColor !== 'transparent') {
    const bgColor = hexToRgb(boxStyle.backgroundColor);
    page.drawRectangle({
      x,
      y,
      width,
      height,
      color: rgb(bgColor.r, bgColor.g, bgColor.b),
      opacity: boxStyle.backgroundOpacity ?? 1,
    });
  }

  // Draw border if specified
  if (boxStyle.borderWidth > 0 && boxStyle.borderStyle !== 'none') {
    const borderColor = hexToRgb(boxStyle.borderColor);
    page.drawRectangle({
      x,
      y,
      width,
      height,
      borderColor: rgb(borderColor.r, borderColor.g, borderColor.b),
      borderWidth: boxStyle.borderWidth,
    });
  }

  // Draw text
  if (textBox.content) {
    const textColor = hexToRgb(style.color);
    const fontSize = style.fontSize;
    const lineHeight = fontSize * (style.lineHeight || 1.4);
    const padding = boxStyle.padding || { top: 8, right: 8, bottom: 8, left: 8 };

    // Simple text drawing (doesn't handle word wrap perfectly)
    const lines = textBox.content.split('\n');
    let textY = y + height - padding.top - fontSize;

    for (const line of lines) {
      if (textY < y + padding.bottom) break;

      let textX = x + padding.left;

      // Adjust for alignment
      if (style.textAlign === 'center') {
        // Would need font metrics to calculate properly
        textX = x + width / 2;
      } else if (style.textAlign === 'right') {
        textX = x + width - padding.right;
      }

      page.drawText(line, {
        x: textX,
        y: textY,
        size: fontSize,
        color: rgb(textColor.r, textColor.g, textColor.b),
      });

      textY -= lineHeight;
    }
  }

  return pdfDoc.save();
}

/**
 * Remove text box annotations from PDF (used when flattening)
 */
export async function removeTextBoxAnnotations(
  pdfBytes: ArrayBuffer
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const annotsRef = page.node.get(PDFName.of('Annots'));
    if (!annotsRef) continue;

    let annots: PDFArray | null = null;
    let annotsArray: PDFArray | null = null;

    if (annotsRef instanceof PDFArray) {
      annotsArray = annotsRef;
      annots = annotsRef;
    } else if (annotsRef instanceof PDFRef) {
      const resolved = pdfDoc.context.lookup(annotsRef);
      if (resolved instanceof PDFArray) {
        annotsArray = resolved;
        annots = resolved;
      }
    }

    if (!annots || !annotsArray) continue;

    // Filter out FreeText annotations
    const newAnnots = pdfDoc.context.obj([]);
    for (let i = 0; i < annots.size(); i++) {
      const annotRef = annots.get(i);
      if (!(annotRef instanceof PDFRef)) {
        (newAnnots as PDFArray).push(annotRef);
        continue;
      }

      const annotDict = pdfDoc.context.lookup(annotRef);
      if (!(annotDict instanceof PDFDict)) {
        (newAnnots as PDFArray).push(annotRef);
        continue;
      }

      const subtype = annotDict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'FreeText') {
        (newAnnots as PDFArray).push(annotRef);
      }
      // If it's a FreeText annotation, we don't add it back (effectively removing it)
    }

    page.node.set(PDFName.of('Annots'), newAnnots);
  }

  return pdfDoc.save();
}
