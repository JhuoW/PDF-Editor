import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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

  setQuery: (query) => set({ query }),

  setResults: (results) => set({
    results,
    currentResultIndex: results.length > 0 ? 0 : -1,
  }),

  setCurrentResultIndex: (index) => set({ currentResultIndex: index }),

  setIsSearching: (isSearching) => set({ isSearching }),

  setOptions: (options) => set((state) => ({
    options: { ...state.options, ...options },
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
  options: SearchOptions
): Promise<SearchResult[]> {
  if (!query || query.length === 0) return [];

  const results: SearchResult[] = [];
  const searchQuery = options.caseSensitive ? query : query.toLowerCase();

  for (let pageNum = 1; pageNum <= document.numPages; pageNum++) {
    const page = await document.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageText = '';
    for (const item of textContent.items) {
      if ('str' in item) {
        pageText += item.str;
      }
    }

    const textToSearch = options.caseSensitive ? pageText : pageText.toLowerCase();

    let matchIndex = 0;
    let startIndex = 0;
    while ((startIndex = textToSearch.indexOf(searchQuery, startIndex)) !== -1) {
      // Check whole word if option is enabled
      if (options.wholeWord) {
        const beforeChar = startIndex > 0 ? textToSearch[startIndex - 1] : ' ';
        const afterChar = startIndex + searchQuery.length < textToSearch.length
          ? textToSearch[startIndex + searchQuery.length]
          : ' ';

        if (!/\W/.test(beforeChar) || !/\W/.test(afterChar)) {
          startIndex++;
          continue;
        }
      }

      results.push({
        pageNumber: pageNum,
        matchIndex: matchIndex++,
        textContent: pageText.substring(
          Math.max(0, startIndex - 20),
          Math.min(pageText.length, startIndex + query.length + 20)
        ),
      });
      startIndex++;
    }
  }

  return results;
}
