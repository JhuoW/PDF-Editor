/** Shared PDF names only; importing markers must not load the rendering engine. */
export const PAGE_DECORATION_MARKERS = {
  manifest: 'PDFEditorDecorationManifest',
  guard: 'PDFEditorDecorationGuard',
  id: 'PDFEditorDecorationID',
  instance: 'PDFEditorDecorationInstance',
  kind: 'PDFEditorDecorationKind',
  contentTagPrefix: 'PDFEditorDecoration_',
} as const;

export function decorationInstanceFromTag(tag: unknown): string | undefined {
  // PDF.js normalizes BDC/text-content tags, but BMC operator args retain Name.
  if (tag && typeof tag === 'object' && 'name' in tag) tag = tag.name;
  if (typeof tag !== 'string' || !tag.startsWith(PAGE_DECORATION_MARKERS.contentTagPrefix)) return undefined;
  const id = tag.slice(PAGE_DECORATION_MARKERS.contentTagPrefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}
