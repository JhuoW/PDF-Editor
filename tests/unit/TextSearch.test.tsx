// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchText, findTextMatches } from '../../src/utils/textSearch';
import { searchDocument, useSearchStore } from '../../src/store/searchStore';
import { TextLayer } from '../../src/components/PDFViewer/TextLayer';

const defaults = { caseSensitive: false, wholeWord: false };
function documentWith(items: Array<{ str: string; hasEOL?: boolean }>, numPages = 1) {
  const getTextContent = vi.fn().mockResolvedValue({ items: items.map(item => ({ ...item, transform: [1, 0, 0, 12, 30, 70], width: item.str.length * 6 })) });
  const page = { pageNumber: 1, rotate: 0, getViewport: () => ({ width: 400, height: 600 }), getTextContent } as unknown as PDFPageProxy;
  const getPage = vi.fn().mockResolvedValue(page);
  return { pdf: { numPages, getPage } as unknown as PDFDocumentProxy, page, getPage, getTextContent };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise };
}
beforeEach(() => { useSearchStore.setState({ query: '', results: [], currentResultIndex: -1, isSearching: false, options: { ...defaults } }); });

describe('shared PDF text matching', () => {
  it('uses original offsets, literal queries and non-overlapping Unicode-aware casing', () => {
    expect(findTextMatches('aaaa', 'aa', defaults)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    expect(findTextMatches('a+b aab a+b', 'a+b', defaults)).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }]);
    expect(findTextMatches('İ A a', 'a', defaults)).toEqual([{ start: 2, end: 3 }, { start: 4, end: 5 }]);
    expect(findTextMatches('İ A a', 'a', { ...defaults, caseSensitive: true })).toEqual([{ start: 4, end: 5 }]);
    expect(findTextMatches('abc', '', defaults)).toEqual([]);
  });
  it('treats accented, combining, CJK and astral Unicode letters as word characters', () => {
    const options = { ...defaults, wholeWord: true }, text = 'café cafétéria CAFÉ café_ café\u0301';
    expect(findTextMatches(text, 'café', options).map(match => text.slice(match.start, match.end))).toEqual(['café', 'CAFÉ']);
    expect(findTextMatches('𐐀 𐐨 𐐀𐐨', '𐐨', options)).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
    expect(findTextMatches('中文 中文字', '中文', options)).toEqual([{ start: 0, end: 2 }]);
  });
  it('inserts PDF EOLs while retaining exact offsets for text items and marked content', () => {
    expect(buildSearchText([{ str: 'cross' }, { type: 'beginMarkedContent' }, { str: 'item', hasEOL: true }, { str: '', hasEOL: true }, { str: 'next' }])).toEqual({
      text: 'crossitem\n\nnext', segments: [{ itemIndex: 0, start: 0, end: 5 }, { itemIndex: 2, start: 5, end: 9 }, { itemIndex: 3, start: 10, end: 10 }, { itemIndex: 4, start: 11, end: 15 }],
    });
  });
  it('counts cross-item and single-character matches and avoids false matches across line ends', async () => {
    const source = documentWith([{ str: 'cross' }, { str: 'item', hasEOL: true }, { str: 'cross', hasEOL: true }, { str: 'item aaaa' }], 2);
    expect(await searchDocument(source.pdf, 'crossitem', defaults)).toEqual([
      { pageNumber: 1, matchIndex: 0, textContent: 'crossitem\ncross\nitem aaaa' }, { pageNumber: 2, matchIndex: 0, textContent: 'crossitem\ncross\nitem aaaa' },
    ]);
    expect(await searchDocument(source.pdf, 'aa', defaults)).toHaveLength(4);
    expect(await searchDocument(source.pdf, 'a', defaults)).toHaveLength(8);
  });
  it('immediately invalidates old results on a query or option change', () => {
    const result = { pageNumber: 1, matchIndex: 0, textContent: 'old' };
    useSearchStore.getState().setResults([result]); useSearchStore.getState().setQuery('a');
    expect(useSearchStore.getState()).toMatchObject({ results: [], currentResultIndex: -1, isSearching: true });
    useSearchStore.getState().setResults([result]); useSearchStore.getState().setOptions({ wholeWord: true });
    expect(useSearchStore.getState()).toMatchObject({ results: [], currentResultIndex: -1, isSearching: true, options: { caseSensitive: false, wholeWord: true } });
    useSearchStore.getState().setQuery(''); expect(useSearchStore.getState().isSearching).toBe(false);
  });
  it('checks cancellation before requesting a page', async () => {
    const source = documentWith([{ str: 'a' }]), controller = new AbortController(); controller.abort();
    await expect(searchDocument(source.pdf, 'a', defaults, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(source.getPage).not.toHaveBeenCalled();
  });
  it('checks cancellation after getPage and before loading its text', async () => {
    const source = documentWith([{ str: 'a' }]), pending = deferred<PDFPageProxy>(), controller = new AbortController(); source.getPage.mockReturnValue(pending.promise);
    const search = searchDocument(source.pdf, 'a', defaults, controller.signal); controller.abort(); pending.resolve(source.page);
    await expect(search).rejects.toMatchObject({ name: 'AbortError' }); expect(source.getTextContent).not.toHaveBeenCalled();
  });
  it('checks cancellation after text loading and never requests later pages', async () => {
    const source = documentWith([{ str: 'a' }], 3), pending = deferred<{ items: { str: string }[] }>(), controller = new AbortController(); source.getTextContent.mockReturnValue(pending.promise);
    const search = searchDocument(source.pdf, 'a', defaults, controller.signal); await Promise.resolve(); expect(source.getTextContent).toHaveBeenCalledOnce(); controller.abort(); pending.resolve({ items: [{ str: 'a' }] });
    await expect(search).rejects.toMatchObject({ name: 'AbortError' }); expect(source.getPage).toHaveBeenCalledOnce();
  });
});

describe('PDF search highlighting', () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const marks = () => [...host.querySelectorAll('mark')].map(mark => mark.textContent);
  async function render(page: PDFPageProxy, query: string, active = -1) { await act(async () => root.render(<TextLayer page={page} scale={1} rotation={0} searchQuery={query} activeMatchPage={1} activeMatchIndex={active} />)); }
  it('highlights all fragments of a cross-item active match and respects line breaks', async () => {
    const source = documentWith([{ str: 'prefix cross' }, { str: 'item suffix', hasEOL: true }, { str: 'cross', hasEOL: true }, { str: 'item' }]);
    await render(source.page, 'crossitem', 0); expect(marks()).toEqual(['cross', 'item']); expect(host.querySelectorAll('mark.active')).toHaveLength(2);
    expect(host.querySelector('.textLayer')?.textContent).toBe('prefix crossitem suffixcrossitem');
  });
  it('matches counts and indices when case and Unicode whole-word options change', async () => {
    const source = documentWith([{ str: 'café CAFÉ cafétéria' }]);
    await render(source.page, 'café', 1); expect(marks()).toEqual(['café', 'CAFÉ', 'café']); expect(host.querySelector('mark.active')?.textContent).toBe('CAFÉ');
    await act(async () => useSearchStore.getState().setOptions({ wholeWord: true })); expect(marks()).toEqual(['café', 'CAFÉ']);
    await act(async () => useSearchStore.getState().setOptions({ caseSensitive: true })); expect(marks()).toEqual(['café']); expect(host.querySelector('mark.active')).toBeNull();
    expect(await searchDocument(source.pdf, 'café', useSearchStore.getState().options)).toHaveLength(1);
  });
  it('uses the same non-overlapping matches when spans divide a repeated query', async () => {
    const source = documentWith([{ str: 'a' }, { str: 'aaa' }]); await render(source.page, 'aa', 1);
    expect(marks()).toEqual(['a', 'a', 'aa']); expect(host.querySelector('mark.active')?.textContent).toBe('aa'); expect(await searchDocument(source.pdf, 'aa', defaults)).toHaveLength(2);
  });
  it('ignores stale text extraction after the query changes and cancels deferred scrolling', async () => {
    const source = documentWith([{ str: 'new' }]), old = deferred<{ items: [] }>(); source.getTextContent.mockReturnValueOnce(old.promise);
    await render(source.page, 'old'); await render(source.page, 'new', 0); expect(marks()).toEqual(['new']); expect(vi.getTimerCount()).toBe(1);
    await act(async () => old.resolve({ items: [] })); expect(marks()).toEqual(['new']);
    await render(source.page, ''); expect(vi.getTimerCount()).toBe(0); expect(marks()).toEqual([]);
  });
});
