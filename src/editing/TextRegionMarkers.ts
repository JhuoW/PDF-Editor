/** Keep editor-authored paragraph boundaries when a saved PDF is reopened.
 * These ordinary marked-content tags never hide text or affect its appearance. */
const MAX_LEADING = 14_400;
const LEADING_PRECISION = 1_000_000;
const LEADING_SUFFIX = /_(\d+)_L(\d{1,11})(?:_B\d{1,11})?$/;
export function textRegionTag(kind: 'paragraph' | 'line', sourceId: string = crypto.randomUUID(), index = 0, nominalLeading?: number, baselineOffset?: number) {
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(sourceId) ? sourceId : crypto.randomUUID();
  const micropoints = nominalLeading !== undefined && Number.isFinite(nominalLeading) && nominalLeading > 0 && nominalLeading <= MAX_LEADING
    ? Math.round(nominalLeading * LEADING_PRECISION) : 0;
  const baselineMicropoints = baselineOffset !== undefined && Number.isFinite(baselineOffset) && baselineOffset > 0 && baselineOffset <= MAX_LEADING
    ? Math.round(baselineOffset * LEADING_PRECISION) : 0;
  // Record the chosen leading, not extra space needed by individual tall glyphs.
  // Inferring it again from those expanded rows makes that temporary space grow
  // permanent after save/reopen or switching modes and deleting the tall text.
  return `PDFEditor${kind === 'line' ? 'Object' : 'Paragraph'}_${id}_${index}${micropoints ? `_L${micropoints}${baselineMicropoints ? `_B${baselineMicropoints}` : ''}` : ''}`;
}
export function textRegionSource(tag: unknown): string | undefined {
  return textRegionFromTag(tag)?.replace(LEADING_SUFFIX, '_$1').replace(/^PDFEditor(?:Paragraph|Object)_/, '').replace(/_\d+$/, '');
}
export function textRegionLeading(tag: unknown): number | undefined {
  const value = textRegionFromTag(tag)?.match(LEADING_SUFFIX)?.[2];
  const leading = value === undefined ? 0 : Number(value) / LEADING_PRECISION;
  return leading > 0 && leading <= MAX_LEADING ? leading : undefined;
}
/** A fixed first baseline can sit below a logical top different from font size. */
export function textRegionBaselineOffset(tag: unknown): number | undefined {
  const value = textRegionFromTag(tag)?.match(/_\d+_L\d{1,11}_B(\d{1,11})$/)?.[1];
  const offset = value === undefined ? 0 : Number(value) / LEADING_PRECISION;
  return offset > 0 && offset <= MAX_LEADING ? offset : undefined;
}
export function textRegionFromTag(tag: unknown): string | undefined {
  return typeof tag === 'string' && /^PDFEditor(?:Paragraph|Object)_[a-zA-Z0-9_-]{1,121}$/.test(tag) ? tag : undefined;
}

/** Row provenance contains only discarded whitespace, never hidden document text.
 * An empty join records a forced break inside a long token or between CJK glyphs. */
export function textRowTag(join: string): string {
  if (!join) return 'PDFEditorRow_N';
  if (/^ +$/.test(join)) return `PDFEditorRow_S${join.length}`;
  return `PDFEditorRow_U${Array.from(join, character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('')}`;
}
export function textRowJoin(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined;
  if (tag === 'PDFEditorRow_N') return '';
  const spaces = /^PDFEditorRow_S([1-9]\d{0,4})$/.exec(tag);
  if (spaces) { const length = Number(spaces[1]); return length <= 20_000 ? ' '.repeat(length) : undefined; }
  if (!/^PDFEditorRow_U(?:[0-9a-f]{4}){1,20000}$/.test(tag)) return undefined;
  const value = tag.slice('PDFEditorRow_U'.length).match(/.{4}/g)!.map(code => String.fromCharCode(parseInt(code, 16))).join('');
  return /^[^\S\r\n]+$/u.test(value) ? value : undefined;
}
