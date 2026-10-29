// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { SearchDialog } from '../../src/components/Dialogs/SearchDialog';
import { searchDocument, useSearchStore, type SearchResult } from '../../src/store/searchStore';

vi.mock('../../src/store/searchStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/store/searchStore')>(), searchDocument: vi.fn(),
}));
let host: HTMLDivElement, root: Root;
const pdf = () => ({ numPages: 3 }) as PDFDocumentProxy;
const found = (pageNumber: number): SearchResult[] => [{ pageNumber, matchIndex: 0, textContent: 'match' }];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers(); vi.mocked(searchDocument).mockReset();
  useSearchStore.getState().clearSearch();
  useSearchStore.getState().setOptions({ caseSensitive: false, wholeWord: false });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function query(value: string) {
  await act(async () => useSearchStore.getState().setQuery(value));
  await act(async () => vi.advanceTimersByTimeAsync(300));
}

describe('document search lifecycle', () => {
  it('cancels older queries and never lets a late result overwrite the current search or navigate', async () => {
    let resolveOld!: (results: SearchResult[]) => void;
    vi.mocked(searchDocument).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(found(2));
    const navigate = vi.fn();
    await act(async () => root.render(<SearchDialog document={pdf()} onNavigateToPage={navigate} onClose={vi.fn()} />));
    await query('old');
    const oldSignal = vi.mocked(searchDocument).mock.calls[0][3]!;
    await query('new');
    expect(oldSignal.aborted).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith(2);
    await act(async () => resolveOld(found(3)));
    expect(useSearchStore.getState().results[0].pageNumber).toBe(2);
    expect(navigate).not.toHaveBeenCalledWith(3);
    expect(host.textContent).toContain('1 of 1 matches');
  });

  it('invalidates results when the document changes, even if the old page finishes late', async () => {
    let resolveOld!: (results: SearchResult[]) => void;
    vi.mocked(searchDocument).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(found(1));
    const navigate = vi.fn();
    await act(async () => root.render(<SearchDialog document={pdf()} onNavigateToPage={navigate} onClose={vi.fn()} />));
    await query('match');
    await act(async () => root.render(<SearchDialog document={pdf()} onNavigateToPage={navigate} onClose={vi.fn()} />));
    await act(async () => resolveOld(found(3)));
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(navigate).toHaveBeenLastCalledWith(1);
    expect(navigate).not.toHaveBeenCalledWith(3);
  });

  it('supports one character, clears old hits immediately, and cancels on unmount', async () => {
    vi.mocked(searchDocument).mockResolvedValue(found(2));
    await act(async () => root.render(<SearchDialog document={pdf()} onNavigateToPage={vi.fn()} onClose={vi.fn()} />));
    await query('中');
    expect(vi.mocked(searchDocument).mock.calls[0][1]).toBe('中');
    expect(host.textContent).toContain('1 of 1 matches');
    await act(async () => useSearchStore.getState().setQuery(''));
    expect(useSearchStore.getState().results).toEqual([]);
    expect(host.textContent).not.toContain('matches');
    await query('next');
    const signal = vi.mocked(searchDocument).mock.calls.at(-1)![3]!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(useSearchStore.getState().isSearching).toBe(false);
  });

  it('reports extraction failures distinctly from an empty result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(searchDocument).mockRejectedValue(new Error('page unavailable'));
    await act(async () => root.render(<SearchDialog document={pdf()} onNavigateToPage={vi.fn()} onClose={vi.fn()} />));
    await query('text');
    expect(host.textContent).toContain('Unable to search this document');
    expect(host.textContent).not.toContain('No matches found');
    expect(useSearchStore.getState().isSearching).toBe(false);
  });
});
