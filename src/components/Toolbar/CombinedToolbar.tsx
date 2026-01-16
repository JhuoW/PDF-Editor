import { useState } from 'react';
import { useAnnotationStore } from '../../store/annotationStore';
import { useFormStore } from '../../store/formStore';
import { useEditingStore } from '../../store/editingStore';
import type { AnnotationTool } from '../../annotations/types';
import { PREDEFINED_STAMPS } from '../../annotations/types';
import type { EditingMode } from '../../editing/types';
import './CombinedToolbar.css';

interface CombinedToolbarProps {
  currentPage: number;
  totalPages: number;
  selectedPages: number[];
  onRotatePages: (pages: number[], degrees: 90 | -90 | 180) => void;
  onDeletePages: (pages: number[]) => void;
  onInsertBlankPage: (position: number) => void;
  onInsertFromFile: (position: number) => void;
  onMerge: () => void;
  onSplit: () => void;
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
  // Form actions
  onExportFormData?: (format: 'json' | 'fdf' | 'xfdf') => void;
  onImportFormData?: () => void;
  onFlattenForm?: () => void;
  onResetForm?: () => void;
  // Content editing actions
  onApplyRedactions?: () => void;
}

export function CombinedToolbar({
  currentPage,
  totalPages,
  selectedPages,
  onRotatePages,
  onDeletePages,
  onInsertBlankPage,
  onInsertFromFile,
  onMerge,
  onSplit,
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
  onExportFormData,
  onImportFormData,
  onFlattenForm,
  onResetForm,
  onApplyRedactions,
}: CombinedToolbarProps) {
  const [showDocumentMenu, setShowDocumentMenu] = useState(false);
  const [showInsertMenu, setShowInsertMenu] = useState(false);
  const [showFormMenu, setShowFormMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);

  const { isFormPDF, isDirty: formIsDirty } = useFormStore();
  const { mode: editingMode, setMode: setEditingMode, hasChanges, redactions } = useEditingStore();
  const pendingRedactions = redactions.filter(r => !r.applied);

  const {
    currentTool,
    setCurrentTool,
    toolSettings,
    setToolSettings,
    customStamps,
    addCustomStamp,
  } = useAnnotationStore();

  const pagesToOperate = selectedPages.length > 0 ? selectedPages : [currentPage];
  const pageLabel = selectedPages.length > 1
    ? `${selectedPages.length} pages`
    : `page ${currentPage}`;

  // Page operation handlers
  const handleRotateCW = () => onRotatePages(pagesToOperate, 90);
  const handleRotateCCW = () => onRotatePages(pagesToOperate, -90);
  const handleRotate180 = () => onRotatePages(pagesToOperate, 180);

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
    onInsertBlankPage(0);
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

  // Annotation tool handlers
  const handleToolClick = (tool: AnnotationTool) => {
    // Clear editing mode when selecting an annotation tool (mutual exclusivity)
    if (editingMode !== 'none') {
      setEditingMode('none');
    }
    setCurrentTool(currentTool === tool ? 'select' : tool);
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ color: e.target.value });
  };

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ opacity: parseFloat(e.target.value) });
  };

  const handleStrokeWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ strokeWidth: parseInt(e.target.value, 10) });
  };

  const handleAddCustomStamp = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const imageData = reader.result as string;
        const name = file.name.replace(/\.[^/.]+$/, '');
        addCustomStamp(name, imageData);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  // Editing mode handlers
  const handleEditingModeChange = (mode: EditingMode) => {
    setEditingMode(editingMode === mode ? 'none' : mode);
    setShowEditMenu(false);
    // Clear annotation tool when entering editing mode
    if (mode !== 'none') {
      setCurrentTool('select');
    }
  };

  // Close menus when clicking outside
  const closeMenus = () => {
    setShowDocumentMenu(false);
    setShowInsertMenu(false);
    setShowFormMenu(false);
    setShowEditMenu(false);
  };

  return (
    <div className="combined-toolbar" onClick={(e) => e.target === e.currentTarget && closeMenus()}>
      {/* Undo/Redo */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={undoActionName ? `Undo ${undoActionName} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
        >
          ↶
        </button>
        <button
          className="toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoActionName ? `Redo ${redoActionName} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}
        >
          ↷
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Document Menu */}
      <div className="toolbar-group">
        <div className="toolbar-dropdown">
          <button
            className="toolbar-btn dropdown-trigger"
            onClick={() => setShowDocumentMenu(!showDocumentMenu)}
          >
            Document ▾
          </button>
          {showDocumentMenu && (
            <div className="toolbar-menu">
              <button onClick={() => { onMerge(); setShowDocumentMenu(false); }}>
                Merge PDFs
              </button>
              <button onClick={() => { onSplit(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Split PDF
              </button>
              <div className="menu-divider" />
              <button onClick={() => { onResetToOriginal(); setShowDocumentMenu(false); }} disabled={!canResetToOriginal}>
                ⟲ Reset to Original
              </button>
              <button
                className="menu-item-danger"
                onClick={() => { onCloseDocument(); setShowDocumentMenu(false); }}
                disabled={!hasDocument}
              >
                ✕ Close Document
              </button>
            </div>
          )}
        </div>

        {/* Form Menu - only show if document has form fields */}
        {isFormPDF && (
          <div className="toolbar-dropdown">
            <button
              className={`toolbar-btn dropdown-trigger ${formIsDirty ? 'has-changes' : ''}`}
              onClick={() => setShowFormMenu(!showFormMenu)}
            >
              Form {formIsDirty ? '•' : ''} ▾
            </button>
            {showFormMenu && (
              <div className="toolbar-menu">
                <span className="menu-section-label">Export Form Data</span>
                <button onClick={() => { onExportFormData?.('json'); setShowFormMenu(false); }}>
                  Export as JSON
                </button>
                <button onClick={() => { onExportFormData?.('fdf'); setShowFormMenu(false); }}>
                  Export as FDF
                </button>
                <button onClick={() => { onExportFormData?.('xfdf'); setShowFormMenu(false); }}>
                  Export as XFDF
                </button>
                <div className="menu-divider" />
                <button onClick={() => { onImportFormData?.(); setShowFormMenu(false); }}>
                  Import Form Data...
                </button>
                <div className="menu-divider" />
                <button onClick={() => { onResetForm?.(); setShowFormMenu(false); }} disabled={!formIsDirty}>
                  Reset Form Values
                </button>
                <button onClick={() => { onFlattenForm?.(); setShowFormMenu(false); }}>
                  Flatten Form (Make Static)
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content Editing Menu - only show if document is loaded */}
        {hasDocument && (
          <div className="toolbar-dropdown">
            <button
              className={`toolbar-btn dropdown-trigger ${editingMode !== 'none' ? 'active' : ''} ${hasChanges() ? 'has-changes' : ''}`}
              onClick={() => setShowEditMenu(!showEditMenu)}
            >
              Edit {hasChanges() ? '•' : ''} ▾
            </button>
            {showEditMenu && (
              <div className="toolbar-menu">
                <button
                  className={editingMode === 'text' ? 'active' : ''}
                  onClick={() => handleEditingModeChange('text')}
                >
                  ✎ Edit Text
                </button>
                <button
                  className={editingMode === 'image' ? 'active' : ''}
                  onClick={() => handleEditingModeChange('image')}
                >
                  🖼 Edit Images
                </button>
                <div className="menu-divider" />
                <button
                  className={`${editingMode === 'redact' ? 'active' : ''} menu-item-warning`}
                  onClick={() => handleEditingModeChange('redact')}
                >
                  ■ Redact Content
                </button>
                {pendingRedactions.length > 0 && (
                  <>
                    <div className="menu-divider" />
                    <button
                      className="menu-item-danger"
                      onClick={() => {
                        onApplyRedactions?.();
                        setShowEditMenu(false);
                      }}
                    >
                      ⚠ Apply {pendingRedactions.length} Redaction{pendingRedactions.length !== 1 ? 's' : ''} (Permanent)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="toolbar-divider" />

      {/* Page Operations */}
      <div className="toolbar-group">
        <span className="toolbar-label">
          {selectedPages.length > 1 ? `${selectedPages.length} sel:` : 'Page:'}
        </span>
        <button
          className="toolbar-btn"
          onClick={handleRotateCCW}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 90° CCW`}
        >
          ↺
        </button>
        <button
          className="toolbar-btn"
          onClick={handleRotateCW}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 90° CW`}
        >
          ↻
        </button>
        <button
          className="toolbar-btn"
          onClick={handleRotate180}
          disabled={!hasDocument}
          title={`Rotate ${pageLabel} 180°`}
        >
          ⟳
        </button>
        <button
          className="toolbar-btn toolbar-btn-danger"
          onClick={handleDelete}
          disabled={!hasDocument || totalPages <= 1}
          title={`Delete ${pageLabel}`}
        >
          🗑
        </button>

        {/* Insert dropdown */}
        <div className="toolbar-dropdown">
          <button
            className="toolbar-btn"
            onClick={() => setShowInsertMenu(!showInsertMenu)}
            disabled={!hasDocument}
          >
            + Insert ▾
          </button>
          {showInsertMenu && (
            <div className="toolbar-menu">
              <span className="menu-section-label">Blank Page</span>
              <button onClick={handleInsertBlankBefore}>Before current</button>
              <button onClick={handleInsertBlankAfter}>After current</button>
              <button onClick={handleInsertBlankAtEnd}>At end</button>
              <div className="menu-divider" />
              <span className="menu-section-label">From File</span>
              <button onClick={handleInsertFromFileBefore}>Before current</button>
              <button onClick={handleInsertFromFileAfter}>After current</button>
            </div>
          )}
        </div>
      </div>

      {hasDocument && (
        <>
          <div className="toolbar-divider" />

          {/* Annotation Tools */}
          <div className="toolbar-group annotation-group">
            <button
              className={`toolbar-btn ${currentTool === 'select' ? 'active' : ''}`}
              onClick={() => handleToolClick('select')}
              title="Select (V)"
            >
              ↖
            </button>

            <div className="toolbar-separator" />

            {/* Text Markup */}
            <button
              className={`toolbar-btn ${currentTool === 'highlight' ? 'active' : ''}`}
              onClick={() => handleToolClick('highlight')}
              title="Highlight (H)"
            >
              <span className="highlight-icon">H</span>
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'underline' ? 'active' : ''}`}
              onClick={() => handleToolClick('underline')}
              title="Underline (U)"
            >
              <span className="underline-icon">U</span>
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'strikeout' ? 'active' : ''}`}
              onClick={() => handleToolClick('strikeout')}
              title="Strikeout (S)"
            >
              <span className="strikeout-icon">S</span>
            </button>

            <div className="toolbar-separator" />

            {/* Drawing */}
            <button
              className={`toolbar-btn ${currentTool === 'ink' ? 'active' : ''}`}
              onClick={() => handleToolClick('ink')}
              title="Freehand (D)"
            >
              ✏
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'line' ? 'active' : ''}`}
              onClick={() => handleToolClick('line')}
              title="Line (L)"
            >
              ╱
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'arrow' ? 'active' : ''}`}
              onClick={() => handleToolClick('arrow')}
              title="Arrow (A)"
            >
              →
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'rectangle' ? 'active' : ''}`}
              onClick={() => handleToolClick('rectangle')}
              title="Rectangle (R)"
            >
              ▢
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'ellipse' ? 'active' : ''}`}
              onClick={() => handleToolClick('ellipse')}
              title="Ellipse (E)"
            >
              ○
            </button>

            <div className="toolbar-separator" />

            {/* Notes */}
            <button
              className={`toolbar-btn ${currentTool === 'sticky-note' ? 'active' : ''}`}
              onClick={() => handleToolClick('sticky-note')}
              title="Sticky Note (N)"
            >
              📝
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'freetext' ? 'active' : ''}`}
              onClick={() => handleToolClick('freetext')}
              title="Text Box (T)"
            >
              T
            </button>

            <div className="toolbar-separator" />

            {/* Stamps */}
            <div className="toolbar-dropdown">
              <button
                className={`toolbar-btn ${currentTool === 'stamp' ? 'active' : ''}`}
                onClick={() => handleToolClick('stamp')}
                title="Stamp"
              >
                🔖
              </button>
              {currentTool === 'stamp' && (
                <div className="toolbar-menu stamp-menu">
                  <span className="menu-section-label">Predefined</span>
                  {PREDEFINED_STAMPS.map((stamp) => (
                    <button
                      key={stamp}
                      onClick={() => {
                        setToolSettings({ ...toolSettings });
                         
                        (window as unknown as Record<string, unknown>).__selectedStamp = { type: 'predefined', name: stamp };
                      }}
                    >
                      {stamp}
                    </button>
                  ))}
                  {customStamps.length > 0 && (
                    <>
                      <div className="menu-divider" />
                      <span className="menu-section-label">Custom</span>
                      {customStamps.map((stamp) => (
                        <button
                          key={stamp.name}
                          onClick={() => {
                             
                            (window as unknown as Record<string, unknown>).__selectedStamp = {
                              type: 'custom',
                              name: stamp.name,
                              imageData: stamp.imageData,
                            };
                          }}
                        >
                          {stamp.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="menu-divider" />
                  <button onClick={handleAddCustomStamp}>+ Add Custom</button>
                </div>
              )}
            </div>
          </div>

          {/* Tool Settings */}
          {currentTool !== 'select' && (
            <>
              <div className="toolbar-divider" />
              <div className="toolbar-group tool-settings">
                <label className="setting-item" title="Color">
                  <input
                    type="color"
                    value={toolSettings.color}
                    onChange={handleColorChange}
                    className="color-input"
                  />
                </label>

                {(currentTool === 'highlight' ||
                  currentTool === 'rectangle' ||
                  currentTool === 'ellipse') && (
                  <label className="setting-item" title="Opacity">
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.1"
                      value={toolSettings.opacity}
                      onChange={handleOpacityChange}
                      className="range-input"
                    />
                  </label>
                )}

                {(currentTool === 'ink' ||
                  currentTool === 'line' ||
                  currentTool === 'arrow' ||
                  currentTool === 'rectangle' ||
                  currentTool === 'ellipse') && (
                  <label className="setting-item" title="Stroke Width">
                    <input
                      type="range"
                      min="1"
                      max="10"
                      step="1"
                      value={toolSettings.strokeWidth}
                      onChange={handleStrokeWidthChange}
                      className="range-input"
                    />
                  </label>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
