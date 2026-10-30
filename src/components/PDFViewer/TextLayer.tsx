import { useLocale } from "../../i18n";
import { useEffect, useRef } from 'react';
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
        const textContent = await page.getTextContent();

        if (cancelled) return;

        // Create text layer div
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        container.appendChild(textLayerDiv);

        const searchable = buildSearchText(textContent.items);
        const textSpans: Array<{ span: HTMLElement; start: number; end: number }> = [];
        // Keep each item's offset in the same page text used by the search store.
        for (const segment of searchable.segments) {
          const item = textContent.items[segment.itemIndex];
          if (!('str' in item) || !item.str) continue;

          const tx = item.transform;
          const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) * scale;
          const x = tx[4] * scale;
          const y = viewport.height - tx[5] * scale - fontHeight;

          const span = document.createElement('span');
          span.textContent = item.str;
          span.style.left = `${x}px`;
          span.style.top = `${y}px`;
          span.style.fontSize = `${fontHeight}px`;
          span.style.fontFamily = 'sans-serif';

          // Calculate width for proper selection
          if (item.width) {
            span.style.width = `${item.width * scale}px`;
          }

          textLayerDiv.appendChild(span);
          textSpans.push({ span, start: segment.start, end: segment.end });
        }

        // Apply search highlighting if query exists
        if (searchQuery && searchQuery.length > 0) {
          const isActivePage = activeMatchPage === page.pageNumber;
          const active = highlightSearchMatches(textSpans, findTextMatches(searchable.text, searchQuery, searchOptions), isActivePage ? activeMatchIndex : undefined);
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
  }, [page, scale, rotation, searchQuery, searchOptions, activeMatchPage, activeMatchIndex]);

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
