import { expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { partialSearchDocument } from '../../src/utils/partialSearchDocument';
import { searchDocument } from '../../src/store/searchStore';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { createFreeTextAnnotation } from '../../src/store/annotationStore';

const options = { caseSensitive: false, wholeWord: false };
function source() {
  const getTextContent = vi.fn(async () => ({ items: [{ str: 'Original searchable text' }], styles: {} }));
  const getPage = vi.fn(async (pageNumber: number) => ({ pageNumber, getTextContent }));
  return { pdf: { numPages: 3, getPage } as unknown as PDFDocumentProxy, getPage, getTextContent };
}
it('keeps untouched pages searchable when a pending annotation cannot be exported, without returning stale words on that page', async () => {
  const { pdf } = source(), workspace = createWorkspace();
  workspace.annotations.set(2, [createFreeTextAnnotation(2, [20, 20, 80, 20], 'An overflowing draft')]);
  const partial = partialSearchDocument(pdf, workspace)!;
  expect(partial.skippedPages).toEqual([2]);
  expect((await searchDocument(partial.document, 'Original', options)).map(result => result.pageNumber)).toEqual([1, 3]);
  expect(await partial.document.getPage(2).then(page => page.getTextContent())).toMatchObject({ items: [] });
  expect((await searchDocument(pdf, 'Original', options)).map(result => result.pageNumber)).toEqual([1, 2, 3]);
});
it('does not guess an unchanged page when the failed edit source cannot be identified', () => {
  const { pdf } = source(), workspace = createWorkspace();
  workspace.editing.textEdits = [{ blockId: 'unknown', originalText: 'old', newText: 'new', timestamp: 1 }];
  expect(partialSearchDocument(pdf, workspace)).toBeNull();
});
it('reuses extracted page text for later queries but separates replacement PDF documents', async () => {
  const first = source(), second = source();
  expect(await searchDocument(first.pdf, 'searchable', options)).toHaveLength(3);
  expect(await searchDocument(first.pdf, 'Original', options)).toHaveLength(3);
  expect(first.getTextContent).toHaveBeenCalledTimes(3);
  await searchDocument(second.pdf, 'text', options);
  expect(second.getTextContent).toHaveBeenCalledTimes(3);
});
it('retries a failed page extraction and honours cancellation after a cached result', async () => {
  const { pdf, getTextContent } = source();
  getTextContent.mockRejectedValueOnce(new Error('temporary page error'));
  await expect(searchDocument(pdf, 'text', options)).rejects.toThrow('temporary');
  expect(await searchDocument(pdf, 'text', options)).toHaveLength(3);
  const controller = new AbortController(); controller.abort();
  await expect(searchDocument(pdf, 'text', options, controller.signal)).rejects.toThrow('Search cancelled');
});
