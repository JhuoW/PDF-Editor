import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useSearchStore, searchDocument, type SearchOptions, type SearchResult } from '../../store/searchStore';
import './SearchDialog.css';

interface SearchDialogProps {
  document: PDFDocumentProxy;
  onNavigateToPage: (page: number) => void;
  onClose: () => void;
}

interface CompletedSearch {
  document: PDFDocumentProxy;
  query: string;
  options: SearchOptions;
  results: SearchResult[];
  error?: string;
}

export function SearchDialog({ document, onNavigateToPage, onClose }: SearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [completed, setCompleted] = useState<CompletedSearch | null>(null);
  const {
    query, results, currentResultIndex, isSearching, options,
    setQuery, setResults, setIsSearching, setOptions, nextResult, previousResult,
  } = useSearchStore();
  const isCurrent = completed?.document === document && completed.query === query && completed.options === options;
  const currentResults = isCurrent && completed.results === results ? results : [];

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    setIsSearching(Boolean(query));
    const timer = setTimeout(async () => {
      if (!query) return;
      try {
        const found = await searchDocument(document, query, options, controller.signal);
        if (controller.signal.aborted) return;
        setResults(found);
        setCompleted({ document, query, options, results: found });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Search error:', error);
        const empty: SearchResult[] = [];
        setResults(empty);
        setCompleted({ document, query, options, results: empty, error: 'Unable to search this document. Change the query to retry.' });
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
      setIsSearching(false);
    };
  }, [document, query, options, setResults, setIsSearching]);

  useEffect(() => {
    if (!isCurrent || completed.results !== results) return;
    const result = results[currentResultIndex];
    if (result) onNavigateToPage(result.pageNumber);
  }, [isCurrent, completed, currentResultIndex, results, onNavigateToPage]);

  return (
    <div className="search-dialog" role="search" aria-label="Document search" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    }}>
      <div className="search-input-row">
        <input
          ref={inputRef}
          type="text"
          aria-label="Search document text"
          placeholder="Search in document..."
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (currentResults.length) {
                if (event.shiftKey) previousResult();
                else nextResult();
              }
            }
          }}
          className="search-input"
        />
        <button onClick={previousResult} disabled={!currentResults.length} className="search-nav-btn" title="Previous (Shift+Enter)" aria-label="Previous search result">↑</button>
        <button onClick={nextResult} disabled={!currentResults.length} className="search-nav-btn" title="Next (Enter)" aria-label="Next search result">↓</button>
        <button onClick={onClose} className="search-close-btn" title="Close (Esc)" aria-label="Close search">✕</button>
      </div>
      <div className="search-options">
        <label className="search-option">
          <input type="checkbox" checked={options.caseSensitive} onChange={event => setOptions({ caseSensitive: event.target.checked })} />
          <span>Match case</span>
        </label>
        <label className="search-option">
          <input type="checkbox" checked={options.wholeWord} onChange={event => setOptions({ wholeWord: event.target.checked })} />
          <span>Whole word</span>
        </label>
      </div>
      <div className="search-status" role="status" aria-live="polite">
        {query && (isSearching || !isCurrent ? 'Searching...' : completed.error || (
          currentResults.length ? `${currentResultIndex + 1} of ${currentResults.length} matches` : 'No matches found'
        ))}
      </div>
    </div>
  );
}
