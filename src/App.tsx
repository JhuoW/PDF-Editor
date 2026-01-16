import { useCallback, useEffect, useRef, useState } from 'react';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import { usePDFDocument } from './hooks/usePDFDocument';
import { useUIStore } from './store/uiStore';
import { useSearchStore } from './store/searchStore';
import { useHistoryStore } from './store/historyStore';
import { MainToolbar } from './components/Toolbar/MainToolbar';
import { CombinedToolbar, type PendingImageData } from './components/Toolbar/CombinedToolbar';
import { PDFViewer, type LinkDestination } from './components/PDFViewer/PDFViewer';
import { ThumbnailPanel } from './components/Sidebar/ThumbnailPanel';
import { OutlinePanel } from './components/Sidebar/OutlinePanel';
import { SearchDialog } from './components/Dialogs/SearchDialog';
import { GoToPageDialog } from './components/Dialogs/GoToPageDialog';
import { MergeDialog } from './components/Dialogs/MergeDialog';
import { SplitDialog } from './components/Dialogs/SplitDialog';
import { ConfirmationDialog } from './components/Dialogs/ConfirmationDialog';
import {
  rotatePages,
  deletePages,
  insertBlankPages,
  insertPagesFromPDF,
  downloadPDF,
} from './core/PDFManipulator';
import { loadCurrentPDF, saveCurrentPDF } from './utils/pdfStorage';
import { useAnnotationStore } from './store/annotationStore';
import { useAnnotationHistoryStore } from './store/annotationHistoryStore';
import { useTiptapEditor } from './store/textBoxStore';
import { TipTapToolbar } from './components/Toolbar/TipTapToolbar';
import { ImageToolbar } from './components/ImageToolbar';
import type { ImageAnnotation } from './annotations/types';
import { useFormStore } from './store/formStore';
import { serializeAnnotationsToPDF } from './annotations/AnnotationSerializer';
import { extractFormFields, updateFormFieldValues } from './forms/FormFieldExtractor';
import { exportToJSON, exportToFDF, exportToXFDF, importFromJSON, importFromFDF, importFromXFDF, downloadFormData, readFileAsText } from './forms/FormDataIO';
import { flattenForm } from './forms/FormFlattener';
import { useEditingStore } from './store/editingStore';
import { applyRedactions } from './editing/RedactionApplier';
import './App.css';

type SidebarTab = 'thumbnails' | 'outline';

function App() {
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbnails');
  const [highlightDest, setHighlightDest] = useState<LinkDestination | null>(null);
  const [goToPageOpen, setGoToPageOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeDialogKey, setMergeDialogKey] = useState(0);  // Key to force remount
  const [mergeDocumentData, setMergeDocumentData] = useState<{ data: ArrayBuffer; fileName: string; totalPages: number } | null>(null);
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  // Pending images waiting to be placed on the PDF
  const [pendingImages, setPendingImages] = useState<PendingImageData[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const isInitialLoad = useRef(true);

  const {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    loadFromFile,
    goToPage,
    nextPage,
    previousPage,
    zoomIn,
    zoomOut,
    setZoom,
    fitToPage,
    fitToWidth,
    setViewMode,
    rotate,
    setCurrentPage,
  } = usePDFDocument();

  const { sidebarOpen, searchOpen, toggleSidebar, toggleSearch } = useUIStore();
  const { query: searchQuery, clearSearch, getCurrentResult } = useSearchStore();
  const { annotations: annotationMap, addAnnotation, deleteAnnotation, updateAnnotation, currentTool, setCurrentTool, selectedAnnotationId, selectAnnotation, getAllAnnotations } = useAnnotationStore();
  const {
    undo: annotationUndo,
    redo: annotationRedo,
    canUndo: canUndoAnnotation,
    canRedo: canRedoAnnotation,
    clear: clearAnnotationHistory,
  } = useAnnotationHistoryStore();
  const { fields: formFields, setFields: setFormFields, resetToOriginal: resetFormToOriginal, clearForm } = useFormStore();
  const { redactions, markRedactionApplied } = useEditingStore();
  const {
    pushState,
    undo: historyUndo,
    redo: historyRedo,
    canUndo,
    canRedo,
    clearHistory,
    getUndoActionName,
    getRedoActionName,
    setOriginalDocument,
    getOriginalDocument,
    setUndoRedoInProgress,
  } = useHistoryStore();

  // Get current active search result
  const currentResult = getCurrentResult();

  // TipTap editor for text box formatting toolbar
  const tiptapEditor = useTiptapEditor();

  // Get selected image annotation (if any)
  const selectedImageAnnotation = selectedAnnotationId
    ? getAllAnnotations().find(a => a.id === selectedAnnotationId && a.type === 'image') as ImageAnnotation | undefined
    : undefined;

  // Warn user about losing changes when refreshing or leaving the page
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Only show warning if there's a document loaded (potential unsaved changes)
      if (document) {
        e.preventDefault();
        // Modern browsers require returnValue to be set
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [document]);

  // Initialize history when a NEW document is loaded (not on undo/redo reloads)
  useEffect(() => {
    if (!document) {
      clearHistory();
      clearAnnotationHistory();
      isInitialLoad.current = true;
      return;
    }

    // Only set original document on initial load, not on subsequent reloads
    if (isInitialLoad.current) {
      const initHistory = async () => {
        try {
          const stored = await loadCurrentPDF();
          if (stored) {
            // Store the original document for "Reset to Original" feature
            setOriginalDocument(stored.data, stored.fileName);
          }
        } catch (err) {
          console.error('Failed to initialize history:', err);
        }
      };

      initHistory();
      isInitialLoad.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]); // Only run when document object changes

  // Extract form fields when a document is loaded
  useEffect(() => {
    if (!document) {
      clearForm();
      return;
    }

    const extractFields = async () => {
      try {
        const stored = await loadCurrentPDF();
        if (stored) {
          const fields = await extractFormFields(stored.data);
          setFormFields(fields);
        }
      } catch (err) {
        console.error('Failed to extract form fields:', err);
      }
    };

    extractFields();
  }, [document, documentVersion, setFormFields, clearForm]);

  // Handle internal PDF link clicks (citations, etc.)
  const handleLinkClick = useCallback(
    async (dest: unknown) => {
      if (!document) return;

      try {
        let pageNumber: number | null = null;
        let destArray: unknown[] | null = null;

        if (typeof dest === 'string') {
          // Named destination - resolve it
          const destination = await document.getDestination(dest);
          if (destination) {
            destArray = destination;
            const ref = destination[0];
            pageNumber = await document.getPageIndex(ref) + 1;
          }
        } else if (Array.isArray(dest)) {
          // Explicit destination array [ref, /XYZ, left, top, zoom] or similar
          destArray = dest;
          const ref = dest[0];
          if (ref && typeof ref === 'object' && 'num' in ref) {
            pageNumber = await document.getPageIndex(ref) + 1;
          }
        }

        if (pageNumber && pageNumber >= 1 && pageNumber <= navigation.totalPages) {
          // Extract coordinates from destination array
          // Format: [pageRef, /XYZ, left, top, zoom] or [pageRef, /FitH, top] etc.
          let top: number | undefined;
          let left: number | undefined;

          if (destArray && destArray.length > 2) {
            const destType = destArray[1];
            if (destType && typeof destType === 'object' && 'name' in destType) {
              const typeName = (destType as { name: string }).name;
              if (typeName === 'XYZ' && destArray.length >= 4) {
                // [ref, /XYZ, left, top, zoom]
                left = typeof destArray[2] === 'number' ? destArray[2] : undefined;
                top = typeof destArray[3] === 'number' ? destArray[3] : undefined;
              } else if (typeName === 'FitH' || typeName === 'FitBH') {
                // [ref, /FitH, top] or [ref, /FitBH, top]
                top = typeof destArray[2] === 'number' ? destArray[2] : undefined;
              } else if (typeName === 'FitR' && destArray.length >= 6) {
                // [ref, /FitR, left, bottom, right, top]
                left = typeof destArray[2] === 'number' ? destArray[2] : undefined;
                top = typeof destArray[5] === 'number' ? destArray[5] : undefined;
              }
            }
          }

          // Set highlight destination (will trigger highlight animation)
          setHighlightDest({ pageNumber, top, left });

          // Clear highlight after animation
          setTimeout(() => setHighlightDest(null), 2500);

          goToPage(pageNumber);
        }
      } catch (error) {
        console.error('Error navigating to link destination:', error);
      }
    },
    [document, goToPage, navigation.totalPages]
  );

  // Helper to reload PDF after modification
  const reloadModifiedPDF = useCallback(async (data: Uint8Array, actionName?: string) => {
    // Save current state to history before modification
    const stored = await loadCurrentPDF();
    if (stored && actionName) {
      pushState(stored.data, stored.fileName, actionName);
    }

    // Save to storage
    await saveCurrentPDF(data.buffer as ArrayBuffer, stored?.fileName || 'document.pdf');

    // Create a file and reload
    const blob = new Blob([new Uint8Array(data)], { type: 'application/pdf' });
    const file = new File([blob], stored?.fileName || 'document.pdf', { type: 'application/pdf' });
    await loadFromFile(file);
  }, [loadFromFile, pushState]);

  // Handle undo action
  const handleUndo = useCallback(async () => {
    // First check if there's an annotation operation to undo
    if (canUndoAnnotation()) {
      const entry = annotationUndo();
      if (entry) {
        switch (entry.type) {
          case 'add':
            // Undo add = delete the annotation
            deleteAnnotation(entry.annotation.id);
            break;
          case 'update':
            // Undo update = restore previous state
            if (entry.previousState) {
              updateAnnotation(entry.annotation.id, entry.previousState);
            }
            break;
          case 'delete':
            // Undo delete = re-add the annotation
            addAnnotation(entry.annotation);
            break;
        }
        return;
      }
    }

    // Fall back to document history
    const snapshot = historyUndo();
    if (!snapshot) return;

    try {
      // Mark that we're in undo/redo to prevent history recording
      setUndoRedoInProgress(true);

      // Save to storage and reload
      await saveCurrentPDF(snapshot.data, snapshot.fileName);
      const blob = new Blob([snapshot.data], { type: 'application/pdf' });
      const file = new File([blob], snapshot.fileName, { type: 'application/pdf' });
      await loadFromFile(file);

      // Clear the flag after reload
      setUndoRedoInProgress(false);
    } catch (err) {
      console.error('Failed to undo:', err);
      setUndoRedoInProgress(false);
    }
  }, [historyUndo, loadFromFile, setUndoRedoInProgress, canUndoAnnotation, annotationUndo, deleteAnnotation, updateAnnotation, addAnnotation]);

  // Handle redo action
  const handleRedo = useCallback(async () => {
    // First check if there's an annotation operation to redo
    if (canRedoAnnotation()) {
      const entry = annotationRedo();
      if (entry) {
        switch (entry.type) {
          case 'add':
            // Redo add = re-add the annotation
            addAnnotation(entry.annotation);
            break;
          case 'update':
            // Redo update = apply the updated state
            updateAnnotation(entry.annotation.id, entry.annotation);
            break;
          case 'delete':
            // Redo delete = delete the annotation again
            deleteAnnotation(entry.annotation.id);
            break;
        }
        return;
      }
    }

    // Fall back to document history
    const snapshot = historyRedo();
    if (!snapshot) return;

    try {
      // Mark that we're in undo/redo to prevent history recording
      setUndoRedoInProgress(true);

      // Save to storage and reload
      await saveCurrentPDF(snapshot.data, snapshot.fileName);
      const blob = new Blob([snapshot.data], { type: 'application/pdf' });
      const file = new File([blob], snapshot.fileName, { type: 'application/pdf' });
      await loadFromFile(file);

      // Clear the flag after reload
      setUndoRedoInProgress(false);
    } catch (err) {
      console.error('Failed to redo:', err);
      setUndoRedoInProgress(false);
    }
  }, [historyRedo, loadFromFile, setUndoRedoInProgress, canRedoAnnotation, annotationRedo, addAnnotation, updateAnnotation, deleteAnnotation]);

  // Handle page rotation
  const handleRotatePages = useCallback(async (pages: number[], degrees: 90 | -90 | 180) => {
    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      const rotated = await rotatePages(stored.data, pages, degrees);
      const actionName = `Rotate ${pages.length > 1 ? `${pages.length} pages` : `page ${pages[0]}`} ${degrees}°`;
      await reloadModifiedPDF(rotated, actionName);
      setSelectedPages([]);
    } catch (err) {
      console.error('Failed to rotate pages:', err);
    }
  }, [reloadModifiedPDF]);

  // Handle page deletion
  const handleDeletePages = useCallback(async (pages: number[]) => {
    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      const modified = await deletePages(stored.data, pages);
      const actionName = `Delete ${pages.length > 1 ? `${pages.length} pages` : `page ${pages[0]}`}`;
      await reloadModifiedPDF(modified, actionName);
      setSelectedPages([]);

      // Adjust current page if needed
      if (navigation.currentPage > navigation.totalPages - pages.length) {
        goToPage(Math.max(1, navigation.totalPages - pages.length));
      }
    } catch (err) {
      console.error('Failed to delete pages:', err);
    }
  }, [reloadModifiedPDF, navigation.currentPage, navigation.totalPages, goToPage]);

  // Handle insert blank page
  const handleInsertBlankPage = useCallback(async (position: number) => {
    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      const modified = await insertBlankPages(stored.data, { position });
      await reloadModifiedPDF(modified, 'Insert blank page');
    } catch (err) {
      console.error('Failed to insert blank page:', err);
    }
  }, [reloadModifiedPDF]);

  // Handle insert pages from file
  const handleInsertFromFile = useCallback(async (position: number) => {
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const stored = await loadCurrentPDF();
        if (!stored) return;

        const insertData = await file.arrayBuffer();
        const modified = await insertPagesFromPDF(stored.data, insertData, position);
        await reloadModifiedPDF(modified, `Insert pages from ${file.name}`);
      } catch (err) {
        console.error('Failed to insert pages from file:', err);
      }
    };
    input.click();
  }, [reloadModifiedPDF]);

  // Handle export/download
  const handleExport = useCallback(async () => {
    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      // Update form field values in the PDF
      let pdfData: ArrayBuffer = stored.data;
      if (formFields.length > 0) {
        const fieldValues = new Map<string, string | boolean | string[]>();
        formFields.forEach(field => {
          fieldValues.set(field.name, field.value);
        });
        const updatedPdf = await updateFormFieldValues(stored.data, fieldValues);
        pdfData = updatedPdf.buffer as ArrayBuffer;
      }

      // Serialize annotations to the PDF before exporting
      let finalData: Uint8Array;
      if (annotationMap.size > 0) {
        finalData = await serializeAnnotationsToPDF(pdfData, annotationMap);
      } else {
        finalData = new Uint8Array(pdfData);
      }

      await downloadPDF(finalData, stored.fileName || 'document.pdf');
    } catch (err) {
      console.error('Failed to export PDF:', err);
    }
  }, [annotationMap, formFields]);

  // Handle form data export
  const handleExportFormData = useCallback(async (format: 'json' | 'fdf' | 'xfdf') => {
    try {
      const stored = await loadCurrentPDF();
      const fileName = stored?.fileName?.replace('.pdf', '') || 'form-data';

      let content: string;
      let extension: string;
      let mimeType: string;

      switch (format) {
        case 'json':
          content = exportToJSON(formFields, { pdfFileName: stored?.fileName });
          extension = 'json';
          mimeType = 'application/json';
          break;
        case 'fdf':
          content = exportToFDF(formFields, { pdfFileName: stored?.fileName });
          extension = 'fdf';
          mimeType = 'application/vnd.fdf';
          break;
        case 'xfdf':
          content = exportToXFDF(formFields, { pdfFileName: stored?.fileName });
          extension = 'xfdf';
          mimeType = 'application/vnd.adobe.xfdf';
          break;
      }

      downloadFormData(content, `${fileName}.${extension}`, mimeType);
    } catch (err) {
      console.error('Failed to export form data:', err);
    }
  }, [formFields]);

  // Handle form data import
  const handleImportFormData = useCallback(async () => {
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.fdf,.xfdf';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const content = await readFileAsText(file);
        let fieldValues: Map<string, string | boolean | string[]>;

        if (file.name.endsWith('.json')) {
          fieldValues = importFromJSON(content);
        } else if (file.name.endsWith('.fdf')) {
          fieldValues = importFromFDF(content);
        } else if (file.name.endsWith('.xfdf')) {
          fieldValues = importFromXFDF(content);
        } else {
          throw new Error('Unsupported file format');
        }

        // Update form fields with imported values
        const updatedFields = formFields.map(field => {
          const newValue = fieldValues.get(field.name);
          return newValue !== undefined ? { ...field, value: newValue } : field;
        });
        setFormFields(updatedFields);

        alert(`Imported ${fieldValues.size} field values`);
      } catch (err) {
        console.error('Failed to import form data:', err);
        alert('Failed to import form data: ' + (err as Error).message);
      }
    };
    input.click();
  }, [formFields, setFormFields]);

  // Handle form flatten
  const handleFlattenForm = useCallback(async () => {
    if (!confirm('Flatten form? This will convert all form fields to static content and cannot be undone.')) {
      return;
    }

    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      // First update form values
      let pdfData: ArrayBuffer = stored.data;
      if (formFields.length > 0) {
        const fieldValues = new Map<string, string | boolean | string[]>();
        formFields.forEach(field => {
          fieldValues.set(field.name, field.value);
        });
        const updatedPdf = await updateFormFieldValues(stored.data, fieldValues);
        pdfData = updatedPdf.buffer as ArrayBuffer;
      }

      // Then flatten
      const flattenedPdf = await flattenForm(pdfData);
      await reloadModifiedPDF(flattenedPdf, 'Flatten form');

      // Clear form fields since they're now static
      clearForm();
    } catch (err) {
      console.error('Failed to flatten form:', err);
      alert('Failed to flatten form: ' + (err as Error).message);
    }
  }, [formFields, reloadModifiedPDF, clearForm]);

  // Handle form reset
  const handleResetForm = useCallback(() => {
    resetFormToOriginal();
  }, [resetFormToOriginal]);

  // Handle apply redactions
  const handleApplyRedactions = useCallback(async () => {
    const pendingRedactions = redactions.filter(r => !r.applied);
    if (pendingRedactions.length === 0) return;

    const confirmMsg = `Apply ${pendingRedactions.length} redaction${pendingRedactions.length !== 1 ? 's' : ''}? This will permanently remove the content underneath and cannot be undone.`;
    if (!confirm(confirmMsg)) return;

    try {
      const stored = await loadCurrentPDF();
      if (!stored) return;

      const result = await applyRedactions(stored.data, pendingRedactions);

      if (!result.success || !result.modifiedPdf) {
        alert('Failed to apply redactions:\n' + result.errors.join('\n'));
        return;
      }

      // Mark all redactions as applied
      pendingRedactions.forEach(r => markRedactionApplied(r.id));

      // Save and reload
      await saveCurrentPDF(result.modifiedPdf.buffer as ArrayBuffer, stored.fileName);
      await reloadModifiedPDF(result.modifiedPdf, `apply ${result.appliedCount} redaction(s)`);

      alert(`Successfully applied ${result.appliedCount} redaction(s)`);
    } catch (err) {
      console.error('Failed to apply redactions:', err);
      alert('Failed to apply redactions: ' + (err as Error).message);
    }
  }, [redactions, markRedactionApplied, reloadModifiedPDF]);

  // Handle image insertion - set pending images and switch to image tool
  const handleInsertImage = useCallback((images: PendingImageData[]) => {
    if (images.length === 0) return;
    setPendingImages(images);
    // Switch to image placement mode
    setCurrentTool('image');
  }, [setCurrentTool]);

  // Handle reset to original - restore original PDF state
  const handleResetToOriginal = useCallback(async () => {
    const original = getOriginalDocument();
    if (!original) return;

    try {
      // Mark as undo/redo to prevent history recording
      setUndoRedoInProgress(true);

      // Save original to storage and reload
      await saveCurrentPDF(original.data, original.fileName);
      const blob = new Blob([original.data], { type: 'application/pdf' });
      const file = new File([blob], original.fileName, { type: 'application/pdf' });
      await loadFromFile(file);

      // Clear all history stacks but keep original
      clearHistory();
      clearAnnotationHistory();
      setOriginalDocument(original.data, original.fileName);

      setUndoRedoInProgress(false);
      setResetDialogOpen(false);
    } catch (err) {
      console.error('Failed to reset to original:', err);
      setUndoRedoInProgress(false);
    }
  }, [getOriginalDocument, loadFromFile, clearHistory, clearAnnotationHistory, setOriginalDocument, setUndoRedoInProgress]);

  // Handle close document - clear everything and return to empty state
  const handleCloseDocument = useCallback(async () => {
    try {
      // Clear storage
      const { clearCurrentPDF } = await import('./utils/pdfStorage');
      await clearCurrentPDF();

      // Clear all state
      clearHistory();
      clearAnnotationHistory();

      // Reset to initial load state
      isInitialLoad.current = true;

      // Reload to clear document (this will trigger the empty state)
      window.location.reload();
    } catch (err) {
      console.error('Failed to close document:', err);
    }
  }, [clearHistory, clearAnnotationHistory]);

  // Check if we can reset to original (has original and has made changes)
  const canResetToOriginal = useCallback(() => {
    return getOriginalDocument() !== null && canUndo();
  }, [getOriginalDocument, canUndo]);

  // Handle opening merge dialog
  const handleOpenMergeDialog = useCallback(async () => {
    // Increment key to force fresh dialog state (empty file list)
    setMergeDialogKey(k => k + 1);

    // Load current document data if available (for insert position options)
    if (document) {
      try {
        const stored = await loadCurrentPDF();
        if (stored) {
          setMergeDocumentData({
            data: stored.data,
            fileName: stored.fileName,
            totalPages: document.numPages,
          });
        } else {
          setMergeDocumentData(null);
        }
      } catch (err) {
        console.error('Failed to load current PDF for merge:', err);
        setMergeDocumentData(null);
      }
    } else {
      setMergeDocumentData(null);
    }

    setMergeDialogOpen(true);
  }, [document]);

  // Handle page selection (from thumbnail panel)
  const handlePageSelection = useCallback((pageNum: number, multiSelect: boolean) => {
    if (multiSelect) {
      setSelectedPages(prev => {
        if (prev.includes(pageNum)) {
          return prev.filter(p => p !== pageNum);
        }
        return [...prev, pageNum].sort((a, b) => a - b);
      });
    } else {
      setSelectedPages([]);
      goToPage(pageNum);
    }
  }, [goToPage]);

  // Handle file drop
  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.currentTarget.classList.remove('drag-over');
      const file = event.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') {
        await loadFromFile(file);
      }
    },
    [loadFromFile]
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.classList.add('drag-over');
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.currentTarget.classList.remove('drag-over');
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger if typing in an input
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Also check if the target has contenteditable or is within a text editor
      const target = event.target as HTMLElement;
      if (target.isContentEditable || target.closest('.rich-text-editor') || target.closest('.freetext-editor-container')) {
        return;
      }

      const isMod = event.ctrlKey || event.metaKey;

      // Global shortcuts
      if (isMod && event.key === 'o') {
        event.preventDefault();
        // Trigger file open dialog
        const input = window.document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (file) await loadFromFile(file);
        };
        input.click();
        return;
      }

      if (isMod && event.key === 'f') {
        event.preventDefault();
        toggleSearch();
        return;
      }

      if (isMod && event.key === 'g') {
        event.preventDefault();
        if (document) {
          setGoToPageOpen(true);
        }
        return;
      }

      // Undo: Ctrl+Z / Cmd+Z
      if (isMod && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (canUndo()) {
          handleUndo();
        }
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y
      if ((isMod && event.key === 'z' && event.shiftKey) || (isMod && event.key === 'y')) {
        event.preventDefault();
        if (canRedo()) {
          handleRedo();
        }
        return;
      }

      // Document-specific shortcuts
      if (!document) return;

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          if (!isMod) {
            event.preventDefault();
            previousPage();
          }
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          if (!isMod) {
            event.preventDefault();
            nextPage();
          }
          break;
        case '+':
        case '=':
          event.preventDefault();
          zoomIn();
          break;
        case '-':
          event.preventDefault();
          zoomOut();
          break;
        case 'r':
          if (isMod) {
            event.preventDefault();
            rotate(90);
          }
          break;
        case 'Home':
          event.preventDefault();
          goToPage(1);
          break;
        case 'End':
          event.preventDefault();
          goToPage(navigation.totalPages);
          break;
        case 'Escape':
          if (goToPageOpen) {
            setGoToPageOpen(false);
          } else if (searchOpen) {
            toggleSearch();
            clearSearch();
          }
          break;
        case 'b':
          // Toggle sidebar
          if (!isMod) {
            event.preventDefault();
            toggleSidebar();
          }
          break;
        case 's':
          // Save/Export with Ctrl+S
          if (isMod) {
            event.preventDefault();
            handleExport();
          }
          break;
        case '0':
          // Reset zoom with Ctrl+0
          if (isMod) {
            event.preventDefault();
            setZoom(1.0);
          }
          break;
        // Tool shortcuts (only without modifiers)
        case 'v':
        case 'V':
          if (!isMod) {
            event.preventDefault();
            setCurrentTool('select');
          }
          break;
        case 'h':
        case 'H':
          if (!isMod) {
            event.preventDefault();
            setCurrentTool('pan');
          }
          break;
        // Removed drawing tool shortcuts (t, d) - tools are selected via toolbar only
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    document,
    loadFromFile,
    previousPage,
    nextPage,
    zoomIn,
    zoomOut,
    rotate,
    goToPage,
    navigation.totalPages,
    toggleSearch,
    toggleSidebar,
    searchOpen,
    clearSearch,
    goToPageOpen,
    handleUndo,
    handleRedo,
    handleExport,
    setZoom,
    canUndo,
    canRedo,
    setCurrentTool,
  ]);

  // Mouse wheel: zoom (with Ctrl) or page navigation (single/two-page mode)
  useEffect(() => {
    const wheelTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastWheelTime = 0;

    const handleWheel = (event: WheelEvent) => {
      if (!document) return;

      // Ctrl + wheel = zoom
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          zoomIn();
        } else {
          zoomOut();
        }
        return;
      }

      // In single or two-page mode, wheel turns pages
      if (navigation.viewMode === 'single' || navigation.viewMode === 'two-page') {
        event.preventDefault();

        // Debounce to avoid too fast page turning
        const now = Date.now();
        if (now - lastWheelTime < 200) return;
        lastWheelTime = now;

        if (event.deltaY > 0) {
          nextPage();
        } else if (event.deltaY < 0) {
          previousPage();
        }
      }
      // In continuous mode, let natural scrolling work
    };

    const main = mainRef.current;
    if (main) {
      main.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        main.removeEventListener('wheel', handleWheel);
        if (wheelTimeout) clearTimeout(wheelTimeout);
      };
    }
  }, [document, zoomIn, zoomOut, navigation.viewMode, nextPage, previousPage]);

  return (
    <Theme appearance="dark" accentColor="blue" radius="medium">
      <div className="app-container">
        {/* Main Toolbar */}
        <MainToolbar
          currentPage={navigation.currentPage}
          totalPages={navigation.totalPages}
          zoom={navigation.zoom}
          zoomMode={navigation.zoomMode}
          viewMode={navigation.viewMode}
          sidebarOpen={sidebarOpen}
          onOpenFile={loadFromFile}
          onExport={handleExport}
          onPreviousPage={previousPage}
          onNextPage={nextPage}
          onGoToPage={goToPage}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onSetZoom={setZoom}
          onFitToPage={fitToPage}
          onFitToWidth={fitToWidth}
          onRotate={() => rotate(90)}
          onToggleSidebar={toggleSidebar}
          onSetViewMode={setViewMode}
          onToggleSearch={toggleSearch}
          hasDocument={!!document}
        />

        {/* Combined Toolbar - Page Operations & Annotations */}
        <CombinedToolbar
          currentPage={navigation.currentPage}
          totalPages={navigation.totalPages}
          selectedPages={selectedPages}
          onRotatePages={handleRotatePages}
          onDeletePages={handleDeletePages}
          onInsertBlankPage={handleInsertBlankPage}
          onInsertFromFile={handleInsertFromFile}
          onMerge={handleOpenMergeDialog}
          onSplit={() => setSplitDialogOpen(true)}
          hasDocument={!!document}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo() || canUndoAnnotation()}
          canRedo={canRedo() || canRedoAnnotation()}
          undoActionName={getUndoActionName()}
          redoActionName={getRedoActionName()}
          onResetToOriginal={() => setResetDialogOpen(true)}
          onCloseDocument={() => setCloseDialogOpen(true)}
          canResetToOriginal={canResetToOriginal()}
          onExportFormData={handleExportFormData}
          onImportFormData={handleImportFormData}
          onFlattenForm={handleFlattenForm}
          onResetForm={handleResetForm}
          onApplyRedactions={handleApplyRedactions}
          onInsertImage={handleInsertImage}
        />

        {/* Text Box Formatting Toolbar (shown when editing text box) */}
        {tiptapEditor && (
          <div className="textbox-format-toolbar-container">
            <TipTapToolbar editor={tiptapEditor} />
          </div>
        )}

        {/* Image Toolbar (shown when image is selected) */}
        {selectedImageAnnotation && !tiptapEditor && (
          <div className="image-format-toolbar-container">
            <ImageToolbar
              annotation={selectedImageAnnotation}
              onDelete={() => selectAnnotation(null)}
            />
          </div>
        )}

        {/* Main content area */}
        <div className="main-layout" role="region" aria-label="PDF document viewer">
          {/* Sidebar */}
          {document && sidebarOpen && (
            <aside className="sidebar" role="complementary" aria-label="Document navigation">
              <div className="sidebar-tabs" role="tablist" aria-label="Sidebar views">
                <button
                  className={`sidebar-tab ${sidebarTab === 'thumbnails' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('thumbnails')}
                  role="tab"
                  aria-selected={sidebarTab === 'thumbnails'}
                  aria-controls="thumbnail-panel"
                >
                  Pages
                </button>
                <button
                  className={`sidebar-tab ${sidebarTab === 'outline' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('outline')}
                  role="tab"
                  aria-selected={sidebarTab === 'outline'}
                  aria-controls="outline-panel"
                >
                  Bookmarks
                </button>
              </div>
              <div className="sidebar-content">
                {sidebarTab === 'thumbnails' && (
                  <div id="thumbnail-panel" role="tabpanel" aria-label="Page thumbnails">
                    <ThumbnailPanel
                      document={document}
                      currentPage={navigation.currentPage}
                      selectedPages={selectedPages}
                      onPageSelect={handlePageSelection}
                    />
                  </div>
                )}
                {sidebarTab === 'outline' && (
                  <div id="outline-panel" role="tabpanel" aria-label="Document outline">
                    <OutlinePanel
                      document={document}
                      onPageSelect={goToPage}
                    />
                  </div>
                )}
              </div>
            </aside>
          )}

          {/* Main viewer area */}
          <main
            ref={mainRef}
            className="main-content"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            aria-label="Document content"
          >
            {/* Search dialog */}
            {document && searchOpen && (
              <SearchDialog
                document={document}
                onNavigateToPage={goToPage}
                onClose={() => {
                  toggleSearch();
                  clearSearch();
                }}
              />
            )}

            {/* Go to page dialog */}
            {document && goToPageOpen && (
              <GoToPageDialog
                currentPage={navigation.currentPage}
                totalPages={navigation.totalPages}
                onGoToPage={goToPage}
                onClose={() => setGoToPageOpen(false)}
              />
            )}

            {/* Merge dialog */}
            {mergeDialogOpen && (
              <MergeDialog
                key={mergeDialogKey}
                onClose={() => {
                  setMergeDialogOpen(false);
                  setMergeDocumentData(null);
                }}
                onMergeComplete={async (data) => {
                  const actionName = mergeDocumentData ? 'Insert Pages' : 'Merge PDFs';
                  await reloadModifiedPDF(data, actionName);
                  setMergeDialogOpen(false);
                  setMergeDocumentData(null);
                }}
                currentDocument={mergeDocumentData}
              />
            )}

            {/* Split dialog */}
            {document && splitDialogOpen && (
              <SplitDialog
                totalPages={navigation.totalPages}
                onClose={() => setSplitDialogOpen(false)}
              />
            )}

            {/* Reset to Original confirmation dialog */}
            <ConfirmationDialog
              isOpen={resetDialogOpen}
              title="Reset to Original?"
              message="This will discard all changes (rotations, page modifications, annotations, etc.) and restore the original PDF. This action cannot be undone."
              confirmLabel="Reset"
              cancelLabel="Cancel"
              confirmVariant="danger"
              onConfirm={handleResetToOriginal}
              onCancel={() => setResetDialogOpen(false)}
            />

            {/* Close Document confirmation dialog */}
            <ConfirmationDialog
              isOpen={closeDialogOpen}
              title="Close Document?"
              message="Are you sure you want to close this document? Any unsaved changes will be lost."
              confirmLabel="Close Without Saving"
              cancelLabel="Cancel"
              confirmVariant="danger"
              onConfirm={handleCloseDocument}
              onCancel={() => setCloseDialogOpen(false)}
            />

            {/* Loading state */}
            {isLoading && (
              <div className="loading-state">
                <div className="loading-spinner" />
                <span>Loading PDF...</span>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="error-state">
                <span className="error-icon">⚠</span>
                <span>Error: {error}</span>
              </div>
            )}

            {/* Empty state */}
            {!document && !isLoading && !error && (
              <div className="empty-state">
                <div className="drop-zone">
                  <div className="drop-icon">📄</div>
                  <h2>Open a PDF</h2>
                  <p>Drag and drop a PDF file here, or click to select</p>
                  <p className="keyboard-hint">Press <kbd>Ctrl</kbd>+<kbd>O</kbd> to open</p>
                  <button
                    onClick={() => {
                      const input = window.document.createElement('input');
                      input.type = 'file';
                      input.accept = '.pdf';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) await loadFromFile(file);
                      };
                      input.click();
                    }}
                  >
                    Select File
                  </button>
                </div>
              </div>
            )}

            {/* PDF Viewer */}
            {document && !isLoading && (
              <PDFViewer
                document={document}
                documentVersion={documentVersion}
                currentPage={navigation.currentPage}
                scale={navigation.zoom}
                zoomMode={navigation.zoomMode}
                rotation={navigation.rotation}
                viewMode={navigation.viewMode}
                searchQuery={searchQuery}
                activeMatchPage={currentResult?.pageNumber}
                activeMatchIndex={currentResult?.matchIndex}
                onPageChange={setCurrentPage}
                onLinkClick={handleLinkClick}
                onCalculatedZoomChange={(zoom) => setZoom(zoom, navigation.zoomMode)}
                highlightDestination={highlightDest}
                currentTool={currentTool}
                pendingImages={pendingImages}
                onImagePlaced={() => {
                  // Remove the first pending image after it's placed
                  setPendingImages(prev => prev.slice(1));
                  // If no more images, switch back to select tool
                  if (pendingImages.length <= 1) {
                    setCurrentTool('select');
                  }
                }}
              />
            )}
          </main>
        </div>
      </div>
    </Theme>
  );
}

export default App;
