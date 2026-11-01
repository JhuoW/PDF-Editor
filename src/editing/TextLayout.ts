import { cffGlyphCIDs, cffTableData } from '../fonts/cffCharset';
import type { Device, Font, PDFDocument, PDFObject, PDFPage, StrokeState } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { isImportedFont, validateFontData, type FontAsset } from '../fonts/fontAsset';
import { SourceColorCatalog } from './SourceColors';
import { isType3Font, NativeSourceFontCatalog, type NativeSourceFont } from './NativeSourceFonts';
import { TYPE3_TEXT_EDIT_REASON, type TextRect } from './types';

export const TEXT_LAYOUT_FONTS = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'] as const;
export type StandardTextFont = typeof TEXT_LAYOUT_FONTS[number];
export const TEXT_LAYOUT_LIMITS = { characters: 20_000, fontSize: 500, dimension: 14_400, lineHeight: 5 };
/** How a source glyph was painted, beyond its opaque fill color. */
export interface TextGlyphPaint {
  alpha?: number; noFill?: boolean;
  /** Stroke width is relative to the font size, like the other glyph metrics. */
  strokeColor?: string; strokeWidth?: number; strokeAlpha?: number;
}
export interface TextGlyphStyle {
  paint?: TextGlyphPaint;
  /** A row-end hyphen that only exists because the word broke there. */
  softHyphen?: boolean;
  fontKey: string; fontName: string; fontSize: number; horizontalScale: number; tracking: number; fontColor: string;
  wordSpacing?: number;
  /** Measured space inserted by extraction between separately positioned words. */
  spaceAdvance?: number;
  /** Unjustified spacing, inferred from the source paragraph's short final row. */
  reflowSpaceAdvance?: number;
  /** Smallest word space actually used by the source paragraph's justification. */
  minimumSpaceAdvance?: number;
  /** Source glyph's baseline displacement, relative to its own font size. */
  baselineOffset?: number;
}
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
  /** Session-owned source font; absent when an explicit replacement font is chosen. */
  sourceFontKey?: string;
  /** Physical source rows retain their PDF word spacing when unchanged. */
  sourceRows?: Array<{ text: string; width: number; x?: number; baseline?: number; fontSize?: number; inkTop?: number; inkBottom?: number }>;
  firstLineIndent?: number;
  reflow?: boolean;
  /** Per-character source styles, already mapped through the current replacement. */
  sourceStyles?: TextGlyphStyle[];
  sourceFontSize?: number;
  /** Original logical row footprint, including mixed-size source items. */
  sourceRowHeight?: number;
}
export interface TextLayoutGlyph {
  character: string; fontName: string; glyphId: number;
  x: number; baseline: number; advance: number;
  /** Painted glyph bounds, excluding advance spaces and interline whitespace. */
  inkBounds?: TextRect;
  fontSize?: number; horizontalScale?: number; fontColor?: string; paint?: TextGlyphPaint;
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
interface MeasuredGlyph { character: string; fontName: string; glyphId: number; advance: number; left: number; right: number; inkLeft?: number; inkRight?: number; ascent: number; descent: number; ink: boolean; sizeRatio?: number; horizontalScale?: number; fontColor?: string; paint?: TextGlyphPaint; softHyphen?: boolean; naturalSpaceAdvance?: number; sourceSpaceAdvance?: number; baselineOffset?: number }
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
export const normalizeReplacementText = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\t/g, '    ');
function normalize(input: TextLayoutInput) {
  if (typeof input.text !== 'string') throw new Error('Replacement text must be a string.');
  const text = normalizeReplacementText(input.text);
  if (Array.from(text).length > TEXT_LAYOUT_LIMITS.characters) throw new Error('A replacement is limited to 20,000 characters. Split it into smaller text regions.');
  const complex = [[0x0590, 0x109f], [0x1100, 0x11ff], [0x1780, 0x18af], [0x200c, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xa980, 0xa9df], [0xaa60, 0xaa7f], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
  if (/\p{M}/u.test(text) || Array.from(text).some(character => complex.some(([a, b]) => character.codePointAt(0)! >= a && character.codePointAt(0)! <= b))) {
    throw new Error('This text requires complex-script or bidirectional layout, which is not supported yet. No characters were omitted or reordered.');
  }
  if (!(TEXT_LAYOUT_FONTS as readonly string[]).includes(input.fontName) && input.fontName !== 'zh-Hans' && !isImportedFont(input.fontName)) throw new Error('Choose one of the supported standard text fonts.');
  if (!/^#[0-9a-f]{6}$/i.test(input.fontColor)) throw new Error('Text colors must use six-digit hexadecimal notation, such as #336699.');
  if (!['left', 'center', 'right', 'justify'].includes(input.alignment)) throw new Error('Choose a supported paragraph alignment.');
  if (!Number.isFinite(input.fontSize) || input.fontSize < 1 || input.fontSize > TEXT_LAYOUT_LIMITS.fontSize) throw new Error('Font size must be between 1 and 500 points.');
  const minimumLeading = input.legacyBaseline !== undefined ? .25 : 1;
  if (!Number.isFinite(input.lineHeight) || input.lineHeight < minimumLeading || input.lineHeight > TEXT_LAYOUT_LIMITS.lineHeight) throw new Error(`Line spacing must be between ${minimumLeading} and 5 times the font size.`);
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
  // A word that exactly fills the row fits even when the following space does
  // not. Breaking only *after* that space needlessly moved the whole word down.
  return space(left.character) || space(right.character) || left.character === '-' || left.character === '\u2010'
    || cjk(left.character) || cjk(right.character);
}
function wrap(glyphs: MeasuredGlyph[], width: number, firstWidth = width, tolerance = .0001): WrappedLine[] {
  if (!glyphs.length) return [{ glyphs: [], paragraphEnd: true }];
  const lines: WrappedLine[] = [];
  let start = 0;
  while (start < glyphs.length) {
    const limit = lines.length ? width : firstWidth;
    let end = start, lastBreak = -1, advance = 0, left = 0, right = 0;
    while (end < glyphs.length) {
      const glyph = glyphs[end], nextLeft = Math.min(left, advance + glyph.left), nextRight = Math.max(right, advance + glyph.right, advance + glyph.advance);
      if (end > start && nextRight - nextLeft > limit + tolerance) break;
      advance += glyph.advance; left = nextLeft; right = nextRight; end++;
      if (end < glyphs.length && canBreak(glyphs[end - 1], glyphs[end])) lastBreak = end;
      if (right - left > limit + tolerance) break; // Keep an oversized glyph, then report overflow; never truncate it.
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

export const hexColor = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number];
const glyphPaintKey = (glyph: TextLayoutGlyph, input: TextLayoutInput, layout: TextLayoutResult) =>
  `${glyph.fontColor ?? input.fontColor}|${glyph.paint ? `${glyph.fontSize ?? layout.fontSize}|${JSON.stringify(glyph.paint)}` : ''}`;

/** The same measured glyph positions drive the preview and the PDF writer. */
export class TextLayoutSession {
  private readonly fonts = new Map<string, Font>();
  private readonly fontCFF = new Map<string, Uint8Array>();
  private readonly fontCIDs = new Map<string, number[]>();
  private readonly fontLabels = new Map<string, string>();
  private readonly measured = new Map<string, MeasuredGlyph>();
  private readonly fallbacks = new Map<string, string>();
  private readonly sourceGlyphs = new Map<string, Map<string, number>>();
  private readonly sourceClusters = new Map<string, string[][]>();
  private readonly nativeFonts = new Map<string, NativeSourceFont>();
  private catalog?: NativeSourceFontCatalog;
  /** Print colors of the source glyphs, reapplied to whatever writes the replacement. */
  readonly colors: SourceColorCatalog;
  private stroke?: StrokeState;
  private readonly engine: Engine;
  constructor(engine: Engine) { this.engine = engine; this.colors = new SourceColorCatalog(engine); }
  useImportedFont(asset: FontAsset) {
    if (!isImportedFont(asset.id)) throw new Error('The selected font data is missing. Import and select the font again.');
    if (this.fonts.has(asset.id)) return;
    validateFontData(asset.data);
    // Separate PDF resource names for different programs with the same family name.
    const font = new this.engine.Font(`PDFEditor-${asset.id.slice(7, 23)}-${asset.name}`, asset.data);
    this.fonts.set(asset.id, font);
    const cids = cffGlyphCIDs(asset.data);
    if (cids) { this.fontCIDs.set(font.getName(), cids); this.fontCFF.set(font.getName(), cffTableData(asset.data)!); }
    this.fontLabels.set(asset.id, asset.name);
  }
  usedFontNames(layout: TextLayoutResult): string[] {
    return [...new Set(layout.lines.flatMap(line => line.glyphs).map(glyph => this.fontLabels.get(glyph.fontName) ?? this.font(glyph.fontName).getName()))];
  }
  useSourceFont(key: string, font: Font, fallback: string, page?: PDFPage) {
    if (this.fonts.has(key)) { font.destroy(); return; }
    this.fonts.set(key, font);
    this.fallbacks.set(key, fallback);
    const native = page && (this.catalog ??= new NativeSourceFontCatalog(this.engine)).find(page, font);
    if (native) this.nativeFonts.set(key, native);
    else if (isType3Font(font)) throw new Error(TYPE3_TEXT_EDIT_REASON);
  }
  /** Set when this glyph must be written through the page's own font dictionary. */
  nativeFont(name: string) { return this.nativeFonts.get(name); }
  useSourceGlyph(key: string, character: string, glyph: number) {
    const map = this.sourceGlyphs.get(key) ?? new Map<string, number>();
    map.set(character, glyph); this.sourceGlyphs.set(key, map);
    const characters = Array.from(character);
    if (characters.length > 1) {
      const clusters = this.sourceClusters.get(key) ?? [];
      if (!clusters.some(cluster => cluster.join('') === character)) clusters.push(characters);
      clusters.sort((a, b) => b.length - a.length); this.sourceClusters.set(key, clusters);
    }
  }
  private font(name: string) { if (!this.fonts.has(name)) this.fonts.set(name, new this.engine.Font(name)); return this.fonts.get(name)!; }
  private glyph(character: string, primary: string): MeasuredGlyph {
    const cache = `${primary}:${character}`, cached = this.measured.get(cache); if (cached) return cached;
    const unicode = character.codePointAt(0)!;
    // A PDF without usable Unicode data can extract its glyphs as control characters.
    // Those keep their source glyph, so such a row can still be moved or partly edited.
    if ((unicode < 32 || unicode === 127) && this.sourceGlyphs.get(primary)?.get(character) === undefined) throw new Error('Replacement text contains an unsupported control character.');
    // A simple font can only paint glyphs its own encoding reaches. A Type 3 font has
    // no character map, so only the letters already seen on the page are known to it.
    const native = this.nativeFonts.get(primary);
    let fontName = primary, font = this.font(primary), glyphId = this.sourceGlyphs.get(primary)?.get(character) ?? (native?.type3 ? -1 : font.encodeCharacter(unicode));
    // Type 3 code zero can paint a real glyph, but an unseen letter must never
    // claim that glyph. Use a distinct missing sentinel throughout fallback.
    if ((glyphId === 0 && !native?.type3) || (native && !native.codes.has(glyphId))) glyphId = -1;
    if (glyphId < 0 && this.fallbacks.has(primary)) { fontName = this.fallbacks.get(primary)!; font = this.font(fontName); glyphId = font.encodeCharacter(unicode) || -1; }
    if (glyphId < 0) { fontName = 'zh-Hans'; font = this.font(fontName); glyphId = font.encodeCharacter(unicode) || -1; }
    if (glyphId < 0) throw new Error(`The replacement font does not support ${JSON.stringify(character)} (U+${character.codePointAt(0)!.toString(16).toUpperCase()}).`);
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
    if (isImportedFont(input.fontName) && !this.fonts.has(input.fontName)) throw new Error('The selected font data is missing. Import and select the font again.');
    if (text === '') return { fits: true, requiredHeight: 0, suggestedHeight: 0, lines: [], fontSize: input.fontSize, lineAdvance: input.fontSize * input.lineHeight, inkBounds: null, warnings: [] };
    const legacy = input.legacyBaseline !== undefined;
    if (legacy && !Number.isFinite(input.legacyBaseline)) throw new Error('The original text baseline is invalid.');
    const primary = input.sourceFontKey && this.fonts.has(input.sourceFontKey) ? input.sourceFontKey : input.fontName;
    // Reuse the source's tight character spacing as well as its font. Without
    // this, rows that fit in the PDF can wrap again after joining soft breaks.
    const advanceScale = input.reflow && !input.sourceStyles ? Math.min(1, ...(input.sourceRows ?? []).map(row => {
      const width = Array.from(row.text, character => this.glyph(character, primary).advance).reduce((sum, advance) => sum + advance, 0) * input.fontSize;
      return width > 0 ? Math.max(.8, row.width / width) : 1;
    })) : 1;
    let sourceIndex = 0;
    const paragraphs = text.split('\n').map((paragraph, paragraphIndex) => {
      const characters = Array.from(paragraph), glyphs: MeasuredGlyph[] = [];
      for (let index = 0; index < characters.length; index++) {
        const style = input.sourceStyles?.[sourceIndex], key = style?.fontKey ?? primary;
        const cluster = this.sourceClusters.get(key)?.find(cluster => cluster.every((character, offset) => characters[index + offset] === character
          && (!input.sourceStyles || input.sourceStyles[sourceIndex + offset]?.fontKey === key)));
        const length = cluster?.length ?? 1, character = cluster?.join('') ?? characters[index];
        sourceIndex += length; index += length - 1;
        const glyph = this.glyph(character, style?.fontKey ?? primary);
        if (!style) { glyphs.push(advanceScale === 1 ? glyph : { ...glyph, advance: glyph.advance * advanceScale }); continue; }
        const sizeRatio = style.fontSize / (input.sourceFontSize ?? input.fontSize), horizontalScale = style.horizontalScale;
        const justifiedSpace = space(character) && input.reflow && input.alignment === 'justify';
        const naturalSpace = style.reflowSpaceAdvance ?? glyph.advance * horizontalScale + style.tracking;
        glyphs.push({ ...glyph, sizeRatio, horizontalScale, fontColor: style.fontColor, ...(style.paint ? { paint: style.paint } : {}), ...(style.softHyphen ? { softHyphen: true } : {}),
          baselineOffset: (style.baselineOffset ?? 0) * sizeRatio,
          naturalSpaceAdvance: justifiedSpace ? naturalSpace * sizeRatio : undefined,
          sourceSpaceAdvance: space(character) && style.spaceAdvance !== undefined ? style.spaceAdvance * sizeRatio : undefined,
          advance: (justifiedSpace ? Math.min(naturalSpace, style.minimumSpaceAdvance ?? naturalSpace)
            : space(character) && style.spaceAdvance !== undefined ? style.spaceAdvance
            : glyph.advance * horizontalScale + style.tracking + (space(character) ? style.wordSpacing ?? 0 : 0)) * sizeRatio,
          left: glyph.left * horizontalScale * sizeRatio, right: glyph.right * horizontalScale * sizeRatio,
          ascent: glyph.ascent * sizeRatio, descent: glyph.descent * sizeRatio });
      }
      sourceIndex++;
      // Identical strings can occupy different physical widths (for example
      // repeated table labels or justified rows). Preserve the corresponding
      // row's spacing, not the first occurrence of that text in the paragraph.
      const sourceRow = input.sourceRows?.[paragraphIndex];
      const source = sourceRow?.text === paragraph ? sourceRow
        : input.reflow ? input.sourceRows?.find(row => row.text === paragraph) : undefined;
      const spaces = glyphs.filter(glyph => space(glyph.character));
      if (!source || !spaces.length) return glyphs;
      // PDF word spacing can shrink as well as stretch a line. Embedded font
      // advances alone otherwise wrap unchanged, justified source rows again.
      const delta = (source.width / input.fontSize - glyphs.reduce((sum, glyph) => sum + glyph.advance, 0)) / spaces.length;
      if (spaces.some(glyph => glyph.advance + delta < .01)) return glyphs;
      return glyphs.map(glyph => space(glyph.character) ? { ...glyph, advance: glyph.advance + delta } : glyph);
    });
    let ascent = 0.8, descent = 0.2, emHeight = 1;
    for (const paragraph of paragraphs) for (const glyph of paragraph) { ascent = Math.max(ascent, glyph.ascent - (glyph.baselineOffset ?? 0)); descent = Math.max(descent, glyph.descent + (glyph.baselineOffset ?? 0)); emHeight = Math.max(emHeight, glyph.sizeRatio ?? 1); }
    const assemble = (size: number, useLegacy = legacy): TextLayoutResult => {
      check(control);
      const indent = Math.max(0, input.firstLineIndent ?? 0);
      // PDF.js extraction and MuPDF font advances can differ by hundredths of
      // a point. A subpixel rounding difference must not move an entire word.
      // Keep this tolerance in physical points, independent of font size.
      const widthTolerance = useLegacy ? .01 : .001;
      const wrapped = paragraphs.flatMap(paragraph => wrap(useLegacy ? paragraph.map(glyph => ({ ...glyph, inkLeft: glyph.left, inkRight: glyph.right, left: 0, right: glyph.advance })) : paragraph, input.rect.width / size, Math.max(.001, input.rect.width - indent) / size, widthTolerance / size));
      // A word no longer split by this break needs no hyphen; one still split keeps it.
      if (input.reflow) for (const row of wrapped) row.glyphs = row.glyphs.filter((glyph, position) => !glyph.softHyphen || position === row.glyphs.length - 1);
      const lineAdvance = (useLegacy ? input.lineHeight : Math.max(input.lineHeight, ascent + descent)) * size;
      const legacyHeight = input.sourceRowHeight !== undefined ? input.sourceRowHeight / (input.sourceFontSize ?? input.fontSize) : emHeight;
      // The first physical row can be smaller than a later emphasized word. Its
      // footprint starts at the fixed source baseline, even when a smaller font
      // is selected; shrinking must not pull the following paragraph across it.
      const firstFootprint = useLegacy ? Math.max(input.legacyBaseline! - input.rect.y, legacyHeight * size) : (ascent + descent) * size;
      let widest = 0, ink: [number, number, number, number] | undefined;
      let baselineShift = 0;
      let previousRow: { glyphs: TextLayoutGlyph[]; grew: boolean } | undefined;
      const lines = wrapped.map((row, index): TextLayoutLine => {
        const inset = index === 0 || wrapped[index - 1].paragraphEnd ? indent : 0;
        const rowWidth = input.rect.width - inset;
        const original = input.sourceRows?.[index];
        // Editing one word must not disturb the rows it did not change: a row that
        // still wraps to its source wording keeps that row's position and spacing.
        const unchanged = original?.text === row.glyphs.map(glyph => glyph.character).join('') ? original : undefined;
        if (input.reflow && unchanged) row.glyphs = row.glyphs.map(glyph => glyph.sourceSpaceAdvance === undefined ? glyph : { ...glyph, advance: glyph.sourceSpaceAdvance, ...(useLegacy ? { right: glyph.sourceSpaceAdvance } : {}) });
        else if (row.paragraphEnd && row.glyphs.some(glyph => glyph.naturalSpaceAdvance !== undefined)) {
          // TeX justification permits word spaces to tighten as well as stretch.
          // Break using the source's measured minimum, then use normal spacing
          // on the final row whenever it fits. Font sizes never change.
          const natural = row.glyphs.map(glyph => glyph.naturalSpaceAdvance === undefined ? glyph : { ...glyph, advance: glyph.naturalSpaceAdvance, ...(useLegacy ? { right: glyph.naturalSpaceAdvance } : {}) });
          if (lineMetrics(natural).width * size <= rowWidth + .001) row.glyphs = natural;
        }
        const metric = lineMetrics(row.glyphs), gaps = new Set<number>();
        if (input.alignment === 'justify' && !row.paragraphEnd && !(input.reflow && unchanged)) {
          row.glyphs.forEach((glyph, position) => { if (position > 0 && position < row.glyphs.length - 1 && space(glyph.character)) gaps.add(position); });
          if (!gaps.size) row.glyphs.forEach((glyph, position) => { const next = row.glyphs[position + 1]; if (next && (cjk(glyph.character) || cjk(next.character)) && canBreak(glyph, next)) gaps.add(position); });
        }
        const extra = gaps.size ? Math.max(0, rowWidth - metric.width * size) / gaps.size : 0;
        const width = metric.width * size + extra * gaps.size; widest = Math.max(widest, width + inset);
        const offset = input.alignment === 'right' ? rowWidth - width : input.alignment === 'center' ? (rowWidth - width) / 2 : 0;
        const sourceRow = unchanged;
        let x = (sourceRow?.x ?? input.rect.x + inset + offset) - metric.left * size;
        let baseline = (sourceRow?.baseline ?? (useLegacy ? input.legacyBaseline! : input.rect.y + ascent * size) + index * lineAdvance) + baselineShift;
        const start = x;
        const glyphs = row.glyphs.map((glyph, position) => {
          const advance = glyph.advance * size + (gaps.has(position) ? extra : 0);
          const glyphBaseline = baseline + (glyph.baselineOffset ?? 0) * size;
          const placed: TextLayoutGlyph = { character: glyph.character, fontName: glyph.fontName, glyphId: glyph.glyphId, x, baseline: glyphBaseline, advance,
            fontSize: size * (glyph.sizeRatio ?? 1), horizontalScale: glyph.horizontalScale ?? 1, fontColor: glyph.fontColor ?? input.fontColor, ...(glyph.paint ? { paint: glyph.paint } : {}) };
          if (glyph.ink) {
            const bounds: [number, number, number, number] = [x + (glyph.inkLeft ?? glyph.left) * size, glyphBaseline - glyph.ascent * size, x + (glyph.inkRight ?? glyph.right) * size, glyphBaseline + glyph.descent * size];
            placed.inkBounds = { x: bounds[0], y: bounds[1], width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] };
          }
          x += advance; return placed;
        });
        const grew = (!!input.sourceRows && index >= input.sourceRows.length)
          || Math.max(0, ...glyphs.map(glyph => glyph.fontSize ?? size)) > (original?.fontSize ?? input.sourceFontSize ?? input.fontSize) + .01;
        const priorSource = input.sourceRows?.[index - 1];
        const sourceClearanceKnown = original?.inkTop !== undefined && priorSource?.inkBottom !== undefined
          && original.baseline !== undefined && priorSource.baseline !== undefined;
        if (useLegacy && input.reflow && previousRow && (sourceClearanceKnown || grew || previousRow.grew)) {
          // Larger inline text may wrap onto another row whose original leading
          // was designed for small body text. Increase only the clearance these
          // new glyphs need; two unchanged physical rows keep their source layout.
          const above = previousRow.glyphs.flatMap(glyph => glyph.inkBounds ? [glyph.inkBounds] : []);
          const current = glyphs.flatMap(glyph => glyph.inkBounds ? [glyph.inkBounds] : []);
          // Tight source rows may have overlapping ink boxes without touching
          // glyphs. Preserve that original allowance, but never introduce more.
          const allowance = sourceClearanceKnown ? Math.max(0, priorSource!.baseline! + priorSource!.inkBottom! - original!.baseline! - original!.inkTop!) : 0;
          let clearance = Math.max(0, Math.max(...above.map(bounds => bounds.y + bounds.height)) - Math.min(...current.map(bounds => bounds.y)) - allowance);
          if (clearance > .001) {
            clearance += .01; baseline += clearance; baselineShift += clearance;
            for (const glyph of glyphs) { glyph.baseline += clearance; if (glyph.inkBounds) glyph.inkBounds.y += clearance; }
          }
        }
        previousRow = { glyphs, grew };
        for (const glyph of glyphs) if (glyph.inkBounds) {
          const bounds = glyph.inkBounds, rect: [number, number, number, number] = [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height];
          ink = ink ? [Math.min(ink[0], rect[0]), Math.min(ink[1], rect[1]), Math.max(ink[2], rect[2]), Math.max(ink[3], rect[3])] : rect;
        }
        return { text: row.glyphs.map(glyph => glyph.character).join(''), x: start, baseline, width, paragraphEnd: row.paragraphEnd, glyphs };
      });
      const requiredHeight = firstFootprint + Math.max(0, (lines.at(-1)?.baseline ?? 0) - (lines[0]?.baseline ?? 0));
      const fits = requiredHeight <= input.rect.height + 0.001 && widest <= input.rect.width + widthTolerance;
      const overflow = fits ? undefined : widest > input.rect.width + widthTolerance
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
    if (primary !== 'zh-Hans' && paragraphs.some(paragraph => paragraph.some(glyph => glyph.fontName === 'zh-Hans'))) result.warnings.push('CJK and other missing Latin glyphs use the locally embedded regular fallback font.');
    if (paragraphs.some(paragraph => paragraph.some(glyph => !space(glyph.character) && !glyph.fontName.startsWith('source:') && glyph.fontName !== 'zh-Hans')) && input.sourceFontKey) result.warnings.push('Some added characters are unavailable in the original font and use a matching local font.');
    check(control); return result;
  }
  draw(device: Device, input: TextLayoutInput, layout: TextLayoutResult) {
    for (const line of layout.lines) {
      if (!line.glyphs.length) continue;
      // Preserve color and paint changes within a source line as well as font and weight.
      for (let start = 0; start < line.glyphs.length;) {
        const first = line.glyphs[start], hex = first.fontColor ?? input.fontColor, paint = first.paint, size = first.fontSize ?? layout.fontSize;
        const key = glyphPaintKey(first, input, layout);
        const text = new this.engine.Text();
        try {
          do {
            const glyph = line.glyphs[start++], size = glyph.fontSize ?? layout.fontSize;
            const characters = Array.from(glyph.character);
            characters.forEach((character, index) => text.showGlyph(this.font(glyph.fontName), [size * (glyph.horizontalScale ?? 1), 0, 0, -size, glyph.x, glyph.baseline], index === 0 ? glyph.glyphId : -1, character.codePointAt(0)!));
          } while (start < line.glyphs.length && glyphPaintKey(line.glyphs[start], input, layout) === key);
          if (!paint?.noFill) device.fillText(text, this.engine.Matrix.identity, this.engine.ColorSpace.DeviceRGB, hexColor(hex), paint?.alpha ?? 1);
          if (paint?.strokeWidth !== undefined) {
            const stroke = new this.engine.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: paint.strokeWidth * size, miterLimit: 10 });
            try { device.strokeText(text, stroke, this.engine.Matrix.identity, this.engine.ColorSpace.DeviceRGB, hexColor(paint.strokeColor ?? hex), paint.strokeAlpha ?? 1); }
            finally { stroke.destroy(); }
          }
        } finally { text.destroy(); }
      }
    }
  }
  /** MuPDF's PDF writer derives ToUnicode from the font program, which can use
   * legacy TeX codes instead of the source PDF's actual Unicode mappings. Keep
   * the painted glyphs and explicitly attach the text we measured and drew. */
  preserveUnicode(document: PDFDocument, resources: PDFObject, layouts: TextLayoutResult[]) {
    const mappings = new Map<string, Map<number, string>>(), programs = new Map<string, Font>();
    for (const layout of layouts) for (const line of layout.lines) for (const glyph of line.glyphs) {
      if (this.nativeFonts.has(glyph.fontName)) continue;
      let name = this.font(glyph.fontName).getName();
      // Base-14 substitutes are embedded under their actual program name.
      if ((TEXT_LAYOUT_FONTS as readonly string[]).includes(name)) name = this.font(name).getName();
      programs.set(name, this.font(glyph.fontName));
      const mapping = mappings.get(name) ?? new Map<number, string>();
      mapping.set(glyph.glyphId, glyph.character); mappings.set(name, mapping);
    }
    // The writer shares one font object between identical programs and keeps the first
    // name it saw, while a re-read Base-14 program reports its PostScript name. A name
    // that no written font carries belongs to the same-program font that replaced it.
    const written = new Set<string>();
    const fonts = resources.get('Font');
    try {
      fonts.forEach(font => {
        const base = font.get('BaseFont');
        try { written.add(base.asName()); } finally { base.destroy(); font.destroy(); }
      });
      for (const [name, renamed] of mappings) {
        if (written.has(name)) continue;
        const program = programs.get(name)!, gids = [...renamed.keys()];
        const target = [...written].find(base => {
          const other = programs.get(base) ?? ((TEXT_LAYOUT_FONTS as readonly string[]).includes(base) ? this.font(base) : undefined);
          return other && gids.every(gid => other.advanceGlyph(gid) === program.advanceGlyph(gid));
        });
        if (!target) continue;
        const mapping = mappings.get(target) ?? new Map<number, string>();
        for (const [gid, text] of renamed) mapping.set(gid, text);
        mappings.set(target, mapping);
        if (!programs.has(target)) programs.set(target, program);
      }
      fonts.forEach(font => {
        const base = font.get('BaseFont'), encoding = font.get('Encoding');
        try {
          const mapping = mappings.get(base.asName());
          if (!mapping || encoding.asName() !== 'Identity-H') return;
          const hex = (number: number) => number.toString(16).padStart(4, '0');
          const pairs = [...mapping].map(([gid, text]) => `<${hex(gid)}> <${text.split('').map(character => hex(character.charCodeAt(0))).join('')}>`);
          const chunks: string[] = [];
          for (let offset = 0; offset < pairs.length; offset += 100) {
            const rows = pairs.slice(offset, offset + 100); chunks.push(`${rows.length} beginbfchar\n${rows.join('\n')}\nendbfchar`);
          }
          const cmap = document.addStream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /PDFEditorUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`, {});
          try { font.put('ToUnicode', cmap); } finally { cmap.destroy(); }
          // Imported OpenType fonts use GIDs. Reused raw CFF PDF fonts already
          // expose CIDs to the drawing device and must retain their existing codes.
          const cids = this.fontCIDs.get(base.asName());
          const program = programs.get(base.asName());
          if (cids && program) {
            const entries = [...mapping.keys()].map(gid => {
              const cid = cids[gid];
              if (cid === undefined) throw new Error('The font file has damaged tables.');
              return { gid, cid, width: program.advanceGlyph(gid) * 1000 };
            });
            const ranges: string[] = [];
            for (let offset = 0; offset < entries.length; offset += 100) {
              const rows = entries.slice(offset, offset + 100);
              ranges.push(`${rows.length} begincidchar\n${rows.map(({ gid, cid }) => `<${hex(gid)}> ${cid}`).join('\n')}\nendcidchar`);
            }
            const encodingMap = document.addStream(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /PDFEditorCharset def\n/CMapType 1 def\n/WMode 0 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${ranges.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`, {});
            const descendants = font.get('DescendantFonts'), descendant = descendants.get(0);
            try {
              font.put('Encoding', encodingMap);
              descendant.put('W', entries.flatMap(({ cid, width }) => [cid, [width]]));
              // Embed CID-keyed CFF as CIDFontType0C. Some readers interpret an
              // OpenType wrapper as GID-addressed even with a CID encoding CMap.
              // The outlines are unchanged; both MuPDF and PDF.js now use CIDs.
              const cff = this.fontCFF.get(base.asName())!;
              const descriptor = descendant.get('FontDescriptor');
              const programStream = document.addStream(cff, { Subtype: 'CIDFontType0C' });
              try { descriptor.put('FontFile3', programStream); }
              finally { descriptor.destroy(); programStream.destroy(); }
            } finally { encodingMap.destroy(); descendant.destroy(); descendants.destroy(); }
          }
        } finally { base.destroy(); encoding.destroy(); font.destroy(); }
      });
    } finally { fonts.destroy(); }
  }
  destroy() { this.colors.destroy(); this.catalog?.destroy(); this.catalog = undefined; this.nativeFonts.clear(); for (const font of this.fonts.values()) font.destroy(); this.fonts.clear(); this.fontLabels.clear(); this.fontCIDs.clear(); this.fontCFF.clear(); this.measured.clear(); this.sourceGlyphs.clear(); this.sourceClusters.clear(); this.stroke?.destroy(); this.stroke = undefined; }
}

export async function layoutText(input: TextLayoutInput, control: TextLayoutControl = {}): Promise<TextLayoutResult> {
  check(control); const engine = await loadMuPDF(); check(control); const session = new TextLayoutSession(engine);
  try { return session.layout(input, control); } finally { session.destroy(); }
}
