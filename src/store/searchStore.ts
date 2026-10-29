import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildSearchText, findTextMatches } from '../utils/textSearch';

export interface SearchResult {
  pageNumber: number;
  matchIndex: number;
  textContent: string;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

interface SearchState {
  query: string;
  results: SearchResult[];
  currentResultIndex: number;
  isSearching: boolean;
  options: SearchOptions;

  // Actions
  setQuery: (query: string) => void;
  setResults: (results: SearchResult[]) => void;
  setCurrentResultIndex: (index: number) => void;
  setIsSearching: (isSearching: boolean) => void;
  setOptions: (options: Partial<SearchOptions>) => void;
  nextResult: () => void;
  previousResult: () => void;
  clearSearch: () => void;

  // Computed - get the current active result
  getCurrentResult: () => SearchResult | null;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  currentResultIndex: -1,
  isSearching: false,
  options: {
    caseSensitive: false,
    wholeWord: false,
  },

  setQuery: (query) => set({ query, results: [], currentResultIndex: -1, isSearching: Boolean(query) }),

  setResults: (results) => set({
    results,
    currentResultIndex: results.length > 0 ? 0 : -1,
  }),

  setCurrentResultIndex: (index) => set({ currentResultIndex: index }),

  setIsSearching: (isSearching) => set({ isSearching }),

  setOptions: (options) => set((state) => ({
    options: { ...state.options, ...options },
    results: [], currentResultIndex: -1, isSearching: Boolean(state.query),
  })),

  nextResult: () => set((state) => ({
    currentResultIndex:
      state.results.length > 0
        ? (state.currentResultIndex + 1) % state.results.length
        : -1,
  })),

  previousResult: () => set((state) => ({
    currentResultIndex:
      state.results.length > 0
        ? (state.currentResultIndex - 1 + state.results.length) % state.results.length
        : -1,
  })),

  clearSearch: () => set({
    query: '',
    results: [],
    currentResultIndex: -1,
    isSearching: false,
  }),

  getCurrentResult: () => {
    const state = get();
    if (state.currentResultIndex >= 0 && state.currentResultIndex < state.results.length) {
      return state.results[state.currentResultIndex];
    }
    return null;
  },
}));

export async function searchDocument(
  document: PDFDocumentProxy,
  query: string,
  options: SearchOptions,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const checkCancelled = () => { if (signal?.aborted) throw new DOMException('Search cancelled.', 'AbortError'); };
  checkCancelled();
  if (!query) return [];
  const results: SearchResult[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    checkCancelled();
    const page = await document.getPage(pageNumber);
    checkCancelled();
    const textContent = await page.getTextContent();
    checkCancelled();
    const { text } = buildSearchText(textContent.items);
    findTextMatches(text, query, options).forEach((match, matchIndex) => {
      results.push({ pageNumber, matchIndex, textContent: text.substring(Math.max(0, match.start - 20), Math.min(text.length, match.end + 20)) });
    });
  }
  return results;
}
