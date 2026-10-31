/** Keep editor-authored paragraph boundaries when a saved PDF is reopened.
 * These ordinary marked-content tags never hide text or affect its appearance. */
export function textRegionTag(kind: 'paragraph' | 'line', sourceId: string = crypto.randomUUID(), index = 0) {
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(sourceId) ? sourceId : crypto.randomUUID();
  return `PDFEditor${kind === 'line' ? 'Object' : 'Paragraph'}_${id}_${index}`;
}
export function textRegionSource(tag: unknown): string | undefined {
  return textRegionFromTag(tag)?.replace(/^PDFEditor(?:Paragraph|Object)_/, '').replace(/_\d+$/, '');
}
export function textRegionFromTag(tag: unknown): string | undefined {
  return typeof tag === 'string' && /^PDFEditor(?:Paragraph|Object)_[a-zA-Z0-9_-]{1,96}$/.test(tag) ? tag : undefined;
}
