import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';

/** Never show stale words from a page whose current edits cannot be exported. */
export function partialSearchDocument(document: PDFDocumentProxy, workspace: WorkspaceSnapshot) {
  const skipped = new Set<number>();
  const blocks = new Map([...workspace.editing.textBlocks.values()].flat().map(block => [block.id, block]));
  const images = new Map([...workspace.editing.images.values()].flat().map(image => [image.id, image]));
  for (const edit of workspace.editing.textEdits) {
    const block = blocks.get(edit.blockId); if (!block) return null;
    skipped.add(block.pageNumber);
  }
  for (const edit of workspace.editing.imageEdits) {
    const image = images.get(edit.imageId); if (!image) return null;
    skipped.add(image.pageNumber);
  }
  for (const [page, annotations] of workspace.annotations) if (annotations.length) skipped.add(page);
  for (const field of workspace.form.fields) {
    if (JSON.stringify(field.value) !== JSON.stringify(workspace.form.originalValues.get(field.id))) skipped.add(field.pageNumber);
  }
  if (!skipped.size || skipped.size >= document.numPages) return null;
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const getPage = (number: number) => {
    if (!skipped.has(number)) return document.getPage(number);
    let pending = pages.get(number);
    if (!pending) {
      pending = document.getPage(number).then(page => new Proxy(page, {
        get(target, property) {
          if (property === 'getTextContent') return async () => ({ items: [], styles: {}, lang: null });
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }));
      pages.set(number, pending);
    }
    return pending;
  };
  return {
    skippedPages: [...skipped].sort((a, b) => a - b),
    document: new Proxy(document, {
      get(target, property) {
        if (property === 'getPage') return getPage;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
}
