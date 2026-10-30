import { useLocale, translateMessage, t } from "../../i18n";
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
  useLocale();
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
      alert(translateMessage('Cannot delete all pages'));
      return;
    }
    const confirmMsg = selectedPages.length > 1
      ? `Delete ${selectedPages.length} selected pages?`
      : `Delete page ${currentPage}?`;
    if (confirm(translateMessage(confirmMsg))) {
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
          title={undoActionName ? t("m.undo.ctrl.z.60a1ee", { v0: translateMessage(undoActionName) }) : t("m.undo.ctrl.z.26039c")}
        >
          {t("m.undo.6840d5")}</button>
        <button
          className="page-toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoActionName ? t("m.redo.ctrl.shift.z.f1f904", { v0: translateMessage(redoActionName) }) : t("m.redo.ctrl.shift.z.c4d794")}
        >
          {t("m.redo.93c438")}</button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <span className="page-toolbar-label">{t("m.document.29abfb")}</span>
        <button
          className="page-toolbar-btn"
          onClick={onMerge}
          title={t("m.merge.pdfs.6471ae")}
        >
          {t("m.merge.ea8f0d")}</button>
        <button
          className="page-toolbar-btn"
          onClick={onSplit}
          disabled={!hasDocument}
          title={t("m.split.pdf.9c654c")}
        >
          {t("m.split.fc8230")}</button>
        <button
          className="page-toolbar-btn"
          onClick={onExport}
          disabled={!hasDocument}
          title={t("m.export.download.pdf.0d3969")}
        >
          {t("m.export.f3e4fa")}</button>
        <button
          className="page-toolbar-btn"
          onClick={onResetToOriginal}
          disabled={!canResetToOriginal}
          title={t("m.reset.to.original.discard.all.changes.7ad5ca")}
        >
          {t("m.reset.aa965b")}</button>
        <button
          className="page-toolbar-btn page-toolbar-btn-danger"
          onClick={onCloseDocument}
          disabled={!hasDocument}
          title={t("m.close.document.5739e1")}
        >
          {t("m.close.bf5d9c")}</button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <span className="page-toolbar-label">
          {selectedPages.length > 1 ? t("m.selected.4537d5", { v0: selectedPages.length }) : t("m.page.c53d8d")}
        </span>
        <button
          className="page-toolbar-btn"
          onClick={handleRotateCCW}
          disabled={!hasDocument}
          title={t("m.rotate.90.counter.clockwise.40e339", { v0: translateMessage(pageLabel) })}
        >
          ↺ 90°
        </button>
        <button
          className="page-toolbar-btn"
          onClick={handleRotateCW}
          disabled={!hasDocument}
          title={t("m.rotate.90.clockwise.f0851f", { v0: translateMessage(pageLabel) })}
        >
          ↻ 90°
        </button>
        <button
          className="page-toolbar-btn"
          onClick={handleRotate180}
          disabled={!hasDocument}
          title={t("m.rotate.180.a6c8ee", { v0: translateMessage(pageLabel) })}
        >
          ↻ 180°
        </button>
        <button
          className="page-toolbar-btn page-toolbar-btn-danger"
          onClick={handleDelete}
          disabled={!hasDocument || totalPages <= 1}
          title={t("m.delete.b2952e", { v0: translateMessage(pageLabel) })}
        >
          {t("m.delete.f6fdbe")}</button>
      </div>

      <div className="page-toolbar-divider" />

      <div className="page-toolbar-group">
        <div className="page-toolbar-dropdown">
          <button
            className="page-toolbar-btn"
            onClick={() => setShowInsertMenu(!showInsertMenu)}
            disabled={!hasDocument}
          >
            {t("m.insert.bb45e0")}</button>
          {showInsertMenu && (
            <div className="page-toolbar-menu">
              <div className="page-toolbar-menu-section">
                <span className="page-toolbar-menu-label">{t("m.blank.page.7c4bb4")}</span>
                <button onClick={handleInsertBlankBefore}>{t("m.before.current.acddd8")}</button>
                <button onClick={handleInsertBlankAfter}>{t("m.after.current.fd981d")}</button>
                <button onClick={handleInsertBlankAtEnd}>{t("m.at.end.242e6c")}</button>
              </div>
              <div className="page-toolbar-menu-divider" />
              <div className="page-toolbar-menu-section">
                <span className="page-toolbar-menu-label">{t("m.from.file.e70d00")}</span>
                <button onClick={handleInsertFromFileBefore}>{t("m.before.current.acddd8")}</button>
                <button onClick={handleInsertFromFileAfter}>{t("m.after.current.fd981d")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
