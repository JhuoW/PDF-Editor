import { useRef } from 'react';
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
            >
              <ChevronLeft size={18} />
            </button>

            <div className="page-indicator">
              <input
                type="number"
                min={1}
                max={totalPages}
                value={currentPage}
                onChange={(e) => onGoToPage(parseInt(e.target.value, 10))}
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
            >
              <option value="fit-page">
                {zoomMode === 'fit-page' ? `Fit Page (${Math.round(zoom * 100)}%)` : 'Fit Page'}
              </option>
              <option value="fit-width">
                {zoomMode === 'fit-width' ? `Fit Width (${Math.round(zoom * 100)}%)` : 'Fit Width'}
              </option>
              <optgroup label="Zoom">
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
            >
              <ZoomIn size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-page' ? 'active' : ''}`}
              onClick={onFitToPage}
              title="Fit to Page"
            >
              <Maximize size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-width' ? 'active' : ''}`}
              onClick={onFitToWidth}
              title="Fit to Width"
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
            >
              <File size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'continuous' ? 'active' : ''}`}
              onClick={() => onSetViewMode('continuous')}
              title="Continuous View"
            >
              <Files size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'two-page' ? 'active' : ''}`}
              onClick={() => onSetViewMode('two-page')}
              title="Two Page View"
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
            >
              <Search size={18} />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
