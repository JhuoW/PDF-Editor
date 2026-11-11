import type { Device, Path } from 'mupdf';
import { TextLayoutSession, standardTextFont, hexColor, normalizeReplacementText, type TextGlyphStyle, type TextLayoutInput, type TextLayoutResult } from '../editing/TextLayout';
import { loadMuPDF } from '../utils/mupdf';
import { DEFAULT_TEXT_STYLE, type FreeTextAnnotation, type TextStyle } from './types';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface Paragraph { input: TextLayoutInput; layout: TextLayoutResult; styles: TextStyle[] }
export interface FreeTextAppearance { bytes: Uint8Array<ArrayBuffer>; width: number; height: number; requiredHeight: number; contentHeight: number }

export function freeTextStyle(annotation: FreeTextAnnotation): TextStyle {
  return { ...DEFAULT_TEXT_STYLE, ...annotation.style, ...(annotation.style ? {} : {
    fontSize: annotation.fontSize ?? DEFAULT_TEXT_STYLE.fontSize,
    fontFamily: annotation.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily,
    color: annotation.textColor ?? annotation.color,
    backgroundColor: annotation.backgroundColor ?? 'transparent',
    borderColor: annotation.borderColor ?? DEFAULT_TEXT_STYLE.borderColor,
    borderWidth: annotation.borderWidth ?? 0,
  }) };
}
function fontName(style: TextStyle) {
  return standardTextFont(`${style.fontFamily.replace(/-?(Bold|Italic|Oblique)/gi, '')}${style.fontWeight === 'bold' ? '-Bold' : ''}${style.fontStyle === 'italic' ? '-Italic' : ''}`);
}
function normalizedSegments(annotation: FreeTextAnnotation, style: TextStyle) {
  const rich = annotation.richContent;
  const segments = rich?.length && rich.map(segment => segment.text).join('') === annotation.content
    ? rich : [{ text: annotation.content, style: {} }];
  return segments.map(segment => ({ text: normalizeReplacementText(segment.text), style: { ...style, ...segment.style } }));
}
function layoutTextBox(annotation: FreeTextAnnotation, session: TextLayoutSession) {
  const style = freeTextStyle(annotation), box = annotation.boxStyle;
  const [,, width, originalHeight] = annotation.rect;
  const padding = box?.padding ?? { top: 8, right: 8, bottom: 8, left: 8 };
  if (![width, originalHeight, ...Object.values(padding)].every(Number.isFinite) || width <= 0 || originalHeight <= 0
    || Object.values(padding).some(value => value < 0) || width - padding.left - padding.right <= 0) throw new Error('Text box dimensions or padding are invalid');
  const segments = normalizedSegments(annotation, style);
  if (segments.reduce((count, segment) => count + Array.from(segment.text).length, 0) > 20_000) throw new Error('A text box is limited to 20,000 characters. Split it into smaller text boxes.');
  const paragraphs: Array<{ text: string; styles: TextStyle[] }> = [{ text: '', styles: [] }];
  for (const segment of segments) for (const character of Array.from(segment.text)) {
    if (character === '\n') paragraphs.push({ text: '', styles: [] });
    else { const paragraph = paragraphs.at(-1)!; paragraph.text += character; paragraph.styles.push(segment.style); }
  }
  const result: Paragraph[] = [];
  let y = padding.top;
  for (const paragraph of paragraphs) {
    const current = paragraph.styles[0] ?? style;
    const leading = Math.max(style.lineHeight, ...paragraph.styles.map(item => item.lineHeight));
    const maximumSize = Math.max(style.fontSize, ...paragraph.styles.map(item => item.fontSize));
    const sourceStyles: TextGlyphStyle[] = paragraph.styles.map(item => ({ fontKey: fontName(item), fontName: fontName(item), fontSize: item.fontSize,
      horizontalScale: 1, tracking: item.letterSpacing / item.fontSize, fontColor: item.color, paint: { alpha: annotation.opacity } }));
    const input: TextLayoutInput = {
      text: paragraph.text, rect: { x: padding.left, y, width: width - padding.left - padding.right, height: 14_400 },
      fontName: fontName(current), fontSize: maximumSize, fontColor: current.color,
      alignment: current.textAlign, lineHeight: leading, sourceStyles,
    };
    const layout = session.layout(input);
    const leadingInset = Math.max(0, leading - 1) * maximumSize / 2;
    for (const line of layout.lines) { line.baseline += leadingInset; for (const glyph of line.glyphs) { glyph.baseline += leadingInset; if (glyph.inkBounds) glyph.inkBounds.y += leadingInset; } }
    if (!layout.fits) throw new Error(layout.overflow ?? 'Text exceeds the text box width');
    const advance = Math.max(maximumSize * leading, layout.requiredHeight + Math.max(0, leading - 1) * maximumSize);
    result.push({ input, layout, styles: paragraph.styles });
    y += paragraph.text ? advance : style.fontSize * leading;
  }
  const requiredHeight = Math.ceil((y + padding.bottom) * 1000) / 1000;
  const height = Math.max(originalHeight, requiredHeight);
  if (height > 14_400) throw new Error('Text box height exceeds the supported page dimensions');
  const extra = height - requiredHeight, offset = style.verticalAlign === 'bottom' ? extra : style.verticalAlign === 'middle' ? extra / 2 : 0;
  for (const paragraph of result) for (const line of paragraph.layout.lines) {
    line.baseline += offset;
    for (const glyph of line.glyphs) { glyph.baseline += offset; if (glyph.inkBounds) glyph.inkBounds.y += offset; }
  }
  return { paragraphs: result, width, height, requiredHeight, contentHeight: requiredHeight + offset, style };
}
function roundedRect(engine: Engine, width: number, height: number, radius: number): Path {
  const path = new engine.Path(), r = Math.max(0, Math.min(radius, width / 2, height / 2)), k = .5522847498;
  path.moveTo(r, 0); path.lineTo(width - r, 0); path.curveTo(width - r + k * r, 0, width, r - k * r, width, r);
  path.lineTo(width, height - r); path.curveTo(width, height - r + k * r, width - r + k * r, height, width - r, height);
  path.lineTo(r, height); path.curveTo(r - k * r, height, 0, height - r + k * r, 0, height - r);
  path.lineTo(0, r); path.curveTo(0, r - k * r, r - k * r, 0, r, 0); path.closePath(); return path;
}
function drawBox(engine: Engine, device: Device, annotation: FreeTextAnnotation, width: number, height: number, style: TextStyle) {
  const box = annotation.boxStyle, path = roundedRect(engine, width, height, box?.borderRadius ?? 0);
  try {
    const background = box?.backgroundColor ?? style.backgroundColor;
    if (background !== 'transparent') device.fillPath(path, false, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, hexColor(background), (box?.backgroundOpacity ?? 1) * annotation.opacity);
    const borderWidth = box?.borderWidth ?? style.borderWidth, borderStyle = box?.borderStyle ?? 'solid';
    if (borderWidth > 0 && borderStyle !== 'none') {
      const stroke = new engine.StrokeState({ lineWidth: borderWidth, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 10,
        dashes: borderStyle === 'dashed' ? [6, 3] : borderStyle === 'dotted' ? [2, 2] : [] });
      try { device.strokePath(path, stroke, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, hexColor(box?.borderColor ?? style.borderColor), annotation.opacity); }
      finally { stroke.destroy(); }
    }
  } finally { path.destroy(); }
}
function decorations(engine: Engine, device: Device, paragraph: Paragraph, opacity: number, highlights = false) {
  let index = 0;
  const characters = Array.from(paragraph.input.text);
  for (const line of paragraph.layout.lines) {
    for (const glyph of line.glyphs) {
      // Soft wrapping may discard whitespace, but it never discards styled letters.
      while (index < paragraph.styles.length && characters[index] !== glyph.character && /\s/.test(characters[index])) index++;
      const style = paragraph.styles[index++] ?? paragraph.styles.at(-1);
      if (!style) continue;
      if (highlights) {
        if (style.highlightColor) {
          const path = new engine.Path();
          try { path.rect(glyph.x, glyph.baseline - style.fontSize, glyph.x + glyph.advance, glyph.baseline + style.fontSize * .2); device.fillPath(path, false, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, hexColor(style.highlightColor), opacity); }
          finally { path.destroy(); }
        }
        continue;
      }
      if (style.textDecoration === 'none') continue;
      const y = glyph.baseline + (style.textDecoration === 'underline' ? style.fontSize * .12 : -style.fontSize * .3);
      const path = new engine.Path(), stroke = new engine.StrokeState({ lineWidth: Math.max(.5, style.fontSize / 16), lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 10 });
      try { path.moveTo(glyph.x, y); path.lineTo(glyph.x + glyph.advance, y); device.strokePath(path, stroke, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, hexColor(style.color), opacity); }
      finally { path.destroy(); stroke.destroy(); }
    }
  }
}
/** Vector glyphs and the same measured layout are used by native APs, flattened copies and previews. */
export async function createFreeTextAppearance(annotation: FreeTextAnnotation): Promise<FreeTextAppearance> {
  const engine = await loadMuPDF(), session = new TextLayoutSession(engine), buffer = new engine.Buffer();
  const writer = new engine.DocumentWriter(buffer, 'pdf', '');
  try {
    const plan = layoutTextBox(annotation, session);
    const device = writer.beginPage([0, 0, plan.width, plan.height]);
    try {
      drawBox(engine, device, annotation, plan.width, plan.height, plan.style);
      for (const paragraph of plan.paragraphs) { decorations(engine, device, paragraph, annotation.opacity, true); session.draw(device, paragraph.input, paragraph.layout); decorations(engine, device, paragraph, annotation.opacity); }
      device.close();
    } finally { device.destroy(); }
    writer.endPage(); writer.close();
    const pdf = new engine.PDFDocument(buffer);
    try {
      const page = pdf.findPage(0), resources = page.get('Resources');
      try { session.preserveUnicode(pdf, resources, plan.paragraphs.map(paragraph => paragraph.layout)); }
      finally { resources.destroy(); page.destroy(); }
      const output = pdf.saveToBuffer('garbage=1,compress');
      try { return { bytes: new Uint8Array(output.asUint8Array()), width: plan.width, height: plan.height, requiredHeight: plan.requiredHeight, contentHeight: plan.contentHeight }; }
      finally { output.destroy(); }
    } finally { pdf.destroy(); }
  } finally { writer.destroy(); buffer.destroy(); session.destroy(); }
}
