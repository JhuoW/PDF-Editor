import type { Font, Matrix, PDFPage, Text } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import type { TextBlock } from './types';
import { originalParagraphText } from './ParagraphText';
import { normalizeReplacementText, standardTextFont, type TextGlyphStyle, type TextLayoutSession } from './TextLayout';
import { sourceTextRow } from './TextPageContent';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface SourceGlyph { character: string; glyphId: number; x: number; y: number; row: TextBlock['lines'][number]; style: TextGlyphStyle; naturalAdvance: number }
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const colorHex = (color: number[]) => {
  const rgb = color.length === 1 ? [color[0], color[0], color[0]] : color.length === 4
    ? color.slice(0, 3).map(value => 1 - Math.min(1, value + color[3])) : color;
  return '#' + rgb.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(1, value)) * 255 + .0001).toString(16).padStart(2, '0')).join('');
};

/** Actual glyph transforms, font identities and advances in the editor's physical page coordinates. */
export function readTextSourceMetrics(engine: Engine, page: PDFPage, block: TextBlock, session: TextLayoutSession) {
  const transform = page.getTransform(), inverse = engine.Matrix.invert(transform);
  const crop = engine.Rect.transform(page.getBounds(), inverse), unit = Math.hypot(transform[0], transform[1]);
  const viewport: Matrix = [unit, 0, 0, -unit, -crop[0] * unit, crop[3] * unit];
  const fonts = new Map<number, string>(), glyphs: SourceGlyph[] = [], fontNames = new Set<string>();
  const seen = new Set<string>();
  const register = (font: Font) => {
    let key = fonts.get(font.pointer);
    const name = standardTextFont(`${font.isMono() ? 'Courier' : font.isSerif() ? 'Times' : 'Helvetica'}${font.isBold() ? ' Bold' : ''}${font.isItalic() ? ' Italic' : ''}`);
    if (!key) {
      fontNames.add(font.getName());
      key = `source:${block.id}:${fonts.size}`; fonts.set(font.pointer, key);
      // Text.walk shares its Font wrapper across glyph callbacks. Keep our own
      // reference; destroying the borrowed wrapper invalidates earlier glyphs.
      session.useSourceFont(key, new engine.Font(font.pointer), name);
    }
    return { key, name };
  };
  const read = (text: Text, ctm: Matrix, color: number[]) => {
    let previous: SourceGlyph | undefined;
    try {
      text.walk({ showGlyph(font, trm, gid, unicode) {
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
          const naturalAdvance = font.advanceGlyph(gid), horizontalScale = Math.hypot(matrix[0], matrix[1]) / size;
          const { key, name } = register(font);
          const character = String.fromCodePoint(unicode);
          const position = `${character}:${x.toFixed(2)}:${y.toFixed(2)}`;
          if (seen.has(position)) return;
          seen.add(position);
          previous = { character, glyphId: gid, x, y, row, naturalAdvance,
            style: { fontKey: key, fontName: name, fontSize: size, horizontalScale, tracking: 0, fontColor: colorHex(color),
              ...(Math.abs(y - row.baseline) > .01 ? { baselineOffset: (y - row.baseline) / size } : {}) } };
          glyphs.push(previous);
      } });
    } finally { text.destroy(); }
  };
  const device = new engine.Device({
    fillText(text, matrix, colorspace, color) { try { read(text, matrix, color); } finally { colorspace.destroy(); } },
    strokeText(text, stroke, matrix, colorspace, color) { try { read(text, matrix, color); } finally { stroke.destroy(); colorspace.destroy(); } },
  });
  try { page.runPageContents(device, engine.Matrix.identity); device.close(); } finally { device.destroy(); }
  if (!glyphs.length) return undefined;
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
      else if (Math.abs(delta) < .25 && !/\s/u.test(missingSpaces(i))) a.style.tracking = delta;
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
      const advance = ((b.x - a.x) / a.style.fontSize - a.naturalAdvance * a.style.horizontalScale - a.style.tracking) / missing.length;
      if (advance <= 0) continue;
      for (let offset = positions[i] + a.character.length; offset < positions[i + 1]; offset++) syntheticSpaces.set(offset, { advance, style: a.style });
    }
    let cursor = 0;
    logicalOffset = 0;
    const characters = row.flatMap(glyph => Array.from(glyph.character, character => ({ character, style: glyph.style })));
    for (const character of Array.from(lineText)) {
      const match = characters.findIndex((glyph, i) => i >= cursor && glyph.character === character);
      const glyph = match >= 0 ? characters[match] : characters[Math.max(0, cursor - 1)] ?? glyphs[0];
      const synthetic = syntheticSpaces.get(logicalOffset);
      source.push({ character, style: synthetic ? { ...synthetic.style, spaceAdvance: synthetic.advance } : { ...glyph.style } });
      logicalOffset += character.length;
      if (match >= 0) cursor = match + 1;
    }
    if (index < block.lines.length - 1) source.push({ character: '\n', style: { ...(row.at(-1) ?? glyphs[0]).style } });
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
export function replacementTextStyles(source: Array<{ character: string; style: TextGlyphStyle }>, text: string, reflow: boolean): TextGlyphStyle[] {
  const original = source.map(item => item.character).join('');
  if (reflow) {
    const joined = originalParagraphText(original);
    let offset = 0;
    source = Array.from(joined, character => {
      while (offset < source.length - 1 && source[offset].character === '\n' && character !== ' ' && character !== '\n') offset++;
      const item = source[offset++] ?? source.at(-1)!;
      return { character, style: item.style };
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
