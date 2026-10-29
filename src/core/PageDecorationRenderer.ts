import type { Color, Font, Image, PDFDocument, PDFObject, StrokeState } from 'mupdf';
import { inspectPDFImage } from './ImagePDF';
import type { DecorationFontFamily } from './PageDecorationTypes';

type Engine = typeof import('mupdf');
export type DecorationRenderInput =
  | { type: 'text'; text: string; fontFamily: DecorationFontFamily; fontSize: number; color: string }
  | { type: 'image'; data: Uint8Array; maxWidth: number; maxHeight: number }
  | { type: 'solid'; width: number; height: number; color: string };
export interface RenderedPageDecoration {
  /** Caller owns this reference. Form coordinates are conventional PDF bottom-left. */
  form: PDFObject;
  width: number;
  height: number;
  /** Direct Image in form.Resources.XObject, with EXIF orientation normalized. */
  imageResourceName?: string;
}
export const DECORATION_RENDER_LIMITS = { textCharacters: 4096, textLines: 50, fontSize: 500, dimension: 14_400 };
interface Glyph { font: Font; id: number; character: string; advance: number }
interface Line { glyphs: Glyph[]; left: number; right: number; ascent: number; descent: number }
interface EmbeddedImage { reference: PDFObject; width: number; height: number }

function color(value: string): Color {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Decoration colors must use six-digit hexadecimal notation, such as #336699.');
  return [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16) / 255) as Color;
}
function dimensions(width: number, height: number) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= DECORATION_RENDER_LIMITS.dimension)) {
    throw new Error('Decoration dimensions must be positive and at most 14,400 points. Reduce its size or text length.');
  }
}
function normalizedText(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter visible text for this decoration.');
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  if (Array.from(normalized).length > DECORATION_RENDER_LIMITS.textCharacters || normalized.split('\n').length > DECORATION_RENDER_LIMITS.textLines) {
    throw new Error('Decoration text is limited to 4,096 characters and 50 lines.');
  }
  const complexRanges = [[0x0590, 0x109f], [0x1100, 0x11ff], [0x1780, 0x18af], [0x200c, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xa980, 0xa9df], [0xaa60, 0xaa7f], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
  if (/\p{M}/u.test(normalized) || Array.from(normalized).some(character => complexRanges.some(([start, end]) => character.codePointAt(0)! >= start && character.codePointAt(0)! <= end))) {
    throw new Error('This decoration requires complex-script or bidirectional layout, which is not supported yet. No characters were omitted or reordered.');
  }
  if (Array.from(normalized).some(character => (character.codePointAt(0)! < 32 && character !== '\n') || character.codePointAt(0) === 127)) {
    throw new Error('Decoration text contains an unsupported control character.');
  }
  return normalized;
}

/** One renderer per target PDF. Input image bytes stay immutable during its lifetime. */
export class PageDecorationRenderer {
  private readonly engine: Engine;
  private readonly document: PDFDocument;
  private readonly fonts = new Map<string, Font>();
  private readonly embeddedFonts = new Map<string, PDFObject>();
  private readonly images = new WeakMap<Uint8Array, EmbeddedImage>();
  private readonly imageReferences = new Set<PDFObject>();
  private stroke: StrokeState | undefined;
  private destroyed = false;

  constructor(engine: Engine, document: PDFDocument) { this.engine = engine; this.document = document; }

  render(input: DecorationRenderInput): RenderedPageDecoration {
    if (this.destroyed) throw new Error('The page decoration renderer has already been released.');
    if (input.type === 'text') return this.text(input);
    if (input.type === 'image') return this.image(input);
    if (input.type === 'solid') {
      dimensions(input.width, input.height);
      const rgb = color(input.color);
      const form = this.document.addStream(`${rgb.join(' ')} rg\n0 0 ${input.width} ${input.height} re f\n`, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, input.width, input.height], Resources: {},
      });
      return { form, width: input.width, height: input.height };
    }
    throw new Error('This page decoration content type is not supported.');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const font of this.fonts.values()) font.destroy();
    for (const font of this.embeddedFonts.values()) font.destroy();
    for (const image of this.imageReferences) image.destroy();
    this.stroke?.destroy();
    this.fonts.clear(); this.embeddedFonts.clear(); this.imageReferences.clear();
  }

  private font(name: string): Font {
    let font = this.fonts.get(name);
    if (!font) { font = new this.engine.Font(name); this.fonts.set(name, font); }
    return font;
  }

  private line(value: string, primary: Font): Line {
    const glyphs = Array.from(value, character => {
      const font = primary.encodeCharacter(character) ? primary : this.font('zh-Hans');
      const id = font.encodeCharacter(character);
      if (!id) throw new Error(`Decoration text contains unsupported character ${JSON.stringify(character)}. No character was replaced or omitted.`);
      return { character, font, id, advance: font.advanceGlyph(id) };
    });
    const text = new this.engine.Text();
    let advance = 0;
    try {
      for (const glyph of glyphs) {
        text.showGlyph(glyph.font, [100, 0, 0, -100, advance * 100, 0], glyph.id, glyph.character.codePointAt(0)!);
        advance += glyph.advance;
      }
      this.stroke ??= new this.engine.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 1 });
      const bounds = text.getBounds(this.stroke, this.engine.Matrix.identity);
      const hasInk = bounds.every(Number.isFinite) && bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
      return {
        glyphs, left: hasInk ? Math.min(0, bounds[0] / 100) : 0,
        right: hasInk ? Math.max(advance, bounds[2] / 100) : advance,
        ascent: Math.max(0.8, hasInk ? -bounds[1] / 100 : 0),
        descent: Math.max(0.2, hasInk ? bounds[3] / 100 : 0),
      };
    } finally { text.destroy(); }
  }

  private graftResources(source: PDFObject): PDFObject {
    const resources = this.document.newDictionary(), fonts = this.document.newDictionary();
    try {
      source.forEach((value, name) => {
        try {
          if (name === 'Font') value.forEach((font, id) => {
            const base = font.get('BaseFont');
            try {
              const key = base.asName();
              // DocumentWriter emits full Identity-H maps for our fixed fonts.
              // Reuse those resources across varying page-number/Bates strings.
              if (!this.embeddedFonts.has(key)) this.embeddedFonts.set(key, this.document.graftObject(font));
              fonts.put(id, this.embeddedFonts.get(key)!);
            } finally { base.destroy(); font.destroy(); }
          });
          else { const grafted = this.document.graftObject(value); try { resources.put(name, grafted); } finally { grafted.destroy(); } }
        } finally { value.destroy(); }
      });
      resources.put('Font', fonts);
      return resources;
    } catch (cause) { resources.destroy(); throw cause; }
    finally { fonts.destroy(); }
  }

  private text(input: Extract<DecorationRenderInput, { type: 'text' }>): RenderedPageDecoration {
    if (!['Helvetica', 'Times', 'Courier'].includes(input.fontFamily)) throw new Error('Choose Helvetica, Times, or Courier for decoration text.');
    if (!Number.isFinite(input.fontSize) || input.fontSize < 1 || input.fontSize > DECORATION_RENDER_LIMITS.fontSize) throw new Error('Decoration font size must be between 1 and 500 points.');
    const rgb = color(input.color), value = normalizedText(input.text);
    const primary = this.font(input.fontFamily === 'Times' ? 'Times-Roman' : input.fontFamily);
    const lines = value.split('\n').map(value => this.line(value, primary));
    const ascent = Math.max(...lines.map(line => line.ascent)), descent = Math.max(...lines.map(line => line.descent));
    const lineAdvance = Math.max(1.25, ascent + descent + 0.1) * input.fontSize;
    const padding = 0.5;
    const width = Math.max(1, Math.ceil((Math.max(...lines.map(line => line.right - line.left)) * input.fontSize + padding * 2) * 1000) / 1000);
    const height = Math.ceil(((ascent + descent) * input.fontSize + (lines.length - 1) * lineAdvance + padding * 2) * 1000) / 1000;
    dimensions(width, height);
    const output = new this.engine.Buffer(), writer = new this.engine.DocumentWriter(output, 'pdf', '');
    let overlay: PDFDocument | undefined;
    try {
      const device = writer.beginPage([0, 0, width, height]);
      try {
        for (const [index, line] of lines.entries()) {
          const text = new this.engine.Text();
          let x = padding - line.left * input.fontSize;
          const baseline = padding + ascent * input.fontSize + index * lineAdvance;
          try {
            for (const glyph of line.glyphs) {
              text.showGlyph(glyph.font, [input.fontSize, 0, 0, -input.fontSize, x, baseline], glyph.id, glyph.character.codePointAt(0)!);
              x += glyph.advance * input.fontSize;
            }
            device.fillText(text, this.engine.Matrix.identity, this.engine.ColorSpace.DeviceRGB, rgb, 1);
          } finally { text.destroy(); }
        }
        device.close();
      } finally { device.destroy(); }
      writer.endPage(); writer.close();
      overlay = new this.engine.PDFDocument(output);
      const page = overlay.findPage(0), content = page.get('Contents'), sourceResources = page.get('Resources');
      try {
        const bytes = content.readStream();
        try {
          const resources = this.graftResources(sourceResources);
          try {
            const form = this.document.addStream(new Uint8Array(bytes.asUint8Array()), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources });
            return { form, width, height };
          } finally { resources.destroy(); }
        } finally { bytes.destroy(); }
      } finally { sourceResources.destroy(); content.destroy(); page.destroy(); }
    } finally { overlay?.destroy(); writer.destroy(); output.destroy(); }
  }

  private embedImage(data: Uint8Array): EmbeddedImage {
    const cached = this.images.get(data); if (cached) return cached;
    const info = inspectPDFImage({ name: 'Decoration image', data });
    let image: Image = new this.engine.Image(data);
    try {
      if (image.getWidth() !== info.width || image.getHeight() !== info.height) throw new Error('The decoration image dimensions are inconsistent.');
      if (info.orientation === 1) {
        // Force decoding now so corrupt compressed data fails before publication.
        const decoded = image.toPixmap(); decoded.destroy();
      } else {
        // Normalize only the input image, at its original resolution. The native
        // Image resource then remains upright when reopened for managed updates.
        const width = info.orientation >= 5 ? info.height : info.width, height = info.orientation >= 5 ? info.width : info.height;
        const pixmap = new this.engine.Pixmap(this.engine.ColorSpace.DeviceRGB, [0, 0, width, height], true);
        try {
          pixmap.clear(0);
          const transforms = [[1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
            [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0], [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1]];
          const [a, b, c, d, e, f] = transforms[info.orientation - 1];
          const device = new this.engine.DrawDevice(this.engine.Matrix.identity, pixmap);
          try { device.fillImage(image, [a * width, b * height, c * width, d * height, e * width, f * height], 1); device.close(); }
          finally { device.destroy(); }
          const normalized = new this.engine.Image(pixmap); image.destroy(); image = normalized;
        } finally { pixmap.destroy(); }
      }
      const reference = this.document.addImage(image);
      const result = { reference, width: image.getWidth(), height: image.getHeight() };
      this.images.set(data, result); this.imageReferences.add(reference);
      return result;
    } finally { image.destroy(); }
  }

  private image(input: Extract<DecorationRenderInput, { type: 'image' }>): RenderedPageDecoration {
    dimensions(input.maxWidth, input.maxHeight);
    const embedded = this.embedImage(input.data);
    const scale = Math.min(input.maxWidth / embedded.width, input.maxHeight / embedded.height);
    const width = embedded.width * scale, height = embedded.height * scale;
    const imageResourceName = 'DecorationImage';
    const form = this.document.addStream(`q\n${width} 0 0 ${height} 0 0 cm\n/${imageResourceName} Do\nQ\n`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: { XObject: { [imageResourceName]: embedded.reference } },
    });
    return { form, width, height, imageResourceName };
  }
}
