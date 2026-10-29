import type { PDFLinkDefinition, PDFLinkInfo, PDFLinkOperation, PDFLinkRect } from '../../core/PDFLinkTypes';
export function fitLinkRect(rect: PDFLinkRect, width: number, height: number): PDFLinkRect {
  const w = Math.max(1, Math.min(width, rect.width)), h = Math.max(1, Math.min(height, rect.height));
  return { x: Math.max(0, Math.min(width - w, rect.x)), y: Math.max(0, Math.min(height - h, rect.y)), width: w, height: h };
}
export function linkSummary(definition: PDFLinkDefinition) {
  return definition.description || (definition.target.type === 'url' ? definition.target.url || 'New URL link' : `Page ${definition.target.pageNumber} · ${definition.target.view}`);
}
function definitionKey(definition?: PDFLinkDefinition) {
  if (!definition) return '';
  const target = definition.target, rect = definition.rect, border = definition.border;
  const targetRect = target.type === 'page' ? target.rect : undefined;
  return JSON.stringify([definition.pageNumber, rect.x, rect.y, rect.width, rect.height, definition.description || '', border?.width ?? 0, border?.color ?? '#000000', border?.style ?? 'solid', target.type,
    target.type === 'url' ? target.url : [target.pageNumber, target.view, target.x ?? null, target.y ?? null, target.zoom ?? null, targetRect ? [targetRect.x, targetRect.y, targetRect.width, targetRect.height] : null]]);
}
export function buildLinkOperations(original: PDFLinkInfo[], draft: PDFLinkInfo[]): PDFLinkOperation[] {
  const old = new Map(original.map(item => [item.id, item])), current = new Map(draft.map(item => [item.id, item]));
  const operations: PDFLinkOperation[] = original.filter(item => !current.has(item.id)).map(item => ({ type: 'remove', id: item.id }));
  for (const item of draft) {
    if (!item.definition) continue;
    const previous = old.get(item.id);
    if (!previous) operations.push({ type: 'create', definition: item.definition });
    else if (definitionKey(previous.definition) !== definitionKey(item.definition)) operations.push({ type: 'update', id: item.id, definition: item.definition });
  }
  return operations;
}
