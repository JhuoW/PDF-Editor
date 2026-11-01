import type { Color, ColorSpace, Font, Matrix, PDFPage, StrokeState, Text } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import { TYPE3_TEXT_EDIT_REASON, UNMAPPED_TEXT_EDIT_REASON, type TextBlock } from './types';
import { isSoftHyphenBreak, originalParagraphText } from './ParagraphText';
import { normalizeReplacementText, standardTextFont, type TextGlyphStyle, type TextLayoutSession } from './TextLayout';
import { sourceTextRow } from './TextPageContent';
import { isType3Font } from './NativeSourceFonts';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface SourceGlyph { character: string; glyphId: number; x: number; y: number; row: TextBlock['lines'][number]; style: TextGlyphStyle; naturalAdvance: number }
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const toHex = (rgb: number[]) => '#' + rgb.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(1, value)) * 255 + .0001).toString(16).padStart(2, '0')).join('');
/** Convert through the renderer, not by component count: a one-component Separation
 * at full ink is not white, and Lab or CMYK values are not RGB. */
function displayColor(engine: Engine, colorspace: ColorSpace, color: number[]) {
  if (colorspace.isGray() && color.length === 1) return toHex([color[0], color[0], color[0]]);
  if (colorspace.isRGB() && color.length === 3) return toHex(color);
  const pixmap = new engine.Pixmap(engine.ColorSpace.DeviceRGB, [0, 0, 1, 1], false);
  try {
    pixmap.clear(255);
    const device = new engine.DrawDevice(engine.Matrix.identity, pixmap), path = new engine.Path();
    try {
      path.moveTo(-1, -1); path.lineTo(2, -1); path.lineTo(2, 2); path.lineTo(-1, 2); path.closePath();
      device.fillPath(path, false, engine.Matrix.identity, colorspace, color as Color, 1);
      device.close();
    } finally { path.destroy(); device.destroy(); }
    const pixels = pixmap.getPixels();
    return toHex([pixels[0] / 255, pixels[1] / 255, pixels[2] / 255]);
  } finally { pixmap.destroy(); }
}

/** Actual glyph transforms, font identities and advances in the editor's physical page coordinates. */
export function readTextSourceMetrics(engine: Engine, page: PDFPage, block: TextBlock, session: TextLayoutSession) {
  const transform = page.getTransform(), inverse = engine.Matrix.invert(transform);
  const crop = engine.Rect.transform(page.getBounds(), inverse), unit = Math.hypot(transform[0], transform[1]);
  const viewport: Matrix = [unit, 0, 0, -unit, -crop[0] * unit, crop[3] * unit];
  const fonts = new Map<number, string>(), glyphs: SourceGlyph[] = [], fontNames = new Set<string>();
  const seen = new Map<string, SourceGlyph>();
  const register = (font: Font) => {
    let key = fonts.get(font.pointer);
    const name = standardTextFont(`${font.isMono() ? 'Courier' : font.isSerif() ? 'Times' : 'Helvetica'}${font.isBold() ? ' Bold' : ''}${font.isItalic() ? ' Italic' : ''}`);
    if (!key) {
      fontNames.add(font.getName());
      key = `source:${block.id}:${fonts.size}`; fonts.set(font.pointer, key);
      // Text.walk shares its Font wrapper across glyph callbacks. Keep our own
      // reference; destroying the borrowed wrapper invalidates earlier glyphs.
      session.useSourceFont(key, new engine.Font(font.pointer), name, page);
      const native = session.nativeFont(key);
      if (native?.type3 && !native.monochrome) throw new Error(TYPE3_TEXT_EDIT_REASON);
    }
    return { key, name };
  };
  const read = (text: Text, ctm: Matrix, colorspace: ColorSpace, color: number[], alpha: number, stroke?: StrokeState, type3Only = false) => {
    let previous: SourceGlyph | undefined;
    const hex = displayColor(engine, colorspace, color);
    const lineWidth = stroke ? stroke.getLineWidth() * Math.max(Math.hypot(ctm[0], ctm[1]), Math.hypot(ctm[2], ctm[3])) * unit : 0;
    try {
      text.walk({ showGlyph(font, trm, gid, unicode) {
          if (type3Only && !isType3Font(font)) return;
          if (unicode < 0) return;
          // A ToUnicode ligature maps one painted glyph to several characters.
          // Negative GIDs continue that mapping; they are not extra letters to draw.
          if (gid < 0) {
            if (previous && fonts.get(font.pointer) === previous.style.fontKey) previous.character += String.fromCodePoint(unicode);
            return;
          }
          previous = undefined;
          const matrix = engine.Matrix.concat(engine.Matrix.concat(engine.Matrix.concat(trm, ctm), inverse), viewport);
          const [x, y] = matrix.slice(4), size = Math.hypot(matrix[2], matrix[3]);
          const row = sourceTextRow(block, x, y, size);
          if (!row || !size) return;
          // Non-cacheable Type 3 glyphs expand into arbitrary page drawing calls.
          // Their original paint and artwork ownership cannot be recovered from
          // ignoreText, so do not silently replace them with another font.
          if (type3Only) {
            if (!/\s/u.test(String.fromCodePoint(unicode))) throw new Error(TYPE3_TEXT_EDIT_REASON);
            return;
          }
          const naturalAdvance = font.advanceGlyph(gid), horizontalScale = Math.hypot(matrix[0], matrix[1]) / size;
          const { key, name } = register(font);
          session.colors.remember(page, block.id, hex, colorspace, color);
          const character = String.fromCodePoint(unicode);
          const position = `${character}:${x.toFixed(2)}:${y.toFixed(2)}`;
          const painted = seen.get(position);
          if (painted) {
            // Render mode 2 (common for synthetic bold) paints one glyph twice.
            if (stroke) painted.style.paint = { ...painted.style.paint, strokeColor: hex, strokeWidth: lineWidth / size, ...(alpha < 1 ? { strokeAlpha: alpha } : {}) };
            return;
          }
          previous = { character, glyphId: gid, x, y, row, naturalAdvance,
            style: { fontKey: key, fontName: name, fontSize: size, horizontalScale, tracking: 0, fontColor: hex,
              ...(stroke ? { paint: { noFill: true, strokeColor: hex, strokeWidth: lineWidth / size, ...(alpha < 1 ? { strokeAlpha: alpha } : {}) } } : alpha < 1 ? { paint: { alpha } } : {}),
              ...(Math.abs(y - row.baseline) > .01 ? { baselineOffset: (y - row.baseline) / size } : {}) } };
          seen.set(position, previous);
          glyphs.push(previous);
      } });
    } finally { text.destroy(); }
  };
  const device = new engine.Device({
    fillText(text, matrix, colorspace, color, alpha) { try { read(text, matrix, colorspace, color, alpha); } finally { colorspace.destroy(); } },
    strokeText(text, stroke, matrix, colorspace, color, alpha) { try { read(text, matrix, colorspace, color, alpha, stroke); } finally { stroke.destroy(); colorspace.destroy(); } },
    // Catch the requested region's non-cacheable Type 3 glyphs before accepting
    // an edit. Ordinary invisible OCR glyphs and other regions stay excluded.
    ignoreText(text, matrix) { read(text, matrix, engine.ColorSpace.DeviceRGB, [0, 0, 0], 1, undefined, true); },
  });
  try { page.runPageContents(device, engine.Matrix.identity); device.close(); } finally { device.destroy(); }
  if (!glyphs.length) return undefined;
  // Without Unicode data the renderer reports U+FFFD. Pair those glyphs with the text
  // the editor shows, or an unchanged row would be redrawn from the wrong outlines.
  for (const line of block.lines) {
    const row = glyphs.filter(glyph => glyph.row === line).sort((a, b) => a.x - b.x);
    if (!row.some(glyph => glyph.character === '\uFFFD')) continue;
    const blank = (text: string) => /\s/u.test(text);
    const characters = Array.from(line.text.normalize('NFC'));
    const [painted, known] = row.length === characters.length ? [row, characters]
      : [row.filter(glyph => !blank(glyph.character)), characters.filter(character => !blank(character))];
    if (painted.length !== known.length) throw new Error(UNMAPPED_TEXT_EDIT_REASON);
    painted.forEach((glyph, index) => { if (glyph.character === '\uFFFD') glyph.character = known[index]; });
  }
  for (const glyph of glyphs) {
    // Reuse the PDF's mappings even when a subset font has no Unicode cmap.
    session.useSourceGlyph(glyph.style.fontKey, glyph.character, glyph.glyphId);
    if (/[\uFB00-\uFB06]/u.test(glyph.character)) {
      glyph.character = glyph.character.normalize('NFKC');
      session.useSourceGlyph(glyph.style.fontKey, glyph.character, glyph.glyphId);
    }
  }
  const source: Array<{ character: string; style: TextGlyphStyle }> = [];
  for (const [index, line] of block.lines.entries()) {
    const row = glyphs.filter(glyph => glyph.row === line).sort((a, b) => a.x - b.x);
    const lineText = line.text.normalize('NFC');
    let logicalOffset = 0;
    const positions = row.map(glyph => {
      const found = lineText.indexOf(glyph.character, logicalOffset);
      if (found >= 0) logicalOffset = found + glyph.character.length;
      return found;
    });
    const missingSpaces = (i: number) => positions[i] < 0 || positions[i + 1] < 0 ? ''
      : lineText.slice(positions[i] + row[i].character.length, positions[i + 1]);
    const spacing = new Map<string, number[]>();
    for (let i = 0; i < row.length - 1; i++) {
      const a = row[i], b = row[i + 1];
      if (/\s/u.test(a.character) || /\s/u.test(missingSpaces(i))) continue;
      const delta = (b.x - a.x) / a.style.fontSize - a.naturalAdvance * a.style.horizontalScale;
      // Exclude a missing-space gap; retain genuine Tc/TJ tracking, including negative spacing.
      if (Math.abs(delta) < .25) { const values = spacing.get(a.style.fontKey) ?? []; values.push(delta); spacing.set(a.style.fontKey, values); }
    }
    const wordSpacing = new Map<string, number[]>();
    for (let i = 0; i < row.length - 1; i++) {
      const a = row[i], b = row[i + 1];
      if (!/\s/u.test(a.character)) continue;
      const delta = (b.x - a.x) / a.style.fontSize - a.naturalAdvance * a.style.horizontalScale - median(spacing.get(a.style.fontKey) ?? []);
      const values = wordSpacing.get(a.style.fontKey) ?? []; values.push(delta); wordSpacing.set(a.style.fontKey, values);
    }
    for (const glyph of row) {
      glyph.style.tracking = median(spacing.get(glyph.style.fontKey) ?? []);
      glyph.style.wordSpacing = median(wordSpacing.get(glyph.style.fontKey) ?? []);
    }
    // Preserve pair-specific TJ kerning on unchanged characters, instead of
    // applying the run's median spacing to every original letter.
    for (let i = 0; i < row.length - 1; i++) {
      const a = row[i], b = row[i + 1];
      const delta = (b.x - a.x) / a.style.fontSize - a.naturalAdvance * a.style.horizontalScale;
      if (/\s/u.test(a.character)) {
        a.style.wordSpacing = delta - a.style.tracking;
        a.style.spaceAdvance = (b.x - a.x) / a.style.fontSize;
      }
      // The gap before a real space glyph cannot hide a missing space, however wide it is.
      else if ((Math.abs(delta) < .25 || /\s/u.test(b.character)) && !/\s/u.test(missingSpaces(i))) a.style.tracking = delta;
    }
    const last = row.at(-1);
    if (last && !/\s/u.test(last.character)) {
      const trailing = (line.x + line.width - last.x) / last.style.fontSize - last.naturalAdvance * last.style.horizontalScale;
      if (Math.abs(trailing) < .25) last.style.tracking = trailing;
    }
    // TeX and many subset fonts position words with TJ rather than painting a
    // space glyph. Those gaps are word spacing, never tracking on the preceding
    // letter plus another synthetic space (which used to double the gap).
    const syntheticSpaces = new Map<number, { advance: number; style: TextGlyphStyle }>();
    for (let i = 0; i < row.length - 1; i++) {
      const missing = missingSpaces(i);
      if (!/^\s+$/u.test(missing)) continue;
      const a = row[i], b = row[i + 1];
      const gap = (b.x - a.x) / a.style.fontSize - a.naturalAdvance * a.style.horizontalScale;
      let advance = (gap - a.style.tracking) / missing.length;
      if (advance <= 0) {
        // A math comma's inferred tracking can already include an unlabelled
        // word gap elsewhere in the row. If it consumes this entire gap, use
        // the measured distance here instead of adding a fallback space too.
        a.style.tracking = Math.min(0, gap);
        advance = Math.max(0, gap) / missing.length;
      }
      for (let offset = positions[i] + a.character.length; offset < positions[i + 1]; offset++) syntheticSpaces.set(offset, { advance, style: a.style });
    }
    // Follow the glyph offsets already found: a space inferred between tracked letters
    // must not claim the row's next real space and shift every later letter's style.
    const logical = new Map<number, TextGlyphStyle>();
    row.forEach((glyph, i) => {
      let offset = positions[i];
      if (offset >= 0) for (const character of Array.from(glyph.character)) { logical.set(offset, glyph.style); offset += character.length; }
    });
    let inherited = (row[0] ?? glyphs[0]).style;
    logicalOffset = 0;
    for (const character of Array.from(lineText)) {
      inherited = logical.get(logicalOffset) ?? inherited;
      const synthetic = syntheticSpaces.get(logicalOffset);
      source.push({ character, style: synthetic ? { ...synthetic.style, spaceAdvance: synthetic.advance } : { ...inherited } });
      logicalOffset += character.length;
    }
    if (index < block.lines.length - 1) {
      if (source.length && isSoftHyphenBreak(lineText)) source.at(-1)!.style.softHyphen = true;
      source.push({ character: '\n', style: { ...(row.at(-1) ?? glyphs[0]).style } });
    }
  }
  // Reflow a justified paragraph from its normal word spacing, then justify the
  // new rows once. Reusing already-stretched spaces would justify it twice.
  const lastLine = block.lines.at(-1);
  if (block.style.alignment === 'justify' && lastLine && lastLine.width < block.rect.width * .95) {
    const spaces = new Map<string, number[]>();
    const minimums = new Map<string, number>();
    for (const item of source) {
      if (!/\s/u.test(item.character) || item.style.spaceAdvance === undefined) continue;
      minimums.set(item.style.fontKey, Math.min(minimums.get(item.style.fontKey) ?? Infinity, item.style.spaceAdvance));
    }
    for (const item of source.slice(-Array.from(lastLine.text).length)) {
      if (!/\s/u.test(item.character) || item.style.spaceAdvance === undefined) continue;
      const values = spaces.get(item.style.fontKey) ?? []; values.push(item.style.spaceAdvance); spaces.set(item.style.fontKey, values);
    }
    for (const item of source) {
      const values = spaces.get(item.style.fontKey);
      if (values?.length) {
        item.style.reflowSpaceAdvance = median(values);
        item.style.minimumSpaceAdvance = minimums.get(item.style.fontKey);
      }
    }
  }
  const first = glyphs.find(glyph => glyph.character.trim()) ?? glyphs[0];
  // The detector represents a mixed-size line by its largest em. Use the same
  // basis so an explicit size change scales runs consistently with the UI.
  const fontSize = Math.max(...glyphs.map(glyph => glyph.style.fontSize));
  return { fontSize, fontName: first.style.fontName, fontNames: [...fontNames], fontColor: first.style.fontColor, fontKey: first.style.fontKey, source };
}

/** Map unchanged runs through local replacements; inserted text inherits the replaced run's style. */
export function replacementTextStyles(source: Array<{ character: string; style: TextGlyphStyle }>, text: string, reflow: boolean, rows?: ReadonlyArray<{ text: string; joinAfter?: string }>): TextGlyphStyle[] {
  const original = source.map(item => item.character).join('');
  if (reflow) {
    const authored = rows?.map(row => row.text).join('\n') === original ? rows : undefined;
    let row = 0;
    source = source.flatMap((item, index) => {
      if (item.character !== '\n') return [item];
      const boundary = row++, before = source[index - 1]?.character, after = source[index + 1]?.character;
      if (!before || !after || before === '\n' || after === '\n') return [item];
      const separator = authored?.[boundary]?.joinAfter
        ?? originalParagraphText(`${before}\n${after}`).slice(before.length, -after.length);
      // A wrap can remove several spaces; each retains this boundary's style,
      // while the following real glyphs keep their own styles and source offsets.
      return Array.from(separator, character => ({ character, style: item.style }));
    });
  }
  const next = Array.from(normalizeReplacementText(text));
  const result: Array<TextGlyphStyle | undefined> = new Array(next.length).fill(undefined);
  let left = 0, a = source.length, b = next.length;
  while (left < a && left < b && source[left].character === next[left]) { result[left] = source[left].style; left++; }
  while (a > left && b > left && source[a - 1].character === next[b - 1]) { result[--b] = source[--a].style; }
  // Bounded LCS also preserves emphasis between several separate replacements.
  if ((a - left) * (b - left) <= 1_000_000) {
    const width = b - left + 1, matrix = new Uint16Array((a - left + 1) * width);
    for (let i = a - left - 1; i >= 0; i--) for (let j = b - left - 1; j >= 0; j--) {
      matrix[i * width + j] = source[left + i].character === next[left + j]
        ? 1 + matrix[(i + 1) * width + j + 1] : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < a - left && j < b - left) {
      if (source[left + i].character === next[left + j]) { result[left + j] = source[left + i].style; i++; j++; }
      else if (matrix[(i + 1) * width + j] >= matrix[i * width + j + 1]) i++; else j++;
    }
  }
  let inherited = source[Math.min(left, source.length - 1)]?.style;
  return result.map(style => { inherited = style ?? inherited; return { ...inherited! }; });
}
