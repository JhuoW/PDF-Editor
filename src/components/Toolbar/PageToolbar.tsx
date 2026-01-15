import { useState } from 'react';
import './PageToolbar.css';

interface PageToolbarProps {
  currentPage: number;
  totalPages: number;
  selectedPages: number[];
  onRotatePages: (pages: number[], degrees: 90 | -90 | 180) => void;
  onDeletePages: (pages: number[]) => void;
  onInsertBlankPage: (position: number) => void;
  onInsertFromFile: (position: number) => void;
  onMerge: () => void;
  onSplit: () => void;
  onExport: () => void;
  hasDocument: boolean;
  // Undo/Redo
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoActionName?: string | null;
  redoActionName?: string | null;
  // Document actions
  onResetToOriginal: () => void;
  onCloseDocument: () => void;
  canResetToOriginal: boolean;
}

export function PageToolbar({
  currentPage,
  totalPages,
  selectedPages,
  onRotatePages,
  onDeletePages,
  onInsertBlankPage,
  onInsertFromFile,
  onMerge,
  onSplit,
  onExport,
  hasDocument,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  undoActionName,
  redoActionName,
  onResetToOriginal,
  onCloseDocument,
  canResetToOriginal,
}: PageToolbarProps) {
  const [showInsertMenu, setShowInsertMenu] = useState(false);

  const pagesToOperate = selectedPages.length > 0 ? selectedPages : [currentPage];
  const pageLabel = selectedPages.length > 1
    ? `${selectedPages.length} pages`
    : `page ${currentPage}`;

  const handleRotateCW = () => {
    onRotatePages(pagesToOperate, 90);
  };

  const handleRotateCCW = () => {
    onRotatePages(pagesToOperate, -90);
  };

  const handleRotate180 = () => {
    onRotatePages(pagesToOperate, 180);
  };

  const handleDelete = () => {
    if (totalPages <= pagesToOperate.length) {
      alert('Cannot delete all pages');
      return;
    }
    const confirmMsg = selectedPages.length > 1
      ? `Delete ${selectedPages.length} selected pages?`
      : `Delete page ${currentPage}?`;
    if (confirm(confirmMsg)) {
      onDeletePages(pagesToOperate);
    }
  };

  const handleInsertBlankBefore = () => {
    onInsertBlankPage(currentPage);
    setShowInsertMenu(false);
  };

  const handleInsertBlankAfter = () => {
    onInsertBlankPage(currentPage + 1);
    setShowInsertMenu(false);
  };

  const handleInsertBlankAtEnd = () => {
    onInsertBlankPage(0);  // 0 means at end
    setShowInsertMenu(false);
  };

  const handleInsertFromFileBefore = () => {
    onInsertFromFile(currentPage);
    setShowInsertMenu(false);
  };

  const handleInsertFromFileAfter = () => {
    onInsertFromFile(currentPage + 1);
    setShowInsertMenu(false);
  };

  return (
    <div className="page-toolbar">
      <div className="page-toolbar-group">
        <button
          className="page-toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={undoActionName ? `Undo ${undoActionName} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
        >
          ↶ Undo
        </button>
        <button
          className="page-toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoActionName ? `Redo ${redoActionName} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}
        >
          ↷ Redo
        </button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <span className="page-toolbar-label">Document:</span>
        <button
          className="page-toolbar-btn"
          onClick={onMerge}
          title="Merge PDFs"
        >
          Merge
        </button>
        <button
          className="page-toolbar-btn"
          onClick={onSplit}
          disabled={!hasDocument}
          title="Split PDF"
        >
          Split
        </button>
        <button
          className="page-toolbar-btn"
          onClick={onExport}
          disabled={!hasDocument}
          title="Export/Download PDF"
        >
          Export
        </button>
        <button
          className="page-toolbar-btn"
          onClick={onResetToOriginal}
          disabled={!canResetToOriginal}
          title="Reset to Original - Discard all changes"
        >
          ⟲ Reset
        </button>
        <button
          className="page-toolbar-btn page-toolbar-btn-danger"
          onClick={onCloseDocument}
          disabled={!hasDocument}
          title="Close Document"
        >
          ✕ Close
        </button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <span className="page-toolbar-label">
          {selectedPages.length > 1 ? `${selectedPages.length} selected:` : 'Page:'}
        </span>
        <button
          className="page-toolbar-btn"
          onClick={handleRotateCCW}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 90° counter-clockwise`}
        >
          ↺ 90°
        </button>
        <button
          className="page-toolbar-btn"
          onClick={handleRotateCW}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 90° clockwise`}
        >
          ↻ 90°
        </button>
        <button
          className="page-toolbar-btn"
          onClick={handleRotate180}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 180°`}
        >
          ↻ 180°
        </button>
        <button
          className="page-toolbar-btn page-toolbar-btn-danger"
          onClick={handleDelete}
          disabled={!hasDocument || totalPages <= 1}
          title={`Delete ${pageLabel}`}
        >
          Delete
        </button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <div className="page-toolbar-dropdown">
          <button
            className="page-toolbar-btn"
            onClick={() => setShowInsertMenu(!showInsertMenu)}
            disabled={!hasDocument}
          >
            Insert ▾
          </button>
          {showInsertMenu && (
            <div className="page-toolbar-menu">
              <div className="page-toolbar-menu-section">
                <span className="page-toolbar-menu-label">Blank Page</span>
                <button onClick={handleInsertBlankBefore}>Before current</button>
                <button onClick={handleInsertBlankAfter}>After current</button>
                <button onClick={handleInsertBlankAtEnd}>At end</button>
              </div>
              <div className="page-toolbar-menu-divider" />
              <div className="page-toolbar-menu-section">
                <span className="page-toolbar-menu-label">From File</span>
                <button onClick={handleInsertFromFileBefore}>Before current</button>
                <button onClick={handleInsertFromFileAfter}>After current</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
