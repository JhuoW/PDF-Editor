import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getPDFOutline, type Outline } from '../../core/PDFDocument';
import './OutlinePanel.css';

interface OutlinePanelProps {
  document: PDFDocumentProxy;
  onPageSelect: (page: number) => void;
}

interface OutlineItemProps {
  item: Outline;
  level: number;
  onPageSelect: (page: number) => void;
}

function OutlineItem({ item, level, onPageSelect }: OutlineItemProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.children && item.children.length > 0;

  return (
    <div className="outline-item-wrapper">
      <div
        className="outline-item"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onPageSelect(item.pageNumber)}
      >
        {hasChildren && (
          <button
            className="outline-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? '▼' : '▶'}
          </button>
        )}
        <span className="outline-title">{item.title}</span>
        <span className="outline-page">{item.pageNumber}</span>
      </div>
      {hasChildren && expanded && (
        <div className="outline-children">
          {item.children!.map((child, index) => (
            <OutlineItem
              key={`${child.title}-${index}`}
              item={child}
              level={level + 1}
              onPageSelect={onPageSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OutlinePanel({ document, onPageSelect }: OutlinePanelProps) {
  const [outline, setOutline] = useState<Outline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!document) return;

    const loadOutline = async () => {
      setLoading(true);
      setError(null);
      try {
        const outlineData = await getPDFOutline(document);
        setOutline(outlineData);
      } catch (err) {
        setError('Failed to load outline');
        console.error('Error loading outline:', err);
      } finally {
        setLoading(false);
      }
    };

    loadOutline();
  }, [document]);

  return (
    <div className="outline-panel">
      <div className="outline-panel-header">
        <span>Bookmarks</span>
      </div>
      <div className="outline-content">
        {loading && <div className="outline-loading">Loading...</div>}
        {error && <div className="outline-error">{error}</div>}
        {!loading && !error && outline.length === 0 && (
          <div className="outline-empty">No bookmarks available</div>
        )}
        {!loading && !error && outline.length > 0 && (
          <div className="outline-tree">
            {outline.map((item, index) => (
              <OutlineItem
                key={`${item.title}-${index}`}
                item={item}
                level={0}
                onPageSelect={onPageSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
