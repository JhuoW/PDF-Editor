import { useLocale, translateMessage, t, translateError } from "../../i18n";
import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getPDFOutline, type Outline } from '../../core/PDFDocument';
import './OutlinePanel.css';
interface OutlinePanelProps { document: PDFDocumentProxy; onNavigate: (destination: unknown) => void; onManage?: () => void; manageDisabled?: boolean }
function OutlineItem({ item, level, onNavigate }: { item: Outline; level: number; onNavigate: OutlinePanelProps['onNavigate'] }) {
  useLocale();
  const [expanded, setExpanded] = useState(item.expanded);
  const hasChildren = item.children.length > 0;
  const label = <><span className="outline-title" style={{ fontWeight: item.bold ? 700 : 400, fontStyle: item.italic ? 'italic' : 'normal', ...(item.color !== '#000000' ? { color: item.color } : {}) }}>{item.title}</span>{item.pageNumber && <span className="outline-page">{item.pageNumber}</span>}</>;
  return <li className="outline-item-wrapper">
    <div className="outline-item" style={{ paddingLeft: `${level * 16 + 8}px` }}>
      {hasChildren && <button type="button" className="outline-toggle" aria-label={`${translateMessage(expanded ? 'Collapse' : 'Expand')} ${item.title}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '▼' : '▶'}</button>}
      {item.url ? <a className="outline-action" href={item.url} target="_blank" rel="noopener noreferrer">{label}</a>
        : <button type="button" className="outline-action" title={item.unsupportedReason ? translateError(item.unsupportedReason) : item.title} disabled={!item.dest && !hasChildren} onClick={() => item.dest ? onNavigate(item.dest) : setExpanded(value => !value)}>{label}</button>}
    </div>
    {hasChildren && expanded && <ul className="outline-children">{item.children.map(child => <OutlineItem key={child.id} item={child} level={level + 1} onNavigate={onNavigate} />)}</ul>}
  </li>;
}
export function OutlinePanel({ document, onNavigate, onManage, manageDisabled }: OutlinePanelProps) {
  useLocale();
  const [result, setResult] = useState<{ document: PDFDocumentProxy; items: Outline[]; error?: string } | null>(null);
  const current = result?.document === document ? result : null;
  useEffect(() => {
    const request = new AbortController();
    void getPDFOutline(document, request.signal).then(items => { if (!request.signal.aborted) setResult({ document, items }); })
      .catch(error => { if (!request.signal.aborted) setResult({ document, items: [], error: error instanceof Error ? error.message : 'Could not load bookmarks.' }); });
    return () => request.abort();
  }, [document]);
  return <div className="outline-panel">
    <div className="outline-panel-header"><span>{t("m.bookmarks.ca3cdd")}</span>{onManage && <button type="button" disabled={manageDisabled} onClick={onManage}>{t("m.manage.791e88")}</button>}</div>
    <div className="outline-content">
      {!current && <div className="outline-loading" role="status">{t("m.loading.bookmarks.aa55ad")}</div>}
      {current?.error && <div className="outline-error" role="alert">{translateError(current.error)}</div>}
      {current && !current.error && (current.items.length ? <ul className="outline-tree" aria-label={t("m.bookmarks.ca3cdd")}>{current.items.map(item => <OutlineItem key={item.id} item={item} level={0} onNavigate={onNavigate} />)}</ul> : <div className="outline-empty">{t("m.no.bookmarks.available.510daa")}</div>)}
    </div>
  </div>;
}
