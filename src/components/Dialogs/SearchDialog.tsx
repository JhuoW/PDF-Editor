import { SearchDocumentContext } from '../../utils/searchDocumentContext';
import { ErrorMessage } from '../Feedback/ErrorMessage';
import { translateMessage } from '../../i18n';
import { useLocale, t } from "../../i18n";
import { useContext, useEffect, useRef, useState } from 'react';
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
  useLocale();
  const source = useContext(SearchDocumentContext);
  const searchable = source ? source.document : document;
  const inputRef = useRef<HTMLInputElement>(null);
  const [completed, setCompleted] = useState<CompletedSearch | null>(null);
  const {
    query, results, currentResultIndex, isSearching, options,
    setQuery, setResults, setIsSearching, setOptions, nextResult, previousResult,
  } = useSearchStore();
  const isCurrent = !!searchable && completed?.document === searchable && completed.query === query && completed.options === options;
  const currentResults = isCurrent && completed.results === results ? results : [];

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    setIsSearching(Boolean(query) && !source?.error);
    const timer = setTimeout(async () => {
      if (!query || !searchable) return;
      try {
        const found = await searchDocument(searchable, query, options, controller.signal);
        if (controller.signal.aborted) return;
        setResults(found);
        setCompleted({ document: searchable, query, options, results: found });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Search error:', error);
        const empty: SearchResult[] = [];
        setResults(empty);
        setCompleted({ document: searchable, query, options, results: empty, error: 'Unable to search this document. Change the query to retry.' });
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
      setIsSearching(false);
    };
  }, [searchable, source?.error, query, options, setResults, setIsSearching]);

  useEffect(() => {
    if (!isCurrent || completed.results !== results) return;
    const result = results[currentResultIndex];
    if (result) onNavigateToPage(result.pageNumber);
  }, [isCurrent, completed, currentResultIndex, results, onNavigateToPage]);

  return (
    <div className="search-dialog" role="search" aria-label={t("m.document.search.ef750f")} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    }}>
      <div className="search-input-row">
        <input
          ref={inputRef}
          type="text"
          aria-label={t("m.search.document.text.b75d58")}
          placeholder={t("m.search.in.document.afd43a")}
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
        <button onClick={previousResult} disabled={!currentResults.length} className="search-nav-btn" title={t("m.previous.shift.enter.fac0d0")} aria-label={t("m.previous.search.result.6ec78d")}>↑</button>
        <button onClick={nextResult} disabled={!currentResults.length} className="search-nav-btn" title={t("m.next.enter.fb0aa7")} aria-label={t("m.next.search.result.b2c6a2")}>↓</button>
        <button onClick={onClose} className="search-close-btn" title={t("m.close.esc.6ae84e")} aria-label={t("m.close.search.0906f9")}>✕</button>
      </div>
      <div className="search-options">
        <label className="search-option">
          <input type="checkbox" checked={options.caseSensitive} onChange={event => setOptions({ caseSensitive: event.target.checked })} />
          <span>{t("m.match.case.d18bbf")}</span>
        </label>
        <label className="search-option">
          <input type="checkbox" checked={options.wholeWord} onChange={event => setOptions({ wholeWord: event.target.checked })} />
          <span>{t("m.whole.word.6171b6")}</span>
        </label>
      </div>
      <div className="search-status" role="status" aria-live="polite">
        {query && (source?.error ? t('search.editsFailed') : isSearching || !isCurrent ? t("m.searching.ba2b5a") : translateMessage(completed.error) || (
          currentResults.length ? t("m.of.matches.749f03", { v0: currentResultIndex + 1, v1: currentResults.length }) : t("m.no.matches.found.a68d28")
        ))}
      </div>
      {!!source?.error && <div className="search-index-error"><ErrorMessage error={source.error} operation="Search edited PDF" /><button onClick={source.retry}>{t('search.retry')}</button></div>}
    </div>
  );
}
