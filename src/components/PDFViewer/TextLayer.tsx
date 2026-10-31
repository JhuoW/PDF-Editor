import { textLayerGeometry } from '../../utils/textLayerGeometry';
import { SearchDocumentContext } from '../../utils/searchDocumentContext';
import { useLocale } from "../../i18n";
import { useContext, useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { useSearchStore } from '../../store/searchStore';
import { buildSearchText, findTextMatches, type TextMatch } from '../../utils/textSearch';
import './TextLayer.css';

interface TextLayerProps {
  page: PDFPageProxy;
  scale: number;
  rotation: number;
  searchQuery?: string;
  activeMatchPage?: number;
  activeMatchIndex?: number;
}

export function TextLayer({
  page,
  scale,
  rotation,
  searchQuery,
  activeMatchPage,
  activeMatchIndex,
}: TextLayerProps) {
  useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchOptions = useSearchStore(state => state.options);
  const source = useContext(SearchDocumentContext);
  const storeQuery = useSearchStore(state => state.query), searching = useSearchStore(state => state.isSearching);
  const activeResult = useSearchStore(state => state.results[state.currentResultIndex]);
  const query = searching || (source && !source.ready) ? '' : searchQuery ?? storeQuery;
  const activePage = activeMatchPage ?? activeResult?.pageNumber, activeIndex = activeMatchIndex ?? activeResult?.matchIndex;
  const searchPDF = source?.ready && query ? source.document : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !page) return;

    // Clear previous content
    container.innerHTML = '';

    // Calculate effective rotation (page's embedded rotation + view rotation)
    const effectiveRotation = getEffectiveRotation(page, rotation);
    const viewport = page.getViewport({ scale, rotation: effectiveRotation });

    // Set container dimensions
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    let cancelled = false;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;

    const renderTextLayer = async () => {
      try {
        const textPage = searchPDF ? await searchPDF.getPage(page.pageNumber) : page;
        if (cancelled) return;
        const textContent = await textPage.getTextContent();

        if (cancelled) return;

        // Create text layer div
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        container.appendChild(textLayerDiv);

        const searchable = buildSearchText(textContent.items);
        const textSpans: Array<{ span: HTMLElement; start: number; end: number }> = [];
        const measure = typeof CanvasRenderingContext2D === 'undefined' ? null : document.createElement('canvas').getContext('2d');
        // Keep each item's offset in the same page text used by the search store.
        for (const segment of searchable.segments) {
          const item = textContent.items[segment.itemIndex];
          if (!('str' in item) || !item.str) continue;

          const style = textContent.styles?.[item.fontName];
          const geometry = textLayerGeometry(item, { transform: viewport.transform ?? [scale, 0, 0, -scale, 0, viewport.height] }, style);
          const span = document.createElement('span');
          span.textContent = item.str;
          span.style.left = `${geometry.left}px`;
          span.style.top = `${geometry.top}px`;
          span.style.fontSize = `${geometry.height}px`;
          span.style.fontFamily = style?.fontFamily ?? 'sans-serif';
          // Match the extracted glyph advance even if the selection layer uses a browser fallback font.
          if (measure) measure.font = `${geometry.height}px ${span.style.fontFamily}`;
          const measured = measure?.measureText(item.str).width;
          span.style.transform = `rotate(${geometry.angle}rad) scaleX(${measured && geometry.width ? geometry.width / measured : 1})`;
          span.style.width = `${measured || geometry.width}px`;

          textLayerDiv.appendChild(span);
          textSpans.push({ span, start: segment.start, end: segment.end });
        }

        // Apply search highlighting if query exists
        if (query) {
          const isActivePage = activePage === page.pageNumber;
          const active = highlightSearchMatches(textSpans, findTextMatches(searchable.text, query, searchOptions), isActivePage ? activeIndex : undefined);
          if (active) scrollTimer = setTimeout(() => {
            if (!cancelled && active.isConnected) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error rendering text layer:', error);
        }
      }
    };

    renderTextLayer();

    return () => {
      cancelled = true;
      clearTimeout(scrollTimer);
    };
  }, [page, scale, rotation, query, searchOptions, activePage, activeIndex, searchPDF]);

  return <div ref={containerRef} className="text-layer-container" />;
}

function highlightSearchMatches(
  spans: Array<{ span: HTMLElement; start: number; end: number }>,
  matches: TextMatch[],
  activeMatchIndex?: number
): HTMLElement | undefined {
  let firstMatch = 0, active: HTMLElement | undefined;
  for (const { span, start, end } of spans) {
    while (firstMatch < matches.length && matches[firstMatch].end <= start) firstMatch++;
    if (firstMatch >= matches.length || matches[firstMatch].start >= end) continue;
    const text = span.textContent ?? '', fragment = document.createDocumentFragment();
    let cursor = start;
    for (let index = firstMatch; index < matches.length && matches[index].start < end; index++) {
      const from = Math.max(start, matches[index].start), to = Math.min(end, matches[index].end);
      if (from > cursor) fragment.append(document.createTextNode(text.slice(cursor - start, from - start)));
      const highlight = document.createElement('mark');
      highlight.className = index === activeMatchIndex ? 'search-highlight active' : 'search-highlight';
      highlight.textContent = text.slice(from - start, to - start); fragment.append(highlight);
      if (index === activeMatchIndex && !active) active = highlight;
      cursor = to;
    }
    if (cursor < end) fragment.append(document.createTextNode(text.slice(cursor - start)));
    span.replaceChildren(fragment);
  }
  return active;
}
