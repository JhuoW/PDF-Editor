import { useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getEffectiveRotation } from '../../core/PDFRenderer';
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
  const containerRef = useRef<HTMLDivElement>(null);

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

    const renderTextLayer = async () => {
      try {
        const textContent = await page.getTextContent();

        if (cancelled) return;

        // Create text layer div
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        container.appendChild(textLayerDiv);

        // Render text items manually
        for (const item of textContent.items) {
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
        }

        // Apply search highlighting if query exists
        if (searchQuery && searchQuery.length > 0) {
          const isActivePage = activeMatchPage === page.pageNumber;
          highlightSearchMatches(
            textLayerDiv,
            searchQuery,
            isActivePage ? activeMatchIndex : undefined
          );
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
    };
  }, [page, scale, rotation, searchQuery, activeMatchPage, activeMatchIndex]);

  return <div ref={containerRef} className="text-layer-container" />;
}

function highlightSearchMatches(
  container: HTMLElement,
  query: string,
  activeMatchIndex?: number
): void {
  const textSpans = container.querySelectorAll('span');
  const lowerQuery = query.toLowerCase();
  let globalMatchIndex = 0;

  textSpans.forEach((span) => {
    const text = span.textContent || '';
    const lowerText = text.toLowerCase();

    // Find all matches in this span
    const fragments: Array<{ text: string; isMatch: boolean; isActive: boolean }> = [];
    let lastIndex = 0;
    let searchIndex = 0;

    while ((searchIndex = lowerText.indexOf(lowerQuery, lastIndex)) !== -1) {
      // Add text before the match
      if (searchIndex > lastIndex) {
        fragments.push({
          text: text.substring(lastIndex, searchIndex),
          isMatch: false,
          isActive: false,
        });
      }

      // Add the match
      const isActive = globalMatchIndex === activeMatchIndex;
      fragments.push({
        text: text.substring(searchIndex, searchIndex + query.length),
        isMatch: true,
        isActive,
      });

      globalMatchIndex++;
      lastIndex = searchIndex + query.length;
    }

    // Add remaining text after last match
    if (lastIndex < text.length) {
      fragments.push({
        text: text.substring(lastIndex),
        isMatch: false,
        isActive: false,
      });
    }

    // If we found matches, rebuild the span content
    if (fragments.length > 0 && fragments.some((f) => f.isMatch)) {
      span.innerHTML = '';

      fragments.forEach((fragment) => {
        if (fragment.isMatch) {
          const highlight = document.createElement('mark');
          highlight.className = fragment.isActive
            ? 'search-highlight active'
            : 'search-highlight';
          highlight.textContent = fragment.text;
          span.appendChild(highlight);

          // Scroll active match into view
          if (fragment.isActive) {
            setTimeout(() => {
              highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 100);
          }
        } else {
          span.appendChild(document.createTextNode(fragment.text));
        }
      });
    }
  });
}
