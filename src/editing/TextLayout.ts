import type { Device, Font, StrokeState } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import type { TextRect } from './types';

export const TEXT_LAYOUT_FONTS = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'] as const;
export type StandardTextFont = typeof TEXT_LAYOUT_FONTS[number];
export const TEXT_LAYOUT_LIMITS = { characters: 20_000, fontSize: 500, dimension: 14_400, lineHeight: 5 };
export interface TextLayoutInput {
  text: string;
  rect: TextRect;
  fontName: string;
  fontSize: number;
  fontColor: string;
  alignment: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  /** Compatibility for existing plain-text edits; explicit layout uses ink bounds. */
  legacyBaseline?: number;
}
export interface TextLayoutGlyph {
  character: string; fontName: string; glyphId: number;
  x: number; baseline: number; advance: number;
}
export interface TextLayoutLine {
  text: string; x: number; baseline: number; width: number; paragraphEnd: boolean; glyphs: TextLayoutGlyph[];
}
export interface TextLayoutResult {
  fits: boolean; requiredHeight: number; overflow?: string; suggestedFontSize?: number;
  /** Height for the explicit, ink-bounded layout created by a Fit height action. */
  suggestedHeight?: number;
  lines: TextLayoutLine[]; fontSize: number; lineAdvance: number; inkBounds: TextRect | null; warnings: string[];
}
export interface TextLayoutControl { signal?: AbortSignal }
type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface MeasuredGlyph { character: string; fontName: string; glyphId: number; advance: number; left: number; right: number; ascent: number; descent: number; ink: boolean }
interface WrappedLine { glyphs: MeasuredGlyph[]; paragraphEnd: boolean }
const check = (control: TextLayoutControl) => { if (control.signal?.aborted) throw new DOMException('Text layout cancelled.', 'AbortError'); };
const cjk = (value: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
const noLineStart = new Set(Array.from('，。、；：？！）》】」』〕〉〗〙〛,.!?;:)]}'));
const noLineEnd = new Set(Array.from('（《【「『〔〈〖〘〚([{'));
const space = (value: string) => /^\s$/u.test(value);

/** Map an extracted font name to the standard family that can be embedded locally. */
export function standardTextFont(name: string): StandardTextFont {
  if ((TEXT_LAYOUT_FONTS as readonly string[]).includes(name)) return name as StandardTextFont;
  const bold = /bold|black|heavy/i.test(name), italic = /italic|oblique/i.test(name);
  if (/courier|mono|consolas/i.test(name)) return `Courier${bold ? '-Bold' : ''}${italic ? bold ? 'Oblique' : '-Oblique' : ''}` as StandardTextFont;
  if (/times|serif|georgia/i.test(name) && !/sans/i.test(name)) return bold ? italic ? 'Times-BoldItalic' : 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  return `Helvetica${bold ? '-Bold' : ''}${italic ? bold ? 'Oblique' : '-Oblique' : ''}` as StandardTextFont;
}
function normalize(input: TextLayoutInput) {
  if (typeof input.text !== 'string') throw new Error('Replacement text must be a string.');
  const text = input.text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\t/g, '    ');
  if (Array.from(text).length > TEXT_LAYOUT_LIMITS.characters) throw new Error('A replacement is limited to 20,000 characters. Split it into smaller text regions.');
  const complex = [[0x0590, 0x109f], [0x1100, 0x11ff], [0x1780, 0x18af], [0x200c, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xa980, 0xa9df], [0xaa60, 0xaa7f], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
  if (/\p{M}/u.test(text) || Array.from(text).some(character => complex.some(([a, b]) => character.codePointAt(0)! >= a && character.codePointAt(0)! <= b))) {
    throw new Error('This text requires complex-script or bidirectional layout, which is not supported yet. No characters were omitted or reordered.');
  }
  if (Array.from(text).some(character => (character.codePointAt(0)! < 32 && character !== '\n') || character.codePointAt(0) === 127)) throw new Error('Replacement text contains an unsupported control character.');
  if (!(TEXT_LAYOUT_FONTS as readonly string[]).includes(input.fontName)) throw new Error('Choose one of the supported standard text fonts.');
  if (!/^#[0-9a-f]{6}$/i.test(input.fontColor)) throw new Error('Text colors must use six-digit hexadecimal notation, such as #336699.');
  if (!['left', 'center', 'right', 'justify'].includes(input.alignment)) throw new Error('Choose a supported paragraph alignment.');
  if (!Number.isFinite(input.fontSize) || input.fontSize < 1 || input.fontSize > TEXT_LAYOUT_LIMITS.fontSize) throw new Error('Font size must be between 1 and 500 points.');
  if (!Number.isFinite(input.lineHeight) || input.lineHeight < 1 || input.lineHeight > TEXT_LAYOUT_LIMITS.lineHeight) throw new Error('Line spacing must be between 1 and 5 times the font size.');
  const rect = input.rect;
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0
    || rect.width > TEXT_LAYOUT_LIMITS.dimension || rect.height > TEXT_LAYOUT_LIMITS.dimension || Math.abs(rect.x) > 1_000_000 || Math.abs(rect.y) > 1_000_000) throw new Error('Text layout bounds must be finite, positive, and at most 14,400 points wide and high.');
  return text;
}
function lineMetrics(glyphs: MeasuredGlyph[]) {
  let advance = 0, left = 0, right = 0;
  for (const glyph of glyphs) { left = Math.min(left, advance + glyph.left); right = Math.max(right, advance + glyph.right); advance += glyph.advance; }
  return { left, right: Math.max(right, advance), width: Math.max(right, advance) - left };
}
function canBreak(left: MeasuredGlyph, right: MeasuredGlyph) {
  if (noLineEnd.has(left.character) || noLineStart.has(right.character)) return false;
  return space(left.character) || cjk(left.character) || cjk(right.character);
}
function wrap(glyphs: MeasuredGlyph[], width: number): WrappedLine[] {
  if (!glyphs.length) return [{ glyphs: [], paragraphEnd: true }];
  const lines: WrappedLine[] = [];
  let start = 0;
  while (start < glyphs.length) {
    let end = start, lastBreak = -1, advance = 0, left = 0, right = 0;
    while (end < glyphs.length) {
      const glyph = glyphs[end], nextLeft = Math.min(left, advance + glyph.left), nextRight = Math.max(right, advance + glyph.right, advance + glyph.advance);
      if (end > start && nextRight - nextLeft > width + 0.0001) break;
      advance += glyph.advance; left = nextLeft; right = nextRight; end++;
      if (end < glyphs.length && canBreak(glyphs[end - 1], glyphs[end])) lastBreak = end;
      if (right - left > width + 0.0001) break; // Keep an oversized glyph, then report overflow; never truncate it.
    }
    if (end < glyphs.length && lastBreak > start) end = lastBreak;
    // Avoid placing closing punctuation at a line start or opening punctuation at
    // its end when a preceding glyph can move with it. Very narrow boxes overflow.
    if (end < glyphs.length && (noLineStart.has(glyphs[end].character) || noLineEnd.has(glyphs[end - 1].character))) {
      let boundary = end;
      while (boundary > start && (noLineStart.has(glyphs[boundary].character) || noLineEnd.has(glyphs[boundary - 1].character))) boundary--;
      if (boundary > start) end = boundary;
      else while (end < glyphs.length && (noLineStart.has(glyphs[end].character) || noLineEnd.has(glyphs[end - 1].character))) end++;
    }
    const row = glyphs.slice(start, end); let next = end;
    if (next < glyphs.length) {
      while (row.length && space(row[row.length - 1].character)) row.pop();
      while (next < glyphs.length && space(glyphs[next].character)) next++;
    }
    lines.push({ glyphs: row, paragraphEnd: next === glyphs.length }); start = next;
  }
  return lines;
}

/** The same measured glyph positions drive the preview and the PDF writer. */
export class TextLayoutSession {
  private readonly fonts = new Map<string, Font>();
  private readonly measured = new Map<string, MeasuredGlyph>();
  private stroke?: StrokeState;
  private readonly engine: Engine;
  constructor(engine: Engine) { this.engine = engine; }
  private font(name: string) { if (!this.fonts.has(name)) this.fonts.set(name, new this.engine.Font(name)); return this.fonts.get(name)!; }
  private glyph(character: string, primary: string): MeasuredGlyph {
    const cache = `${primary}:${character}`, cached = this.measured.get(cache); if (cached) return cached;
    let fontName = primary, font = this.font(primary), glyphId = font.encodeCharacter(character);
    if (!glyphId) { fontName = 'zh-Hans'; font = this.font(fontName); glyphId = font.encodeCharacter(character); }
    if (!glyphId) throw new Error(`The replacement font does not support ${JSON.stringify(character)} (U+${character.codePointAt(0)!.toString(16).toUpperCase()}).`);
    const text = new this.engine.Text();
    try {
      text.showGlyph(font, [100, 0, 0, -100, 0, 0], glyphId, character.codePointAt(0)!);
      this.stroke ??= new this.engine.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 1 });
      const bounds = text.getBounds(this.stroke, this.engine.Matrix.identity), ink = !space(character) && bounds.every(Number.isFinite) && bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
      const value = { character, fontName, glyphId, advance: font.advanceGlyph(glyphId), left: ink ? bounds[0] / 100 : 0,
        right: ink ? bounds[2] / 100 : 0, ascent: ink ? Math.max(0, -bounds[1] / 100) : 0, descent: ink ? Math.max(0, bounds[3] / 100) : 0, ink };
      this.measured.set(cache, value); return value;
    } finally { text.destroy(); }
  }
  layout(input: TextLayoutInput, control: TextLayoutControl = {}): TextLayoutResult {
    check(control); const text = normalize(input);
    if (text === '') return { fits: true, requiredHeight: 0, suggestedHeight: 0, lines: [], fontSize: input.fontSize, lineAdvance: input.fontSize * input.lineHeight, inkBounds: null, warnings: [] };
    const legacy = input.legacyBaseline !== undefined;
    if (legacy && !Number.isFinite(input.legacyBaseline)) throw new Error('The original text baseline is invalid.');
    const paragraphs = text.split('\n').map(paragraph => Array.from(paragraph, character => this.glyph(character, input.fontName)));
    let ascent = 0.8, descent = 0.2;
    for (const paragraph of paragraphs) for (const glyph of paragraph) { ascent = Math.max(ascent, glyph.ascent); descent = Math.max(descent, glyph.descent); }
    const assemble = (size: number, useLegacy = legacy): TextLayoutResult => {
      check(control);
      const wrapped = paragraphs.flatMap(paragraph => wrap(useLegacy ? paragraph.map(glyph => ({ ...glyph, left: 0, right: glyph.advance })) : paragraph, input.rect.width / size));
      const lineAdvance = (useLegacy ? input.lineHeight : Math.max(input.lineHeight, ascent + descent)) * size;
      const requiredHeight = (useLegacy ? 1 : ascent + descent) * size + Math.max(0, wrapped.length - 1) * lineAdvance;
      let widest = 0, ink: [number, number, number, number] | undefined;
      const lines = wrapped.map((row, index): TextLayoutLine => {
        const metric = lineMetrics(row.glyphs), gaps = new Set<number>();
        if (input.alignment === 'justify' && !row.paragraphEnd) {
          row.glyphs.forEach((glyph, position) => { if (position > 0 && position < row.glyphs.length - 1 && space(glyph.character)) gaps.add(position); });
          if (!gaps.size) row.glyphs.forEach((glyph, position) => { const next = row.glyphs[position + 1]; if (next && (cjk(glyph.character) || cjk(next.character)) && canBreak(glyph, next)) gaps.add(position); });
        }
        const extra = gaps.size ? Math.max(0, input.rect.width - metric.width * size) / gaps.size : 0;
        const width = metric.width * size + extra * gaps.size; widest = Math.max(widest, width);
        const offset = input.alignment === 'right' ? input.rect.width - width : input.alignment === 'center' ? (input.rect.width - width) / 2 : 0;
        let x = input.rect.x + offset - metric.left * size;
        const baseline = (useLegacy ? input.legacyBaseline! : input.rect.y + ascent * size) + index * lineAdvance, start = x;
        const glyphs = row.glyphs.map((glyph, position) => {
          const advance = glyph.advance * size + (gaps.has(position) ? extra : 0);
          const placed = { character: glyph.character, fontName: glyph.fontName, glyphId: glyph.glyphId, x, baseline, advance };
          if (glyph.ink) {
            const bounds: [number, number, number, number] = [x + glyph.left * size, baseline - glyph.ascent * size, x + glyph.right * size, baseline + glyph.descent * size];
            ink = ink ? [Math.min(ink[0], bounds[0]), Math.min(ink[1], bounds[1]), Math.max(ink[2], bounds[2]), Math.max(ink[3], bounds[3])] : bounds;
          }
          x += advance; return placed;
        });
        return { text: row.glyphs.map(glyph => glyph.character).join(''), x: start, baseline, width, paragraphEnd: row.paragraphEnd, glyphs };
      });
      const fits = requiredHeight <= input.rect.height + 0.001 && widest <= input.rect.width + 0.001;
      const overflow = fits ? undefined : widest > input.rect.width + 0.001
        ? `A character or punctuation group is wider than the text region (${Math.ceil(widest)} points). Enlarge the region or reduce the font size; no text was truncated.`
        : `Replacement text needs ${Math.ceil(requiredHeight)} points of height, but the region has ${Math.floor(input.rect.height)}. Enlarge the region or reduce the font size; no text was truncated.`;
      return { fits, requiredHeight: Math.ceil(requiredHeight * 1000) / 1000, overflow, lines, fontSize: size, lineAdvance,
        inkBounds: ink ? { x: ink[0], y: ink[1], width: ink[2] - ink[0], height: ink[3] - ink[1] } : null, warnings: [] };
    };
    const result = assemble(input.fontSize);
    // Accepting either suggestion writes an explicit layout operation. Measure
    // that resulting mode, while keeping the legacy preview/baseline untouched.
    const explicit = legacy ? assemble(input.fontSize, false) : result;
    result.suggestedHeight = explicit.requiredHeight;
    if (!explicit.fits && input.fontSize > 1 && assemble(1, false).fits) {
      let low = 1, high = input.fontSize;
      for (let step = 0; step < 16; step++) { const middle = (low + high) / 2; if (assemble(middle, false).fits) low = middle; else high = middle; }
      result.suggestedFontSize = Math.max(1, Math.floor(low * 10) / 10);
    }
    if (paragraphs.some(paragraph => paragraph.some(glyph => glyph.fontName === 'zh-Hans'))) result.warnings.push('CJK and other missing Latin glyphs use the locally embedded regular fallback font.');
    check(control); return result;
  }
  draw(device: Device, input: TextLayoutInput, layout: TextLayoutResult) {
    const color: [number, number, number] = [1, 3, 5].map(index => parseInt(input.fontColor.slice(index, index + 2), 16) / 255) as [number, number, number];
    for (const line of layout.lines) {
      if (!line.glyphs.length) continue;
      const text = new this.engine.Text();
      try {
        for (const glyph of line.glyphs) text.showGlyph(this.font(glyph.fontName), [layout.fontSize, 0, 0, -layout.fontSize, glyph.x, glyph.baseline], glyph.glyphId, glyph.character.codePointAt(0)!);
        device.fillText(text, this.engine.Matrix.identity, this.engine.ColorSpace.DeviceRGB, color, 1);
      } finally { text.destroy(); }
    }
  }
  destroy() { for (const font of this.fonts.values()) font.destroy(); this.fonts.clear(); this.measured.clear(); this.stroke?.destroy(); this.stroke = undefined; }
}

export async function layoutText(input: TextLayoutInput, control: TextLayoutControl = {}): Promise<TextLayoutResult> {
  check(control); const engine = await loadMuPDF(); check(control); const session = new TextLayoutSession(engine);
  try { return session.layout(input, control); } finally { session.destroy(); }
}
