import { PDF_BOOKMARK_LIMITS, type PDFBookmarkDraft, type PDFBookmarkInfo } from '../../core/PDFBookmarksTypes';
export function bookmarkDraft(tree: PDFBookmarkInfo[]): PDFBookmarkDraft[] {
  return tree.map(({ id, definition, children }) => ({ id, definition: structuredClone(definition), children: bookmarkDraft(children) }));
}
export function flattenBookmarks(tree: PDFBookmarkInfo[], level = 0): Array<{ item: PDFBookmarkInfo; level: number }> {
  return tree.flatMap(item => [{ item, level }, ...flattenBookmarks(item.children, level + 1)]);
}
export function findBookmark(tree: PDFBookmarkInfo[], id: string, parent: PDFBookmarkInfo | null = null): { item: PDFBookmarkInfo; siblings: PDFBookmarkInfo[]; index: number; parent: PDFBookmarkInfo | null } | null {
  for (let index = 0; index < tree.length; index++) {
    const item = tree[index]; if (item.id === id) return { item, siblings: tree, index, parent };
    const child = findBookmark(item.children, id, item); if (child) return child;
  }
  return null;
}
export function movableBookmark(tree: PDFBookmarkInfo[], id: string, direction: 'up' | 'down' | 'indent' | 'outdent'): boolean {
  const found = findBookmark(tree, id); if (!found?.item.movable) return false;
  const { siblings, index, parent } = found;
  if (direction === 'up') return index > 0 && siblings[index - 1].movable;
  if (direction === 'down') return index < siblings.length - 1 && siblings[index + 1].movable;
  if (direction === 'indent') {
    const level = flattenBookmarks(tree).find(row => row.item.id === id)!.level;
    const depth = Math.max(...flattenBookmarks([found.item]).map(row => row.level));
    return index > 0 && siblings[index - 1].movable && level + depth + 1 < PDF_BOOKMARK_LIMITS.depth;
  }
  return !!parent?.movable;
}
export function moveBookmark(tree: PDFBookmarkInfo[], id: string, direction: 'up' | 'down' | 'indent' | 'outdent'): PDFBookmarkInfo[] {
  if (!movableBookmark(tree, id, direction)) return tree;
  const next = structuredClone(tree), found = findBookmark(next, id)!;
  const { item, siblings, index, parent } = found;
  siblings.splice(index, 1);
  if (direction === 'up') siblings.splice(index - 1, 0, item);
  else if (direction === 'down') siblings.splice(index + 1, 0, item);
  else if (direction === 'indent') siblings[index - 1].children.push(item);
  else { const ancestor = findBookmark(next, parent!.id)!; ancestor.siblings.splice(ancestor.index + 1, 0, item); }
  return next;
}
