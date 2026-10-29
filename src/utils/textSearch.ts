export interface TextSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}
export interface TextMatch { start: number; end: number }

/** Offsets always refer to the original UTF-16 text, including Unicode casing. */
export function findTextMatches(text: string, query: string, options: TextSearchOptions): TextMatch[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = '[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]';
  const pattern = options.wholeWord ? `(?<!${word})${literal}(?!${word})` : literal;
  const expression = new RegExp(pattern, options.caseSensitive ? 'gu' : 'giu');
  return Array.from(text.matchAll(expression), match => ({ start: match.index, end: match.index + match[0].length }));
}

/** The same text and item offsets drive both counting and visible highlights. */
export function buildSearchText(items: readonly unknown[]): {
  text: string;
  segments: Array<{ itemIndex: number; start: number; end: number }>;
} {
  const chunks: string[] = [], segments: Array<{ itemIndex: number; start: number; end: number }> = [];
  let offset = 0;
  items.forEach((item, itemIndex) => {
    if (!item || typeof item !== 'object' || !('str' in item) || typeof item.str !== 'string') return;
    const start = offset; chunks.push(item.str); offset += item.str.length;
    segments.push({ itemIndex, start, end: offset });
    if ('hasEOL' in item && item.hasEOL) { chunks.push('\n'); offset++; }
  });
  return { text: chunks.join(''), segments };
}
