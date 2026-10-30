import { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { useAnnotationStore } from '../../store/annotationStore';
import { useFormStore } from '../../store/formStore';
import { useEditingStore } from '../../store/editingStore';
import { commitPendingEditors } from '../../store/workspaceHistory';
import type { AnnotationTool } from '../../annotations/types';
import { PREDEFINED_STAMPS, SUPPORTED_IMAGE_EXTENSIONS } from '../../annotations/types';
import type { EditingMode } from '../../editing/types';
import { useToolbarMenus } from './useToolbarMenus';
import './CombinedToolbar.css';
import { translateMessage, useLocale , t } from '../../i18n';
import { useUIStore } from '../../store/uiStore';
import { ToolButton, type WorkspaceCommand } from '../Workspace/ToolButton';
import { House, Type, ImagePlus, Image as ImageIcon, Highlighter, Underline, Strikethrough, Pencil, MoveUpRight, Minus, RectangleHorizontal, Circle, StickyNote, Stamp, MousePointer2, Hand, Files, Scissors, RotateCcw, RotateCw, Rotate3D, Trash2, FilePlus2, FileInput, FileOutput, ScanText, FileImage, FileDown, FilePenLine, Signature, FileJson, ListRestart, Layers, ShieldCheck, Eraser, EyeOff, FileKey2, Settings2, Link, BookMarked, Paintbrush, Undo2, Redo2, Check, LayoutGrid, ChevronDown, SlidersHorizontal, X } from 'lucide-react';

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
  onCreatePDF?: () => void;
  onExportPages?: () => void;
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
  onCreatePDF,
  onExportPages,
}: CombinedToolbarProps) {
  useLocale();
  const [showDocumentMenu, setShowDocumentMenu] = useState(false);
  const [, setShowInsertMenu] = useState(false);


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
        setShowStampMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const { isFormPDF, isDirty: formIsDirty } = useFormStore();
  const { mode: editingMode, setMode: setEditingMode, redactions, textEdits, imageEdits, selectedBlockId } = useEditingStore();
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


  // Page operation handlers
  const handleRotateCW = () => onRotatePages(pagesToOperate, 90);
  const handleRotateCCW = () => onRotatePages(pagesToOperate, -90);
  const handleRotate180 = () => onRotatePages(pagesToOperate, 180);

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

    // Clear annotation tool when entering editing mode
    if (mode !== 'none') {
      setCurrentTool('select');
    }
  };

  // Close menus when clicking outside
  const closeMenus = () => {
    setShowDocumentMenu(false);
    setShowInsertMenu(false);
    setShowStampMenu(false);
  };
  const activeMenu = showDocumentMenu ? 'document' : showStampMenu && currentTool === 'stamp' ? 'stamp' : null;
  const menuEvents = useToolbarMenus(toolbarRef, activeMenu, closeMenus);
  const toggleMenu = (name: string) => {
    const wasOpen = activeMenu === name; closeMenus();
    if (wasOpen) return;
    if (name === 'document') setShowDocumentMenu(true);
    if (name === 'stamp') { setEditingMode('none'); setCurrentTool('stamp'); setShowStampMenu(true); }
  };

  const { workspace, setWorkspace, inspectorOpen, setInspectorOpen } = useUIStore();
  const changeWorkspace = (next: typeof workspace) => {
    commitPendingEditors(); closeMenus(); setEditingMode('none'); setCurrentTool('select'); setWorkspace(next);
  };
  const command = (id: string, label: string, shortLabel: string, group: string, icon: WorkspaceCommand['icon'], run: WorkspaceCommand['run'], enabled = hasDocument, active?: boolean, danger = false): WorkspaceCommand => ({ id, label: translateMessage(label), shortLabel: translateMessage(shortLabel), group, icon, run, disabled: !enabled || isBusy, active, danger });
  const commands: WorkspaceCommand[] = [
    command('edit-text', t("m.edit.text.f5f4f6"), t("m.edit.text.6597b9"), 'Edit', Type, () => handleEditingModeChange('text'), hasDocument, editingMode === 'text'),
    command('edit-images', t("m.edit.images.ce2267"), t("m.edit.images.b368ef"), 'Edit', ImageIcon, () => handleEditingModeChange('image'), hasDocument, editingMode === 'image'),
    command('insert-image', t("m.insert.images.f4a261"), t("m.insert.image.c8141e"), 'Edit', ImagePlus, handleInsertImageClick, hasDocument && !!onInsertImage),
    command('links', t("m.links.9f8853"), t("m.links.014bcd"), 'Edit', Link, () => onManageLinks?.(), hasDocument && !!onManageLinks),
    command('bookmarks', t("m.bookmarks.ffd34e"), t("m.bookmarks.ca3cdd"), 'Edit', BookMarked, () => onManageBookmarks?.(), hasDocument && !!onManageBookmarks),
    command('appearance', t("m.watermarks.headers.backgrounds.bb98b0"), t("m.page.appearance.ed9e8a"), 'Edit', Paintbrush, () => onPageDecorations?.(), hasDocument && !!onPageDecorations),
    command('merge', t("m.merge.pdfs.6471ae"), t("m.merge.ea8f0d"), 'Organize', Files, () => onMerge(), true),
    command('split', t("m.split.pdf.9c654c"), t("m.split.fc8230"), 'Organize', Scissors, () => onSplit()),
    command('rotate-left', t("m.rotate.pages.left.8402cf"), t("m.rotate.left.6f72f3"), 'Organize', RotateCcw, handleRotateCCW),
    command('rotate-right', t("m.rotate.pages.right.58a421"), t("m.rotate.right.b75f23"), 'Organize', RotateCw, handleRotateCW),
    command('rotate-180', t("m.rotate.pages.180.85a24e"), t("m.rotate.180.8c8d54"), 'Organize', Rotate3D, handleRotate180),
    command('delete-pages', t("m.delete.pages.33fdff"), t("m.delete.pages.33fdff"), 'Organize', Trash2, handleDelete, hasDocument && totalPages > pagesToOperate.length, undefined, true),
    command('blank-before', t("m.before.current.acddd8"), t("m.blank.page.before.3a3a17"), 'Organize', FilePlus2, handleInsertBlankBefore),
    command('blank-after', t("m.after.current.fd981d"), t("m.blank.page.after.7febbe"), 'Organize', FilePlus2, handleInsertBlankAfter),
    command('blank-end', t("m.at.end.242e6c"), t("m.blank.page.at.end.0669bd"), 'Organize', FilePlus2, handleInsertBlankAtEnd),
    command('pdf-before', t("m.insert.pdf.before.33c3be"), t("m.insert.pdf.before.33c3be"), 'Organize', FileInput, handleInsertFromFileBefore),
    command('pdf-after', t("m.insert.pdf.after.282440"), t("m.insert.pdf.after.282440"), 'Organize', FileInput, handleInsertFromFileAfter),
    command('create-pdf', t("m.create.pdf.from.images.74adad"), t("m.images.to.pdf.9710a6"), 'Convert', FileImage, () => onCreatePDF?.(), !!onCreatePDF),
    command('export-pages', t("m.export.pages.8f8203"), t("m.pdf.to.images.c96714"), 'Convert', FileOutput, () => onExportPages?.(), hasDocument && !!onExportPages),
    command('ocr', t("m.scan.ocr.5304f2"), t("m.recognize.text.7f8640"), 'Convert', ScanText, () => onOCR?.(), hasDocument && !!onOCR),
    command('compress', t("m.compress.pdf.2ae903"), t("m.compress.pdf.c81566"), 'Convert', FileDown, () => onCompressPDF?.(), hasDocument && !!onCompressPDF),
    command('form-designer', t("m.design.form.b154f0"), t("m.form.designer.e0fd9d"), 'Forms & Sign', FilePenLine, () => onDesignForm?.(), hasDocument && !!onDesignForm),
    command('signature', t("m.signature.ee20cd"), t("m.signature.2f32be"), 'Forms & Sign', Signature, () => onSignature?.(), hasDocument && !!onSignature),
    command('form-import', t("m.import.form.data.dd132b"), t("m.import.data.d82c93"), 'Forms & Sign', FileInput, () => onImportFormData?.(), hasDocument && isFormPDF),
    command('form-json', t("m.export.as.json.491c45"), t("m.export.json.bc3990"), 'Forms & Sign', FileJson, () => onExportFormData?.('json'), hasDocument && isFormPDF),
    command('form-fdf', t("m.export.as.fdf.b608d6"), t("m.export.fdf.350b85"), 'Forms & Sign', FileOutput, () => onExportFormData?.('fdf'), hasDocument && isFormPDF),
    command('form-xfdf', t("m.export.as.xfdf.0a2274"), t("m.export.xfdf.2ddc7d"), 'Forms & Sign', FileOutput, () => onExportFormData?.('xfdf'), hasDocument && isFormPDF),
    command('form-reset', t("m.reset.form.values.1f87ce"), t("m.reset.values.4bfd35"), 'Forms & Sign', ListRestart, () => onResetForm?.(), hasDocument && isFormPDF && formIsDirty),
    command('form-flatten', t("m.flatten.form.make.static.9e82b8"), t("m.flatten.fields.b6e5a8"), 'Forms & Sign', Layers, () => onFlattenForm?.(), hasDocument && isFormPDF),
    command('encrypt', t("m.password.protected.export.3e1d4c"), t("m.secure.export.a5c909"), 'Protect', FileKey2, () => onEncryptExport?.(), hasDocument && !!onEncryptExport),
    command('mark-content', t("m.mark.content.areas.0e71a7"), t("m.mark.content.areas.0eb39f"), 'Protect', EyeOff, () => handleEditingModeChange('redact'), hasDocument, editingMode === 'redact'),
    command('remove-content', t("m.remove.selected.page.content.5a41ea"), t("m.remove.content.bff132"), 'Protect', Eraser, () => onRemoveContent?.(), hasDocument && pendingRedactions.length > 0, undefined, true),
    command('apply-marks', t("m.apply.visual.covers.23b782"), t("m.apply.marked.areas.1e16af"), 'Protect', Check, () => onApplyRedactions?.(), hasDocument && pendingRedactions.length > 0),
    command('clean', t("m.clean.document.20fbfe"), t("m.clean.document.752a0f"), 'Protect', ShieldCheck, () => onCleanDocument?.(), hasDocument && !!onCleanDocument),
    command('properties', t("m.document.properties.attachments.e8ebbd"), t("m.properties.bc6c88"), 'Document', Settings2, () => onDocumentProperties?.(), hasDocument && !!onDocumentProperties),
    command('reset', t("m.reset.to.original.9430bc"), t("m.reset.document.466f3c"), 'Document', ListRestart, onResetToOriginal, hasDocument && canResetToOriginal, undefined, true),
    command('close', t("m.close.document.5739e1"), t("m.close.document.7866c7"), 'Document', X, onCloseDocument),
  ];
  const annotationCommands: WorkspaceCommand[] = [
    ['select', 'Select (V)', MousePointer2], ['pan', 'Pan (H) - Hold Space for temp pan', Hand],
    ['highlight', 'Highlight', Highlighter], ['underline', 'Underline', Underline], ['strikeout', 'Strikeout', Strikethrough],
    ['ink', 'Freehand', Pencil], ['line', 'Line', Minus], ['arrow', 'Arrow', MoveUpRight],
    ['rectangle', 'Rectangle', RectangleHorizontal], ['ellipse', 'Ellipse', Circle],
    ['sticky-note', 'Sticky Note', StickyNote], ['freetext', 'Text Box', Type],
  ].map(([id, label, icon]) => command(id as string, label as string, label as string, 'Annotate', icon as WorkspaceCommand['icon'], () => handleToolClick(id as AnnotationTool), hasDocument, currentTool === id && editingMode === 'none'));
  const find = (id: string) => [...commands, ...annotationCommands].find(item => item.id === id)!;
  const group = (label: string, ids: string[]) => <div className="ribbon-group"><div className="ribbon-group-tools">{ids.map(id => <ToolButton key={id} command={find(id)} />)}</div><span className="ribbon-group-label">{translateMessage(label)}</span></div>;
  const tabs = [
    ['home', 'Home', House], ['edit', 'Edit', Type], ['annotate', 'Annotate', Highlighter], ['organize', 'Organize', Files],
    ['convert', 'Convert', FileOutput], ['forms', 'Forms & Sign', Signature], ['protect', 'Protect', ShieldCheck],
  ] as const;
  return <section ref={toolbarRef} {...menuEvents} className="combined-toolbar workspace-toolbar" inert={isBusy} aria-busy={isBusy}>
    <div className="workspace-tab-row">
      <nav className="workspace-tabs" role="tablist" aria-label={t("m.workspace.tools.7b36c6")}>{tabs.map(([id, label, Icon]) => <button key={id} type="button" role="tab" id={`workspace-${id}`} aria-selected={workspace === id} aria-controls="workspace-ribbon" tabIndex={workspace === id ? 0 : -1} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const position = tabs.findIndex(tab => tab[0] === id);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (position + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          changeWorkspace(tabs[next][0]); document.getElementById(`workspace-${tabs[next][0]}`)?.focus();
        }} onClick={() => changeWorkspace(id)}><Icon size={16} /><span>{translateMessage(label)}</span></button>)}</nav>
      <div className="workspace-history">
        <button className="toolbar-btn icon-only" onClick={onUndo} disabled={!canUndo} title={undoActionName ? t("m.undo.ctrl.z.60a1ee", { v0: translateMessage(undoActionName) }) : t("m.undo.ctrl.z.26039c")} aria-label={undoActionName ? t("m.undo.dbfb05", { v0: translateMessage(undoActionName) }) : t("m.undo.39fc72")}><Undo2 size={17} /></button>
        <button className="toolbar-btn icon-only" onClick={onRedo} disabled={!canRedo} title={redoActionName ? t("m.redo.ctrl.shift.z.f1f904", { v0: translateMessage(redoActionName) }) : t("m.redo.ctrl.shift.z.c4d794")} aria-label={redoActionName ? t("m.redo.1a011b", { v0: translateMessage(redoActionName) }) : t("m.redo.471b94")}><Redo2 size={17} /></button>
        <button type="button" className="toolbar-btn all-tools-trigger" onClick={() => toggleMenu('document')} data-toolbar-menu-trigger="document" aria-expanded={showDocumentMenu} aria-controls="toolbar-document-menu"><LayoutGrid size={16} /><span>{t("m.all.tools.b390ab")}</span><ChevronDown size={12} /></button>
        <button type="button" className={`toolbar-btn icon-only ${inspectorOpen ? 'active' : ''}`} title={t("m.properties.bc6c88")} aria-label={t("m.toggle.properties.c12733")} aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}><SlidersHorizontal size={17} /></button>
      </div>
    </div>
    <div className="workspace-ribbon" id="workspace-ribbon" role="tabpanel" aria-labelledby={`workspace-${workspace}`}>
      {workspace === 'home' && <>{group(t("m.text.images.25bcef"), ['edit-text', 'edit-images', 'insert-image'])}{group(t("m.review.sign.acf4a5"), ['highlight', 'freetext', 'signature'])}{group(t("m.document.tools.044791"), ['merge', 'split', 'ocr', 'compress'])}</>}
      {workspace === 'edit' && <>{group(t("m.text.images.25bcef"), ['edit-text', 'edit-images', 'insert-image', 'freetext'])}{group(t("m.document.tools.044791"), ['links', 'bookmarks', 'appearance'])}</>}
      {workspace === 'annotate' && <>{group(t("m.markup.3d221e"), ['highlight', 'underline', 'strikeout'])}{group(t("m.draw.bfa50c"), ['ink', 'line', 'arrow', 'rectangle', 'ellipse'])}{group(t("m.notes.stamps.a8aea3"), ['sticky-note', 'freetext'])}<div className="ribbon-group"><button type="button" className="workspace-tool" disabled={!hasDocument || isBusy} title={t("m.stamp.973fc7")} onClick={() => toggleMenu('stamp')} data-toolbar-menu-trigger="stamp" aria-expanded={activeMenu === 'stamp'} aria-controls="toolbar-stamp-menu"><Stamp size={21} /><span>{t("m.stamp.973fc7")}</span></button></div></>}
      {workspace === 'organize' && <>{group(t("m.pages.600584"), ['merge', 'split', 'rotate-left', 'rotate-right', 'rotate-180', 'delete-pages'])}{group(t("m.insert.pages.5cca93"), ['blank-before', 'blank-after', 'blank-end', 'pdf-before', 'pdf-after'])}</>}
      {workspace === 'convert' && <>{group(t("m.create.export.ced19b"), ['create-pdf', 'export-pages'])}{group(t("m.recognize.optimize.c5cdd5"), ['ocr', 'compress'])}</>}
      {workspace === 'forms' && <>{group(t("m.form.tools.b442aa"), ['form-designer', 'signature'])}{group(t("m.form.data.97ee0f"), ['form-import', 'form-json', 'form-fdf', 'form-xfdf', 'form-reset', 'form-flatten'])}</>}
      {workspace === 'protect' && <>{group(t("m.document.protection.3f11e2"), ['encrypt', 'clean'])}{group(t("m.content.removal.5f172b"), ['mark-content', 'apply-marks', 'remove-content'])}</>}
      <div className="ribbon-context">
        {hasDocument && (hasContentEdits || editingMode === 'text') && onApplyContent && <button className="toolbar-btn apply-content" disabled={!hasContentEdits} onClick={onApplyContent}>{t("m.apply.content.changes.ccfad2")}</button>}
        <div id="pdf-text-edit-controls" className={`pdf-text-edit-controls ${editingMode === 'text' ? 'active' : ''}`}>
          {editingMode === 'text' && <button type="button" className="toolbar-btn" onClick={() => { commitPendingEditors(); handleToolClick('select'); }}><Check size={15} />{t("m.done.e9b450")}</button>}
          {editingMode === 'text' && !selectedBlockId && <span>{t("m.click.text.in.the.pdf.to.edit.cd73d4")}</span>}
        </div>
      </div>
    </div>
    {hasDocument && <div className="quick-tools" role="toolbar" aria-label={t("m.quick.annotation.tools.b6b90d")}>{annotationCommands.map(item => <ToolButton key={item.id} command={item} compact />)}<button type="button" className={`workspace-tool compact ${currentTool === 'stamp' ? 'active' : ''}`} title={t("m.stamp.973fc7")} aria-label={t("m.stamp.973fc7")} disabled={isBusy} onClick={() => toggleMenu('stamp')} data-toolbar-menu-trigger="stamp" aria-expanded={activeMenu === 'stamp'} aria-controls="toolbar-stamp-menu"><Stamp size={18} /></button></div>}
    {showDocumentMenu && <div className="toolbar-menu workspace-all-tools" id="toolbar-document-menu" data-toolbar-menu="document" role="group" aria-label={t("m.all.tools.b390ab")}>{['Edit', 'Organize', 'Convert', 'Forms & Sign', 'Protect', 'Document'].map(section => <div className="all-tools-section" key={section}><h3>{translateMessage(section)}</h3>{commands.filter(item => item.group === section).map(item => <button key={item.id} type="button" disabled={item.disabled} data-command={item.id} onClick={event => { closeMenus(); item.run(event); }}><item.icon size={16} /><span>{item.label}</span></button>)}</div>)}</div>}
    {activeMenu === 'stamp' && <div className="toolbar-menu stamp-menu" id="toolbar-stamp-menu" data-toolbar-menu="stamp" role="group" aria-label={t("m.stamp.menu.2171e3")}><span className="menu-section-label">{t("m.predefined.bc3e74")}</span>{PREDEFINED_STAMPS.map(stamp => <button key={stamp} aria-pressed={selectedStamp.type === 'predefined' && selectedStamp.name === stamp} onClick={() => chooseStamp({ type: 'predefined', name: stamp })}>{translateMessage(stamp)}</button>)}{customStamps.length > 0 && <span className="menu-section-label">{t("m.custom.081ae3")}</span>}{customStamps.map((stamp, index) => <button key={`${stamp.name}-${index}`} aria-pressed={selectedStamp.type === 'custom' && selectedStamp.name === stamp.name} onClick={() => chooseCustomStamp(stamp)}>{stamp.name}</button>)}<button onClick={() => stampInputRef.current?.click()}>{t("m.add.custom.63c20a")}</button></div>}
    {hasDocument && currentTool !== 'select' && currentTool !== 'pan' && <div className="workspace-tool-options" role="group" aria-label={t("m.tool.properties.ae93ea")}>
      {currentTool === 'stamp' ? <span role="status">{t("m.stamp.5c5029")}{' '}{selectedStamp.type === 'predefined' ? translateMessage(selectedStamp.name) : selectedStamp.name}{' '}{t("m.click.the.page.to.place.1a34c4")}</span> : <label>{t("m.color.1d0c83")}<input type="color" aria-label={t("m.annotation.color.c86abe")} className="color-input" value={toolSettings.color} onChange={handleColorChange} /></label>}
      {['highlight', 'rectangle', 'ellipse'].includes(currentTool) && <label>{t("m.opacity.f0fa69")}<input type="range" aria-label={t("m.annotation.opacity.7ca132")} min="0.1" max="1" step="0.1" value={toolSettings.opacity} onChange={handleOpacityChange} /></label>}
      {['ink', 'line', 'arrow', 'rectangle', 'ellipse'].includes(currentTool) && <label>{t("m.stroke.width.07d2ad")}<input type="range" aria-label={t("m.stroke.width.71c051")} min="1" max="10" step="1" value={toolSettings.strokeWidth} onChange={handleStrokeWidthChange} /></label>}
    </div>}
    {shownImageRead && <div className="image-read-feedback"><span role={shownImageRead.status === 'error' ? 'alert' : 'status'}>{translateMessage(shownImageRead.message)}</span><button className="toolbar-btn" onClick={cancelImageRead}>{shownImageRead.status === 'loading' ? t("m.cancel.image.loading.6ec197") : t("m.dismiss.image.error.a0b1d9")}</button></div>}
    <input ref={imageInputRef} type="file" accept={SUPPORTED_IMAGE_EXTENSIONS} multiple disabled={isBusy || !hasDocument || !onInsertImage} aria-label={t("m.insert.images.f4a261")} onChange={handleImageFileChange} hidden />
    <input ref={stampInputRef} type="file" accept="image/*" aria-label={t("m.custom.stamp.image.96a754")} disabled={isBusy || !hasDocument} onChange={handleStampFileChange} hidden />
  </section>;
}
