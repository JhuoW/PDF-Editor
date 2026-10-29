import { useEffect, useRef, useState } from 'react';
import {
  FileUp,
  Download,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Search,
  PanelLeft,
  Columns,
  File,
  Files,
  Maximize,
  MoveHorizontal,
  ChevronDown,
} from 'lucide-react';
import type { ZoomMode } from '../../store/documentStore';
import './MainToolbar.css';

interface MainToolbarProps {
  currentPage: number;
  totalPages: number;
  zoom: number;
  zoomMode: ZoomMode;
  viewMode: 'single' | 'continuous' | 'two-page';
  sidebarOpen: boolean;
  onOpenFile: (file: File) => void;
  onExport: () => void;
  onCreatePDF?: () => void;
  onExportPages?: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGoToPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetZoom: (zoom: number) => void;
  onFitToPage: () => void;
  onFitToWidth: () => void;
  onRotate: () => void;
  onToggleSidebar: () => void;
  onSetViewMode: (mode: 'single' | 'continuous' | 'two-page') => void;
  onToggleSearch: () => void;
  hasDocument: boolean;
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function MainToolbar({
  currentPage,
  totalPages,
  zoom,
  zoomMode,
  viewMode,
  sidebarOpen,
  onOpenFile,
  onExport,
  onCreatePDF,
  onExportPages,
  onPreviousPage,
  onNextPage,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onSetZoom,
  onFitToPage,
  onFitToWidth,
  onRotate,
  onToggleSidebar,
  onSetViewMode,
  onToggleSearch,
  hasDocument,
}: MainToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileMenuButton = useRef<HTMLButtonElement>(null);
  const fileMenu = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [pageDraft, setPageDraft] = useState({ page: currentPage, value: String(currentPage) });

  const openFileMenu = () => {
    const bounds = fileMenuButton.current?.getBoundingClientRect();
    if (bounds) setMenuPosition({ top: bounds.bottom + 5, left: Math.max(8, Math.min(bounds.left, window.innerWidth - 252)) });
  };
  useEffect(() => {
    if (!menuPosition) return;
    fileMenu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!fileMenu.current?.contains(event.target as Node) && !fileMenuButton.current?.contains(event.target as Node)) setMenuPosition(null);
    };
    const reposition = () => setMenuPosition(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', reposition);
    };
  }, [menuPosition]);

  const selectFileAction = (action?: () => void) => {
    setMenuPosition(null);
    fileMenuButton.current?.focus();
    action?.();
  };

  // Keep external navigation in sync without replacing an unfinished input on every render.
  if (pageDraft.page !== currentPage) {
    setPageDraft({ page: currentPage, value: String(currentPage) });
  }

  const resetPageDraft = () => {
    setPageDraft({ page: currentPage, value: String(currentPage) });
  };

  const commitPageDraft = () => {
    const page = Number(pageDraft.value);
    if (Number.isInteger(page) && page >= 1 && page <= totalPages) {
      setPageDraft({ page: currentPage, value: String(page) });
      if (page !== currentPage) onGoToPage(page);
    } else {
      resetPageDraft();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onOpenFile(file);
    }
    e.target.value = '';
  };

  return (
    <header className="main-toolbar">
      {/* Left section - File operations */}
      <div className="toolbar-group">
        {(onCreatePDF || onExportPages) && <>
          <button ref={fileMenuButton} type="button" className="toolbar-btn" aria-expanded={!!menuPosition} aria-controls="toolbar-file-actions"
            onClick={() => menuPosition ? setMenuPosition(null) : openFileMenu()}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openFileMenu(); } }}>
            File <ChevronDown size={14} />
          </button>
          {menuPosition && <div ref={fileMenu} id="toolbar-file-actions" role="group" aria-label="File actions" className="toolbar-file-actions"
            style={{ ...menuPosition, maxHeight: `calc(100dvh - ${menuPosition.top + 8}px)` }}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== fileMenuButton.current) setMenuPosition(null);
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); selectFileAction(); }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const buttons = [...(fileMenu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
              }
            }}>
            {onCreatePDF && <button type="button" onClick={() => selectFileAction(onCreatePDF)}>Create PDF from Images…</button>}
            {onExportPages && <button type="button" disabled={!hasDocument} onClick={() => selectFileAction(onExportPages)}>Export Pages…</button>}
          </div>}
        </>}
        <button
          className="toolbar-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Open PDF (Ctrl+O)"
        >
          <FileUp size={18} />
          <span className="btn-label">Open</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <button
          className="toolbar-btn toolbar-btn-primary"
          onClick={onExport}
          disabled={!hasDocument}
          title="Export / Download PDF (Ctrl+S)"
        >
          <Download size={18} />
          <span className="btn-label">Export</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Sidebar toggle */}
      {hasDocument && (
        <>
          <div className="toolbar-group">
            <button
              className={`toolbar-btn icon-only ${sidebarOpen ? 'active' : ''}`}
              onClick={onToggleSidebar}
              title="Toggle Sidebar"
              aria-label="Toggle sidebar"
              aria-pressed={sidebarOpen}
            >
              <PanelLeft size={18} />
            </button>
          </div>

          <div className="toolbar-divider" />
        </>
      )}

      {/* Center section - Navigation */}
      {hasDocument && (
        <>
          <div className="toolbar-group navigation">
            <button
              className="toolbar-btn icon-only"
              onClick={onPreviousPage}
              disabled={currentPage <= 1}
              title="Previous Page (←)"
              aria-label="Previous page"
            >
              <ChevronLeft size={18} />
            </button>

            <div className="page-indicator">
              <input
                type="number"
                min={1}
                max={totalPages}
                value={pageDraft.value}
                onChange={(e) => setPageDraft({ page: currentPage, value: e.target.value })}
                onBlur={commitPageDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitPageDraft();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    resetPageDraft();
                  }
                }}
                aria-label="Page number"
                title="Page number (press Enter to navigate)"
                className="page-input"
              />
              <span className="page-separator">/</span>
              <span className="page-total">{totalPages}</span>
            </div>

            <button
              className="toolbar-btn icon-only"
              onClick={onNextPage}
              disabled={currentPage >= totalPages}
              title="Next Page (→)"
              aria-label="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="toolbar-divider" />

          {/* Zoom controls */}
          <div className="toolbar-group zoom">
            <button
              className="toolbar-btn icon-only"
              onClick={onZoomOut}
              title="Zoom Out (-)"
              aria-label="Zoom out"
            >
              <ZoomOut size={18} />
            </button>

            <select
              value={zoomMode === 'manual' ? zoom : zoomMode}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'fit-page') {
                  onFitToPage();
                } else if (value === 'fit-width') {
                  onFitToWidth();
                } else {
                  onSetZoom(parseFloat(value));
                }
              }}
              className="zoom-select"
              aria-label="Zoom"
            >
              <option value="fit-page">
                {zoomMode === 'fit-page' ? `Fit Page (${Math.round(zoom * 100)}%)` : 'Fit Page'}
              </option>
              <option value="fit-width">
                {zoomMode === 'fit-width' ? `Fit Width (${Math.round(zoom * 100)}%)` : 'Fit Width'}
              </option>
              <optgroup label="Zoom">
                {zoomMode === 'manual' && !ZOOM_PRESETS.includes(zoom) && (
                  <option value={zoom}>{Math.round(zoom * 100)}%</option>
                )}
                {ZOOM_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {Math.round(preset * 100)}%
                  </option>
                ))}
              </optgroup>
            </select>

            <button
              className="toolbar-btn icon-only"
              onClick={onZoomIn}
              title="Zoom In (+)"
              aria-label="Zoom in"
            >
              <ZoomIn size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-page' ? 'active' : ''}`}
              onClick={onFitToPage}
              title="Fit to Page"
              aria-label="Fit to page"
              aria-pressed={zoomMode === 'fit-page'}
            >
              <Maximize size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-width' ? 'active' : ''}`}
              onClick={onFitToWidth}
              title="Fit to Width"
              aria-label="Fit to width"
              aria-pressed={zoomMode === 'fit-width'}
            >
              <MoveHorizontal size={18} />
            </button>
          </div>

          <div className="toolbar-divider" />

          {/* View mode */}
          <div className="toolbar-group view-mode">
            <button
              className={`toolbar-btn icon-only ${viewMode === 'single' ? 'active' : ''}`}
              onClick={() => onSetViewMode('single')}
              title="Single Page View"
              aria-label="Single page view"
              aria-pressed={viewMode === 'single'}
            >
              <File size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'continuous' ? 'active' : ''}`}
              onClick={() => onSetViewMode('continuous')}
              title="Continuous View"
              aria-label="Continuous view"
              aria-pressed={viewMode === 'continuous'}
            >
              <Files size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'two-page' ? 'active' : ''}`}
              onClick={() => onSetViewMode('two-page')}
              title="Two Page View"
              aria-label="Two page view"
              aria-pressed={viewMode === 'two-page'}
            >
              <Columns size={18} />
            </button>
          </div>

          <div className="toolbar-divider" />

          {/* Right section - Tools */}
          <div className="toolbar-group">
            <button
              className="toolbar-btn icon-only"
              onClick={onRotate}
              title="Rotate Clockwise (Ctrl+R)"
              aria-label="Rotate clockwise"
            >
              <RotateCw size={18} />
            </button>
          </div>

          <div className="toolbar-spacer" />

          {/* Search */}
          <div className="toolbar-group">
            <button
              className="toolbar-btn icon-only"
              onClick={onToggleSearch}
              title="Search (Ctrl+F)"
              aria-label="Search document"
            >
              <Search size={18} />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
