import { useCallback, useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useSearchStore, searchDocument } from '../../store/searchStore';
import './SearchDialog.css';

interface SearchDialogProps {
  document: PDFDocumentProxy;
  onNavigateToPage: (page: number) => void;
  onClose: () => void;
}

export function SearchDialog({ document, onNavigateToPage, onClose }: SearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    query,
    results,
    currentResultIndex,
    isSearching,
    options,
    setQuery,
    setResults,
    setIsSearching,
    setOptions,
    nextResult,
    previousResult,
  } = useSearchStore();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const searchResults = await searchDocument(document, query, options);
      setResults(searchResults);
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [document, query, options, setResults, setIsSearching]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      if (query.length >= 2) {
        handleSearch();
      } else {
        setResults([]);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [query, options, handleSearch, setResults]);

  useEffect(() => {
    if (results.length > 0 && currentResultIndex >= 0) {
      const result = results[currentResultIndex];
      onNavigateToPage(result.pageNumber);
    }
  }, [currentResultIndex, results, onNavigateToPage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          previousResult();
        } else {
          nextResult();
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [nextResult, previousResult, onClose]
  );

  return (
    <div className="search-dialog">
      <div className="search-input-row">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search in document..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="search-input"
        />
        <button
          onClick={previousResult}
          disabled={results.length === 0}
          className="search-nav-btn"
          title="Previous (Shift+Enter)"
        >
          ↑
        </button>
        <button
          onClick={nextResult}
          disabled={results.length === 0}
          className="search-nav-btn"
          title="Next (Enter)"
        >
          ↓
        </button>
        <button onClick={onClose} className="search-close-btn" title="Close (Esc)">
          ✕
        </button>
      </div>

      <div className="search-options">
        <label className="search-option">
          <input
            type="checkbox"
            checked={options.caseSensitive}
            onChange={(e) => setOptions({ caseSensitive: e.target.checked })}
          />
          <span>Match case</span>
        </label>
        <label className="search-option">
          <input
            type="checkbox"
            checked={options.wholeWord}
            onChange={(e) => setOptions({ wholeWord: e.target.checked })}
          />
          <span>Whole word</span>
        </label>
      </div>

      <div className="search-status">
        {isSearching ? (
          <span>Searching...</span>
        ) : results.length > 0 ? (
          <span>
            {currentResultIndex + 1} of {results.length} matches
          </span>
        ) : query.length >= 2 ? (
          <span>No matches found</span>
        ) : query.length > 0 ? (
          <span>Enter at least 2 characters</span>
        ) : null}
      </div>
    </div>
  );
}
