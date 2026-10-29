/** Page numbers are one-based throughout the editor. Missing entries are deleted pages. */
export function deletionPageMap(totalPages: number, deletedPages: number[]): Map<number, number> {
  const deleted = new Set(deletedPages);
  if ([...deleted].some(page => !Number.isInteger(page) || page < 1 || page > totalPages)) {
    throw new Error('Page number is outside the document');
  }
  if (deleted.size >= totalPages) throw new Error('Cannot delete all pages');
  const mapping = new Map<number, number>();
  let nextPage = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (!deleted.has(page)) mapping.set(page, nextPage++);
  }
  return mapping;
}

export function insertionPageMap(totalPages: number, position: number, count: number): Map<number, number> {
  if (!Number.isInteger(position) || position < 0 || position > totalPages + 1) {
    throw new Error('Invalid insertion position');
  }
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid number of inserted pages');
  const beforePage = position === 0 ? totalPages + 1 : position;
  return new Map(Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return [page, page < beforePage ? page : page + count];
  }));
}

export function reorderedPageMap(totalPages: number, newOrder: number[]): Map<number, number> {
  if (newOrder.length !== totalPages || new Set(newOrder).size !== totalPages
    || newOrder.some(page => !Number.isInteger(page) || page < 1 || page > totalPages)) {
    throw new Error('Page order must contain each page exactly once');
  }
  return new Map(newOrder.map((page, index) => [page, index + 1]));
}

/** Move selected pages as a stable group before a page (0 means append). */
export function movePageSelection(totalPages: number, selectedPages: number[], beforePage: number): number[] {
  if (!Number.isInteger(beforePage) || beforePage < 0 || beforePage > totalPages + 1) {
    throw new Error('Invalid page move destination');
  }
  const selected = new Set(selectedPages);
  if (!selected.size || [...selected].some(page => !Number.isInteger(page) || page < 1 || page > totalPages)) {
    throw new Error('Invalid page selection');
  }
  const original = Array.from({ length: totalPages }, (_, index) => index + 1);
  const moving = original.filter(page => selected.has(page));
  const remaining = original.filter(page => !selected.has(page));
  const destination = beforePage === 0 ? totalPages + 1 : beforePage;
  const index = remaining.filter(page => page < destination).length;
  remaining.splice(index, 0, ...moving);
  return remaining;
}
