/** Keep editor-authored paragraph boundaries when a saved PDF is reopened.
 * These ordinary marked-content tags never hide text or affect its appearance. */
const MAX_LEADING = 14_400;
const LEADING_PRECISION = 1_000_000;
const LEADING_SUFFIX = /_(\d+)_L(\d{1,11})$/;
export function textRegionTag(kind: 'paragraph' | 'line', sourceId: string = crypto.randomUUID(), index = 0, nominalLeading?: number) {
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(sourceId) ? sourceId : crypto.randomUUID();
  const micropoints = nominalLeading !== undefined && Number.isFinite(nominalLeading) && nominalLeading > 0 && nominalLeading <= MAX_LEADING
    ? Math.round(nominalLeading * LEADING_PRECISION) : 0;
  // Record the chosen leading, not extra space needed by individual tall glyphs.
  // Inferring it again from those expanded rows makes that temporary space grow
  // permanent after save/reopen or switching modes and deleting the tall text.
  return `PDFEditor${kind === 'line' ? 'Object' : 'Paragraph'}_${id}_${index}${micropoints ? `_L${micropoints}` : ''}`;
}
export function textRegionSource(tag: unknown): string | undefined {
  return textRegionFromTag(tag)?.replace(LEADING_SUFFIX, '_$1').replace(/^PDFEditor(?:Paragraph|Object)_/, '').replace(/_\d+$/, '');
}
export function textRegionLeading(tag: unknown): number | undefined {
  const value = textRegionFromTag(tag)?.match(LEADING_SUFFIX)?.[2];
  const leading = value === undefined ? 0 : Number(value) / LEADING_PRECISION;
  return leading > 0 && leading <= MAX_LEADING ? leading : undefined;
}
export function textRegionFromTag(tag: unknown): string | undefined {
  return typeof tag === 'string' && /^PDFEditor(?:Paragraph|Object)_[a-zA-Z0-9_-]{1,108}$/.test(tag) ? tag : undefined;
}
