import { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { useAnnotationStore } from '../../store/annotationStore';
import { useFormStore } from '../../store/formStore';
import { useEditingStore } from '../../store/editingStore';
import type { AnnotationTool } from '../../annotations/types';
import { PREDEFINED_STAMPS, SUPPORTED_IMAGE_EXTENSIONS } from '../../annotations/types';
import type { EditingMode } from '../../editing/types';
import { useToolbarMenus } from './useToolbarMenus';
import './CombinedToolbar.css';

// Image data passed when inserting an image
export interface PendingImageData {
  imageData: string; // Base64 data URL
  originalWidth: number;
  originalHeight: number;
  filename: string;
  fileSize: number;
  mimeType: string;
}

function readInsertImage(file: File, signal: AbortSignal): Promise<PendingImageData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let image: HTMLImageElement | null = null, settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = null; reader.onerror = null; reader.onabort = null;
      if (image) { image.onload = null; image.onerror = null; }
    };
    const fail = (cause: Error) => { if (settled) return; settled = true; cleanup(); reject(cause); };
    const abort = () => {
      fail(new DOMException('Image loading cancelled.', 'AbortError'));
      if (reader.readyState === 1) reader.abort();
      if (image) image.src = '';
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    reader.onload = () => {
      if (settled || signal.aborted) return;
      const data = reader.result;
      if (typeof data !== 'string') { fail(new Error(`Could not read image: ${file.name}`)); return; }
      image = new Image();
      image.onload = async () => {
        if (settled || signal.aborted || !image) return;
        const width = image.naturalWidth, height = image.naturalHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 40_000_000) { fail(new Error(`Image ${file.name} must have valid dimensions within 40 million pixels.`)); return; }
        try {
          let imageData = data, fileSize = file.size;
          let mimeType = /^data:([^;,]+)/i.exec(data)?.[1].toLowerCase() ?? file.type;
          let convert = !['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType);
          if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
            const { inspectPDFImage } = await import('../../core/ImagePDF');
            if (settled || signal.aborted) return;
            const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), char => char.charCodeAt(0));
            convert = inspectPDFImage({ name: file.name, data: bytes }).orientation !== 1;
          }
          if (convert) {
            // Browsers apply EXIF while drawing an image; raw PDF JPEG embedding
            // does not. Canonical PNG pixels also make WebP/GIF/BMP/SVG exportable.
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            try {
              const context = canvas.getContext('2d'); if (!context) throw new Error('Could not prepare the image for PDF export.');
              context.drawImage(image, 0, 0, width, height);
              imageData = canvas.toDataURL('image/png');
              if (!imageData.startsWith('data:image/png;base64,')) throw new Error('Could not encode the image for PDF export.');
              const encoded = imageData.slice(imageData.indexOf(',') + 1);
              fileSize = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
              if (fileSize > 20 * 1024 * 1024) throw new Error(`Prepared image ${file.name} exceeds 20 MB. Choose a smaller image.`);
              mimeType = 'image/png';
            } finally { canvas.width = 0; canvas.height = 0; }
          }
          if (settled || signal.aborted) return;
          settled = true; cleanup(); resolve({ imageData, originalWidth: width, originalHeight: height, filename: file.name, fileSize, mimeType });
        } catch (cause) { fail(cause instanceof Error ? cause : new Error(`Could not prepare image: ${file.name}`)); }
      };
      image.onerror = () => fail(new Error(`Could not decode image: ${file.name}`));
      image.src = data;
    };
    reader.onerror = () => fail(new Error(`Could not read image: ${file.name}`));
    reader.onabort = () => fail(new DOMException('Image loading cancelled.', 'AbortError'));
    try { reader.readAsDataURL(file); } catch (cause) { fail(cause instanceof Error ? cause : new Error(`Could not read image: ${file.name}`)); }
  });
}

interface SelectedStamp { type: 'predefined' | 'custom'; name: string; imageData?: string; width?: number; height?: number }

interface CombinedToolbarProps {
  isBusy?: boolean;
  documentKey?: unknown;
  documentRevision?: number;
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
  onEncryptExport?: () => void;
  onDocumentProperties?: () => void;
  onOCR?: () => void;
  onPageDecorations?: () => void;
  onCleanDocument?: () => void;
  onCompressPDF?: () => void;
  onManageLinks?: () => void;
  onManageBookmarks?: () => void;
  onSignature?: () => void;
  canResetToOriginal: boolean;
  // Form actions
  onExportFormData?: (format: 'json' | 'fdf' | 'xfdf') => void;
  onImportFormData?: () => void;
  onFlattenForm?: () => void;
  onResetForm?: () => void;
  onDesignForm?: () => void;
  // Content editing actions
  onApplyRedactions?: () => void;
  onRemoveContent?: () => void;
  onApplyContent?: () => void;
  // Image insertion
  onInsertImage?: (images: PendingImageData[]) => void;
}

export function CombinedToolbar({
  isBusy = false,
  documentKey,
  documentRevision,
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
  onEncryptExport,
  onDocumentProperties,
  onOCR,
  onPageDecorations,
  onCleanDocument,
  onCompressPDF,
  onManageLinks,
  onManageBookmarks,
  onSignature,
  canResetToOriginal,
  onExportFormData,
  onImportFormData,
  onFlattenForm,
  onResetForm,
  onDesignForm,
  onApplyRedactions,
  onRemoveContent,
  onApplyContent,
  onInsertImage,
}: CombinedToolbarProps) {
  const [showDocumentMenu, setShowDocumentMenu] = useState(false);
  const [showInsertMenu, setShowInsertMenu] = useState(false);
  const [showFormMenu, setShowFormMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [showStampMenu, setShowStampMenu] = useState(false);
  const [selectedStamp, setSelectedStamp] = useState<SelectedStamp>(() => (window as unknown as { __selectedStamp?: SelectedStamp }).__selectedStamp ?? { type: 'predefined', name: 'Approved' });
  const stampInputRef = useRef<HTMLInputElement>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageIdentity = useMemo(() => ({ documentKey, documentRevision, hasDocument, isBusy }), [documentKey, documentRevision, hasDocument, isBusy]);
  const currentImageIdentity = useRef(imageIdentity);
  const imageJob = useRef<{ key: object; controller: AbortController; kind?: 'stamp' } | null>(null);
  const [imageRead, setImageRead] = useState<{ key: object; status: 'loading' | 'error'; message: string } | null>(null);
  const shownImageRead = imageRead?.key === imageIdentity && hasDocument && !isBusy ? imageRead : null;
  useLayoutEffect(() => { currentImageIdentity.current = imageIdentity; });
  useEffect(() => () => {
    const job = imageJob.current;
    if (job?.key === imageIdentity) { imageJob.current = null; job.controller.abort(); }
  }, [imageIdentity]);

  const toolbarRef = useRef<HTMLDivElement>(null);

  // Close menus when clicking outside the toolbar
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setShowDocumentMenu(false);
        setShowInsertMenu(false);
        setShowFormMenu(false);
        setShowEditMenu(false);
        setShowStampMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const { isFormPDF, isDirty: formIsDirty } = useFormStore();
  const { mode: editingMode, setMode: setEditingMode, hasChanges, redactions, textEdits, imageEdits, selectedBlockId } = useEditingStore();
  const hasContentEdits = textEdits.length > 0 || imageEdits.length > 0;
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

  // Image insertion handler
  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Capture files and reset this input before awaiting, so a new selection is
    // never cleared by completion of a previous asynchronous read.
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (!files.length || isBusy || !hasDocument || !onInsertImage) return;
    imageJob.current?.controller.abort();
    const job = { key: imageIdentity, controller: new AbortController() };
    imageJob.current = job;
    const isCurrent = () => imageJob.current === job && currentImageIdentity.current === job.key && !job.controller.signal.aborted;
    setImageRead({ key: job.key, status: 'loading', message: `Loading ${files.length} image${files.length === 1 ? '' : 's'}…` });
    setShowInsertMenu(false);
    try {
      if (files.length > 20) throw new Error('Choose up to 20 images at a time.');
      if (files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) throw new Error('The image selection exceeds 80 MB.');
      for (const file of files) {
        if (!file.type.startsWith('image/')) throw new Error(`Choose an image file: ${file.name}`);
        if (!file.size || file.size > 20 * 1024 * 1024) throw new Error(`Image ${file.name} must be between 1 byte and 20 MB.`);
      }
      const images = await Promise.all(files.map(file => readInsertImage(file, job.controller.signal)));
      if (!isCurrent()) return;
      if (images.reduce((sum, image) => sum + image.fileSize, 0) > 80 * 1024 * 1024) throw new Error('The prepared image selection exceeds 80 MB. Choose fewer or smaller images.');
      if (images.reduce((sum, image) => sum + image.originalWidth * image.originalHeight, 0) > 80_000_000) throw new Error('The image selection exceeds 80 million pixels.');
      onInsertImage(images);
      if (isCurrent()) setImageRead(null);
    } catch (error) {
      if (isCurrent()) setImageRead({ key: job.key, status: 'error', message: error instanceof Error ? error.message : 'Could not load these images. Please try again.' });
      job.controller.abort();
    } finally {
      if (imageJob.current === job) imageJob.current = null;
    }
  };

  const handleInsertImageClick = () => {
    if (!isBusy && hasDocument && onInsertImage) imageInputRef.current?.click();
  };

  const cancelImageRead = () => { imageJob.current?.controller.abort(); imageJob.current = null; setImageRead(null); };

  // Annotation tool handlers
  const handleToolClick = (tool: AnnotationTool) => {
    closeMenus();
    if (imageJob.current?.kind === 'stamp') cancelImageRead();
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

  const chooseStamp = (stamp: SelectedStamp) => {
    cancelImageRead();
    setSelectedStamp(stamp);
    (window as unknown as { __selectedStamp?: SelectedStamp }).__selectedStamp = stamp;
    setEditingMode('none');
    setCurrentTool('stamp');
    closeMenus();
  };

  const prepareStamp = async (file: File, existingName?: string) => {
    if (isBusy || !hasDocument) return;
    imageJob.current?.controller.abort();
    const job = { key: imageIdentity, controller: new AbortController(), kind: 'stamp' as const };
    imageJob.current = job;
    const isCurrent = () => imageJob.current === job && currentImageIdentity.current === job.key && !job.controller.signal.aborted;
    setImageRead({ key: job.key, status: 'loading', message: `Loading stamp ${existingName ?? file.name}…` });
    closeMenus(); setEditingMode('none'); setCurrentTool('select');
    try {
      if (!file.type.startsWith('image/')) throw new Error('Choose an image file for the custom stamp.');
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('The custom stamp image must be between 1 byte and 20 MB.');
      const image = await readInsertImage(file, job.controller.signal);
      if (!isCurrent()) return;
      // Do not switch back to Stamp after the user chooses a different tool.
      if (useAnnotationStore.getState().currentTool !== 'select' || useEditingStore.getState().mode !== 'none') { setImageRead(null); return; }
      const base = file.name.replace(/\.[^/.]+$/, '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 80) || 'Custom stamp';
      let name = existingName ?? base, suffix = 2;
      if (!existingName) {
        const names = new Set(useAnnotationStore.getState().customStamps.map(stamp => stamp.name));
        while (names.has(name)) name = `${base} (${suffix++})`;
        addCustomStamp(name, image.imageData, { width: image.originalWidth, height: image.originalHeight });
      }
      chooseStamp({ type: 'custom', name, imageData: image.imageData, width: image.originalWidth, height: image.originalHeight });
    } catch (error) {
      if (isCurrent()) setImageRead({ key: job.key, status: 'error', message: error instanceof Error ? error.message : 'Could not load the custom stamp.' });
      job.controller.abort();
    } finally { if (imageJob.current === job) imageJob.current = null; }
  };

  const handleStampFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (file) void prepareStamp(file);
  };

  const chooseCustomStamp = (stamp: typeof customStamps[number]) => {
    if (stamp.width && stamp.height) { chooseStamp({ type: 'custom', ...stamp }); return; }
    // Legacy library entries contain only name/data. Decode on selection so they
    // also gain correct dimensions and exportable pixels without losing entries.
    try {
      const match = /^data:(image\/[^;,]+);base64,(.+)$/s.exec(stamp.imageData);
      if (!match) throw new Error('Could not read this custom stamp. Please add its image again.');
      const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
      void prepareStamp(new File([bytes], stamp.name, { type: match[1] }), stamp.name);
    } catch (error) { setImageRead({ key: imageIdentity, status: 'error', message: error instanceof Error ? error.message : 'Could not read this custom stamp.' }); }
  };

  // Editing mode handlers
  const handleEditingModeChange = (mode: EditingMode) => {
    if (imageJob.current?.kind === 'stamp') cancelImageRead();
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
    setShowStampMenu(false);
  };
  const activeMenu = showDocumentMenu ? 'document' : showInsertMenu ? 'insert' : showFormMenu ? 'form' : showEditMenu ? 'edit' : showStampMenu && currentTool === 'stamp' ? 'stamp' : null;
  const menuEvents = useToolbarMenus(toolbarRef, activeMenu, closeMenus);
  const toggleMenu = (name: string) => {
    const wasOpen = activeMenu === name; closeMenus();
    if (wasOpen) return;
    if (name === 'document') setShowDocumentMenu(true);
    if (name === 'insert') setShowInsertMenu(true);
    if (name === 'form') setShowFormMenu(true);
    if (name === 'edit') setShowEditMenu(true);
    if (name === 'stamp') { setEditingMode('none'); setCurrentTool('stamp'); setShowStampMenu(true); }
  };

  return (
    <div ref={toolbarRef} {...menuEvents} className="combined-toolbar" inert={isBusy} aria-busy={isBusy} onClick={(e) => e.target === e.currentTarget && closeMenus()}>
      {/* Undo/Redo */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title={undoActionName ? `Undo ${undoActionName} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          aria-label={undoActionName ? `Undo ${undoActionName}` : 'Undo'}
        >
          ↶
        </button>
        <button
          className="toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title={redoActionName ? `Redo ${redoActionName} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'}
          aria-label={redoActionName ? `Redo ${redoActionName}` : 'Redo'}
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
            onClick={() => toggleMenu('document')}
            data-toolbar-menu-trigger="document" aria-expanded={showDocumentMenu} aria-controls="toolbar-document-menu"
          >
            Document ▾
          </button>
          {showDocumentMenu && (
            <div className="toolbar-menu" id="toolbar-document-menu" data-toolbar-menu="document" role="group" aria-label="Document menu">
              <button onClick={() => { onMerge(); setShowDocumentMenu(false); }}>
                Merge PDFs
              </button>
              <button onClick={() => { onSplit(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Split PDF
              </button>
              {onDocumentProperties && <button onClick={() => { onDocumentProperties(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Document Properties &amp; Attachments…
              </button>}
              {onOCR && <button onClick={() => { onOCR(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Scan OCR…
              </button>}
              {onPageDecorations && <button onClick={() => { onPageDecorations(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Watermarks, Headers &amp; Backgrounds…
              </button>}
              {onCleanDocument && <button onClick={() => { onCleanDocument(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Clean Document…
              </button>}
              {onManageBookmarks && <button onClick={() => { onManageBookmarks(); setShowDocumentMenu(false); }} disabled={!hasDocument}>Bookmarks…</button>}
              {onManageLinks && <button onClick={() => { onManageLinks(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Links…
              </button>}
              {onCompressPDF && <button onClick={() => { onCompressPDF(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Compress PDF…
              </button>}
              {onEncryptExport && <button onClick={() => { onEncryptExport(); setShowDocumentMenu(false); }} disabled={!hasDocument}>
                Encrypt and Export…
              </button>}
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
        {(isFormPDF || hasDocument && onDesignForm) && (
          <div className="toolbar-dropdown">
            <button
              className={`toolbar-btn dropdown-trigger ${formIsDirty ? 'has-changes' : ''}`}
              onClick={() => toggleMenu('form')}
            data-toolbar-menu-trigger="form" aria-expanded={showFormMenu} aria-controls="toolbar-form-menu"
            >
              Form {formIsDirty ? '•' : ''} ▾
            </button>
            {showFormMenu && (
              <div className="toolbar-menu" id="toolbar-form-menu" data-toolbar-menu="form" role="group" aria-label="Form menu">
                {onDesignForm && <button onClick={() => { onDesignForm(); setShowFormMenu(false); }} disabled={!hasDocument}>Design Form…</button>}
                {isFormPDF && <>
                {onDesignForm && <div className="menu-divider" />}
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
                </>}
              </div>
            )}
          </div>
        )}

        {hasDocument && (hasContentEdits || editingMode === 'text') && onApplyContent && (
          <button className="toolbar-btn" onClick={onApplyContent} disabled={!hasContentEdits}
            title="Update the page with your text and image changes. You can undo this operation.">
            Apply Content Changes
          </button>
        )}
        {/* Content Editing Menu - only show if document is loaded */}
        {hasDocument && (
          <div className="toolbar-dropdown">
            <button
              className={`toolbar-btn dropdown-trigger ${editingMode !== 'none' ? 'active' : ''} ${hasChanges() ? 'has-changes' : ''}`}
              onClick={() => toggleMenu('edit')}
            data-toolbar-menu-trigger="edit" aria-expanded={showEditMenu} aria-controls="toolbar-edit-menu"
            >
              Edit {hasChanges() ? '•' : ''} ▾
            </button>
            {showEditMenu && (
              <div className="toolbar-menu" id="toolbar-edit-menu" data-toolbar-menu="edit" role="group" aria-label="Edit menu">
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
                  ■ Mark Content Areas
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
                      Apply {pendingRedactions.length} Visual Cover{pendingRedactions.length !== 1 ? 's' : ''}
                    </button>
                    <button className="menu-item-danger" onClick={() => { onRemoveContent?.(); setShowEditMenu(false); }}>
                      Remove Selected Page Content
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="toolbar-divider" />

      <div id="pdf-text-edit-controls" className={`pdf-text-edit-controls ${editingMode === 'text' ? 'active' : ''}`}>
        {editingMode === 'text' && !selectedBlockId && <span>Click text in the PDF to edit</span>}
      </div>

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
            onClick={() => toggleMenu('insert')}
            data-toolbar-menu-trigger="insert" aria-expanded={showInsertMenu} aria-controls="toolbar-insert-menu"
            disabled={!hasDocument}
          >
            + Insert ▾
          </button>
          {showInsertMenu && (
            <div className="toolbar-menu" id="toolbar-insert-menu" data-toolbar-menu="insert" role="group" aria-label="Insert menu">
              <span className="menu-section-label">Content</span>
              {onSignature && <button onClick={() => { onSignature(); setShowInsertMenu(false); }}>Signature…</button>}
              <button onClick={handleInsertImageClick} disabled={isBusy || !onInsertImage}>
                🖼 Image
              </button>
              <div className="menu-divider" />
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

        {/* Hidden file input for image insertion */}
        <input
          ref={imageInputRef}
          type="file"
          accept={SUPPORTED_IMAGE_EXTENSIONS}
          multiple
          disabled={isBusy || !hasDocument || !onInsertImage}
          aria-label="Insert images"
          onChange={handleImageFileChange}
          style={{ display: 'none' }}
        />
        <input ref={stampInputRef} type="file" accept="image/*" aria-label="Custom stamp image"
          disabled={isBusy || !hasDocument} onChange={handleStampFileChange} style={{ display: 'none' }} />
      </div>
        {shownImageRead && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexBasis: '100%', minWidth: 0, maxWidth: '100%', fontSize: 12 }}>
          <span role={shownImageRead.status === 'error' ? 'alert' : 'status'} style={{ overflowWrap: 'anywhere' }}>{shownImageRead.message}</span>
          <button type="button" className="toolbar-btn" onClick={cancelImageRead}>{shownImageRead.status === 'loading' ? 'Cancel image loading' : 'Dismiss image error'}</button>
        </div>}
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
              <svg className="tool-icon-svg select-cursor-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4L10 22L13 13L22 10L4 4Z" fill="white" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'pan' ? 'active' : ''}`}
              onClick={() => handleToolClick('pan')}
              title="Pan (H) - Hold Space for temp pan"
            >
              <svg className="tool-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M18 11V6C18 5.45 17.55 5 17 5C16.45 5 16 5.45 16 6V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M14 11V4C14 3.45 13.55 3 13 3C12.45 3 12 3.45 12 4V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M10 11V6C10 5.45 9.55 5 9 5C8.45 5 8 5.45 8 6V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M20 11V17C20 19.21 18.21 21 16 21H12C9.79 21 8 19.21 8 17V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M6 11V9C6 8.45 5.55 8 5 8C4.45 8 4 8.45 4 9V15C4 18.31 6.69 21 10 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            <div className="toolbar-separator" />

            {/* Text Markup */}
            <button
              className={`toolbar-btn ${currentTool === 'highlight' ? 'active' : ''}`}
              onClick={() => handleToolClick('highlight')}
              title="Highlight"
            >
              <span className="highlight-icon">H</span>
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'underline' ? 'active' : ''}`}
              onClick={() => handleToolClick('underline')}
              title="Underline"
            >
              <span className="underline-icon">U</span>
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'strikeout' ? 'active' : ''}`}
              onClick={() => handleToolClick('strikeout')}
              title="Strikeout"
            >
              <span className="strikeout-icon">S</span>
            </button>

            <div className="toolbar-separator" />

            {/* Drawing */}
            <button
              className={`toolbar-btn ${currentTool === 'ink' ? 'active' : ''}`}
              onClick={() => handleToolClick('ink')}
              title="Freehand"
            >
              ✏
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'line' ? 'active' : ''}`}
              onClick={() => handleToolClick('line')}
              title="Line"
            >
              ╱
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'arrow' ? 'active' : ''}`}
              onClick={() => handleToolClick('arrow')}
              title="Arrow"
            >
              →
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'rectangle' ? 'active' : ''}`}
              onClick={() => handleToolClick('rectangle')}
              title="Rectangle"
            >
              ▢
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'ellipse' ? 'active' : ''}`}
              onClick={() => handleToolClick('ellipse')}
              title="Ellipse"
            >
              ○
            </button>

            <div className="toolbar-separator" />

            {/* Notes */}
            <button
              className={`toolbar-btn ${currentTool === 'sticky-note' ? 'active' : ''}`}
              onClick={() => handleToolClick('sticky-note')}
              title="Sticky Note"
            >
              📝
            </button>
            <button
              className={`toolbar-btn ${currentTool === 'freetext' ? 'active' : ''}`}
              onClick={() => handleToolClick('freetext')}
              title="Text Box"
            >
              T
            </button>

            <div className="toolbar-separator" />

            {/* Stamps */}
            <div className="toolbar-dropdown">
              <button
                className={`toolbar-btn ${currentTool === 'stamp' ? 'active' : ''}`}
                onClick={() => toggleMenu('stamp')}
                data-toolbar-menu-trigger="stamp" aria-expanded={activeMenu === 'stamp'} aria-controls="toolbar-stamp-menu"
                title="Stamp"
              >
                🔖
              </button>
              {activeMenu === 'stamp' && (
                <div className="toolbar-menu stamp-menu" id="toolbar-stamp-menu" data-toolbar-menu="stamp" role="group" aria-label="Stamp menu">
                  <span className="menu-section-label">Predefined</span>
                  {PREDEFINED_STAMPS.map((stamp) => (
                    <button
                      key={stamp}
                      aria-pressed={selectedStamp.type === 'predefined' && selectedStamp.name === stamp}
                      onClick={() => chooseStamp({ type: 'predefined', name: stamp })}
                    >
                      {stamp}
                    </button>
                  ))}
                  {customStamps.length > 0 && (
                    <>
                      <div className="menu-divider" />
                      <span className="menu-section-label">Custom</span>
                      {customStamps.map((stamp, index) => (
                        <button
                          key={`${stamp.name}-${index}`}
                          aria-pressed={selectedStamp.type === 'custom' && selectedStamp.name === stamp.name}
                          onClick={() => chooseCustomStamp(stamp)}
                        >
                          {stamp.name}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="menu-divider" />
                  <button onClick={() => stampInputRef.current?.click()}>+ Add Custom</button>
                </div>
              )}
            </div>
          </div>

          {/* Tool Settings */}
          {currentTool !== 'select' && currentTool !== 'pan' && (
            <>
              <div className="toolbar-divider" />
              <div className="toolbar-group tool-settings">
                {currentTool === 'stamp' && <span className="setting-item" role="status" style={{ overflowWrap: 'anywhere' }}>Stamp: {selectedStamp.name} — click the page to place</span>}
                {currentTool !== 'stamp' && <label className="setting-item" title="Color">
                  <input
                    type="color"
                    value={toolSettings.color}
                    onChange={handleColorChange}
                    className="color-input"
                  />
                </label>}

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
