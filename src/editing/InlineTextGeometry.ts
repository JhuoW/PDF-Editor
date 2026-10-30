import type { PreparedTextEditLayout } from './TextEditApplier';
import type { TextBlock } from './types';

/** Initial hit testing uses the original PDF item advances while the worker starts. */
export function sourceInlineGeometry(block: TextBlock): PreparedTextEditLayout {
  const size = block.style.fontSize;
  return {
    input: { text: block.text, rect: block.rect, fontName: block.style.fontName, fontSize: size, fontColor: '#000000', alignment: block.style.alignment, lineHeight: block.style.lineHeight },
    page: { width: 0, height: 0 },
    layout: { fits: true, requiredHeight: block.rect.height, fontSize: size, lineAdvance: size * block.style.lineHeight, inkBounds: block.rect, warnings: [], lines: block.lines.map(line => {
      let cursor = 0, x = line.x;
      const glyphs: PreparedTextEditLayout['layout']['lines'][number]['glyphs'] = [];
      for (const item of line.items) {
        const start = Math.max(cursor, line.text.indexOf(item.str, cursor));
        while (cursor < start) { glyphs.push({ character: line.text[cursor++], fontName: item.fontName, glyphId: 0, x, baseline: line.baseline, advance: Math.max(0, item.x - x) }); x = item.x; }
        const characters = Array.from(item.str), advance = item.width / Math.max(1, characters.length);
        for (const character of characters) { glyphs.push({ character, fontName: item.fontName, glyphId: 0, x: item.x + (cursor - start) * advance, baseline: line.baseline, advance }); cursor += character.length; }
        x = item.x + item.width;
      }
      return { text: line.text, x: line.x, baseline: line.baseline, width: line.width, paragraphEnd: true, glyphs };
    }) },
  };
}

export function inlineTextRows(prepared: PreparedTextEditLayout) {
  let cursor = 0;
  return prepared.layout.lines.map(line => {
    const found = prepared.input.text.indexOf(line.text, cursor), start = found < 0 ? cursor : found;
    let offset = start;
    const glyphs = line.glyphs.map(glyph => { const index = offset; offset += glyph.character.length; return { ...glyph, index, end: offset }; });
    cursor = offset;
    if (line.paragraphEnd && prepared.input.text[cursor] === '\n') cursor++;
    return { ...line, start, end: offset, glyphs };
  });
}

export function inlineOffsetAt(prepared: PreparedTextEditLayout, x: number, y: number) {
  const rows = inlineTextRows(prepared);
  const row = rows.reduce<typeof rows[number] | undefined>((best, row) => !best || Math.abs(y - (row.baseline - prepared.layout.fontSize * .3)) < Math.abs(y - (best.baseline - prepared.layout.fontSize * .3)) ? row : best, undefined);
  if (!row) return 0;
  return row.glyphs.find(glyph => x < glyph.x + glyph.advance / 2)?.index ?? row.end;
}

export function inlineCaret(prepared: PreparedTextEditLayout, offset: number) {
  const rows = inlineTextRows(prepared), size = prepared.layout.fontSize;
  const row = rows.find(row => offset >= row.start && offset <= row.end) ?? rows.at(-1);
  const glyph = row?.glyphs.find(glyph => glyph.index >= offset), last = row?.glyphs.at(-1);
  return { x: glyph?.x ?? (last ? last.x + last.advance : row?.x ?? prepared.input.rect.x), y: (row?.baseline ?? prepared.input.legacyBaseline ?? prepared.input.rect.y + size * .8) - size * .8, width: 1, height: size };
}

export function inlineSelection(prepared: PreparedTextEditLayout, start: number, end: number) {
  return inlineTextRows(prepared).flatMap(row => {
    const selected = row.glyphs.filter(glyph => glyph.end > start && glyph.index < end);
    if (!selected.length) return [];
    const first = selected[0], last = selected.at(-1)!;
    return [{ x: first.x, y: row.baseline - prepared.layout.fontSize * .8, width: Math.max(1, last.x + last.advance - first.x), height: prepared.layout.fontSize }];
  });
}
