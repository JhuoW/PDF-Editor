import { useLocale, t } from "../../i18n";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePenLine } from 'lucide-react';
import { LanguageSwitcher } from '../Workspace/LanguageSwitcher';
import { useDocumentSessionStore } from '../../store/documentSession';
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
  navigationHost?: HTMLElement | null;
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
  navigationHost,
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
  useLocale();
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

  const fileName = useDocumentSessionStore(state => state.active?.fileName);
  const navigation = <div className="document-navigation">      {/* Center section - Navigation */}
      {hasDocument && (
        <>
          <div className="toolbar-group navigation">
            <button
              className="toolbar-btn icon-only"
              onClick={onPreviousPage}
              disabled={currentPage <= 1}
              title={t("m.previous.page.b09544")}
              aria-label={t("m.previous.page.81f547")}
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
                aria-label={t("m.page.number.8b08ca")}
                title={t("m.page.number.press.enter.to.navigate.b9f61b")}
                className="page-input"
              />
              <span className="page-separator">/</span>
              <span className="page-total">{totalPages}</span>
            </div>

            <button
              className="toolbar-btn icon-only"
              onClick={onNextPage}
              disabled={currentPage >= totalPages}
              title={t("m.next.page.6c68bf")}
              aria-label={t("m.next.page.4bfc19")}
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
              title={t("m.zoom.out.0a41b9")}
              aria-label={t("m.zoom.out.a4ae4b")}
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
              aria-label={t("m.zoom.9b3cbe")}
            >
              <option value="fit-page">
                {zoomMode === 'fit-page' ? t("m.fit.page.9a3439", { v0: Math.round(zoom * 100) }) : t("m.fit.page.0fa2ae")}
              </option>
              <option value="fit-width">
                {zoomMode === 'fit-width' ? t("m.fit.width.bae4b9", { v0: Math.round(zoom * 100) }) : t("m.fit.width.31ce6a")}
              </option>
              <optgroup label={t("m.zoom.9b3cbe")}>
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
              title={t("m.zoom.in.ff7033")}
              aria-label={t("m.zoom.in.4fc05f")}
            >
              <ZoomIn size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-page' ? 'active' : ''}`}
              onClick={onFitToPage}
              title={t("m.fit.to.page.05eb0e")}
              aria-label={t("m.fit.to.page.950c34")}
              aria-pressed={zoomMode === 'fit-page'}
            >
              <Maximize size={18} />
            </button>

            <button
              className={`toolbar-btn icon-only ${zoomMode === 'fit-width' ? 'active' : ''}`}
              onClick={onFitToWidth}
              title={t("m.fit.to.width.8abdd9")}
              aria-label={t("m.fit.to.width.4d6ed0")}
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
              title={t("m.single.page.view.f4b9e8")}
              aria-label={t("m.single.page.view.ece971")}
              aria-pressed={viewMode === 'single'}
            >
              <File size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'continuous' ? 'active' : ''}`}
              onClick={() => onSetViewMode('continuous')}
              title={t("m.continuous.view.cd3796")}
              aria-label={t("m.continuous.view.596640")}
              aria-pressed={viewMode === 'continuous'}
            >
              <Files size={18} />
            </button>
            <button
              className={`toolbar-btn icon-only ${viewMode === 'two-page' ? 'active' : ''}`}
              onClick={() => onSetViewMode('two-page')}
              title={t("m.two.page.view.210bf0")}
              aria-label={t("m.two.page.view.29330c")}
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
              title={t("m.rotate.clockwise.ctrl.r.31828f")}
              aria-label={t("m.rotate.clockwise.acf3bc")}
            >
              <RotateCw size={18} />
            </button>
          </div>

          <div className="toolbar-spacer" />

        </>
      )}
</div>;
  return <>
    <header className="main-toolbar">
      <div className="app-brand"><span className="app-brand-icon"><FilePenLine size={22} /></span><span>{t("m.pdf.editor.3bb8b8")}</span></div>
      {/* Sidebar toggle */}
      {hasDocument && (
        <>
          <div className="toolbar-group">
            <button
              className={`toolbar-btn icon-only ${sidebarOpen ? 'active' : ''}`}
              onClick={onToggleSidebar}
              title={t("m.toggle.sidebar.dffc47")}
              aria-label={t("m.toggle.sidebar.8b9b1b")}
              aria-pressed={sidebarOpen}
            >
              <PanelLeft size={18} />
            </button>
          </div>

          <div className="toolbar-divider" />
        </>
      )}

      {/* Left section - File operations */}
      <div className="toolbar-group">
        {(onCreatePDF || onExportPages) && <>
          <button ref={fileMenuButton} type="button" className="toolbar-btn" aria-expanded={!!menuPosition} aria-controls="toolbar-file-actions"
            onClick={() => menuPosition ? setMenuPosition(null) : openFileMenu()}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openFileMenu(); } }}>
            {t("m.file.2c3caf")}{' '}<ChevronDown size={14} />
          </button>
          {menuPosition && <div ref={fileMenu} id="toolbar-file-actions" role="group" aria-label={t("m.file.actions.9e1b94")} className="toolbar-file-actions"
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
            {onCreatePDF && <button type="button" onClick={() => selectFileAction(onCreatePDF)}>{t("m.create.pdf.from.images.74adad")}</button>}
            {onExportPages && <button type="button" disabled={!hasDocument} onClick={() => selectFileAction(onExportPages)}>{t("m.export.pages.8f8203")}</button>}
          </div>}
        </>}
        <button
          className="toolbar-btn"
          onClick={() => fileInputRef.current?.click()}
          title={t("m.open.pdf.ctrl.o.ce7388")} aria-label={t("m.open.cf9b77")}
        >
          <FileUp size={18} />
          <span className="btn-label">{t("m.open.cf9b77")}</span>
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
          title={t("m.export.download.pdf.ctrl.s.85da1f")} aria-label={t("m.export.f3e4fa")}
        >
          <Download size={18} />
          <span className="btn-label">{t("m.export.f3e4fa")}</span>
        </button>
      </div>




      <div className="document-title" data-document-content title={fileName}>{fileName ?? t("m.no.document.open.998af1")}</div>
      <div className="header-actions">
        {hasDocument && <button className="toolbar-btn icon-only" onClick={onToggleSearch} title={t("m.search.ctrl.f.2b439f")} aria-label={t("m.search.document.09bd84")}><Search size={18} /></button>}
        <LanguageSwitcher />
      </div>
    </header>
    {navigationHost ? createPortal(navigation, navigationHost) : navigation}
  </>;
}
