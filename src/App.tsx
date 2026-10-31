import { FontManagerHost } from './components/Fonts/FontManagerHost';
import { useSearchDocument } from './hooks/useSearchDocument';
import { SearchDocumentContext } from './utils/searchDocumentContext';
import { ErrorMessage } from './components/Feedback/ErrorMessage';
import { isAbortError } from './utils/cancellation';
import { useLocale, translateMessage, t } from "./i18n";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import { PDFDocument as PDFLibDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { usePDFExportJob } from './hooks/usePDFExportJob';
import { PDFExportProgressDialog } from './components/Dialogs/PDFExportProgressDialog';
import type { TextCheckIssue } from './editing/TextCheckTypes';
import type { TextBlock } from './editing/types';
import { useDocumentSaveTracking } from './hooks/useDocumentSaveTracking';
import { useDocumentSaveStore, captureDocumentSavePoint, markDocumentSaved, markDocumentUnsaved } from './store/documentSaveStore';
import { useDocumentSessionStore } from './store/documentSession';
import { openPDFFile, savePDFFile, selectSavePDFHandle, ensurePDFWritePermission, canUseNativeSavePicker, canUseNativeOpenPicker, type PDFFileHandle } from './core/DocumentFile';
import { usePageCropStore } from './store/pageCropStore';
import { performDocumentOperation, type DocumentOperationContext, type DocumentOperationResult } from './core/DocumentOperations';
import { deletionPageMap, insertionPageMap, reorderedPageMap } from './core/pageMapping';
import { captureWorkspace, createWorkspace, remapWorkspacePages } from './store/workspaceSnapshot';
import { usePDFDocument } from './hooks/usePDFDocument';
import { useDocumentStore } from './store/documentStore';
import { useUIStore } from './store/uiStore';
import { useSearchStore } from './store/searchStore';
import { useHistoryStore, isWorkspaceEntry } from './store/historyStore';
import { applyWorkspacePatch, commitPendingEditors } from './store/workspaceHistory';
import { MainToolbar } from './components/Toolbar/MainToolbar';
import { CombinedToolbar, type PendingImageData } from './components/Toolbar/CombinedToolbar';
import { PDFViewer, type LinkDestination } from './components/PDFViewer/PDFViewer';
import { ThumbnailPanel } from './components/Sidebar/ThumbnailPanel';
import { OutlinePanel } from './components/Sidebar/OutlinePanel';
import { StickyNoteEditor } from './components/Annotations/StickyNoteEditor';
import { SearchDialog } from './components/Dialogs/SearchDialog';
import { GoToPageDialog } from './components/Dialogs/GoToPageDialog';
import { MergeDialog } from './components/Dialogs/MergeDialog';
import { SplitDialog } from './components/Dialogs/SplitDialog';
import { ConfirmationDialog } from './components/Dialogs/ConfirmationDialog';
import { EncryptDialog } from './components/Dialogs/EncryptDialog';
import { PasswordDialog } from './components/Dialogs/PasswordDialog';
import {
  rotatePages,
  reorderPages,
  deletePages,
  insertBlankPages,
  insertPagesFromPDF,
  splitPDF,
  downloadPDF,
} from './core/PDFManipulator';
import { readActivePDF } from './core/ActiveDocument';
import { useAnnotationStore } from './store/annotationStore';
import { useTiptapEditor } from './store/textBoxStore';
import { TipTapToolbar } from './components/Toolbar/TipTapToolbar';
import { ImageToolbar } from './components/ImageToolbar';
import type { ImageAnnotation } from './annotations/types';
import { serializeAnnotationsToPDF } from './annotations/AnnotationSerializer';
import { useFormStore } from './store/formStore';
import { extractFormFields } from './forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from './forms/WorkspaceFormValues';
import { applyWorkspaceContent, exportWorkspacePDF, flattenWorkspaceForm } from './core/PDFExport';
import { exportToJSON, exportToFDF, exportToXFDF, importFromJSON, importFromFDF, importFromXFDF, normalizeImportedFormValues, downloadFormData, readFileAsText } from './forms/FormDataIO';
import { useEditingStore } from './store/editingStore';
import { applyRedactions } from './editing/RedactionApplier';
import { applySecureRedactions } from './editing/SecureRedaction';
import './App.css';
import './workspace.css';
import { WorkspaceInspector } from './components/Workspace/WorkspaceInspector';
import { FileUp, FilePenLine, Highlighter, Files, ImagePlus, ShieldCheck, History } from 'lucide-react';
import type { OCRDialogProgress, OCRRunOptions } from './components/Dialogs/OCRDialog';
import type { OCRPageResult } from './ocr/recognizePDF';
import type { FormDesignOperation } from './forms/FormDesignerTypes';
import type { PageDecorationOperation } from './core/PageDecorationTypes';
import type { CleanupControl, CleanupOptions } from './core/DocumentCleanupTypes';
import type { WorkspaceSnapshot } from './store/workspaceSnapshot';
import type { TextEditOperation } from './editing/types';
import type { PDFLinkOperation } from './core/PDFLinkTypes';
import type { PDFBookmarkDraft } from './core/PDFBookmarksTypes';
import type { PageManagementAction, PageManagementRequest } from './components/Dialogs/PageManagementDialog';
import { PDF_LINK_SCROLL_INSET, pdfLinkCurrentPosition, pdfLinkNavigationScale, resolvePDFLinkNavigation, retainPDFLinkCoordinates } from './core/PDFLinkNavigation';
import { hasOpenModal, isTextInput } from './utils/keyboard';

const DocumentPropertiesDialog = lazy(() => import('./components/Dialogs/DocumentPropertiesDialog').then(module => ({ default: module.DocumentPropertiesDialog })));
const OCRDialog = lazy(() => import('./components/Dialogs/OCRDialog'));
const CreatePDFDialog = lazy(() => import('./components/Dialogs/CreatePDFDialog'));
const ExportPagesDialog = lazy(() => import('./components/Dialogs/ExportPagesDialog'));
const PageManagementDialog = lazy(() => import('./components/Dialogs/PageManagementDialog'));
const SaveChangesDialog = lazy(() => import('./components/Dialogs/SaveChangesDialog'));
const FormDesignerDialog = lazy(() => import('./components/Dialogs/FormDesignerDialog'));
const PageDecorationsDialog = lazy(() => import('./components/Dialogs/PageDecorationsDialog'));
const CleanDocumentDialog = lazy(() => import('./components/Dialogs/CleanDocumentDialog'));
const CompressPDFDialog = lazy(() => import('./components/Dialogs/CompressPDFDialog'));
const TextLayoutDialog = lazy(() => import('./components/Dialogs/TextLayoutDialog'));
const TextCheckDialog = lazy(() => import('./components/Dialogs/TextCheckDialog').then(module => ({ default: module.TextCheckDialog })));
const UpdateHistoryDialog = lazy(() => import('./components/Dialogs/UpdateHistoryDialog').then(module => ({ default: module.UpdateHistoryDialog })));
const PDFLinksDialog = lazy(() => import('./components/Dialogs/PDFLinksDialog'));
const PDFBookmarksDialog = lazy(() => import('./components/Dialogs/PDFBookmarksDialog'));
const SignatureDialog = lazy(() => import('./components/Dialogs/SignatureDialog'));

async function prepareFormDesignPDF(data: ArrayBuffer, workspace: WorkspaceSnapshot) {
  const content = await applyWorkspaceContent(data, workspace);
  return applyWorkspaceFormValues(new Uint8Array(content).buffer, workspace);
}

async function applyWorkspaceFormValues(data: ArrayBuffer, workspace: WorkspaceSnapshot) {
  return new Uint8Array(await applyCurrentWorkspaceFormValues(data, workspace)).buffer;
}

type SidebarTab = 'thumbnails' | 'outline';

function App() {
  useLocale();
  const { run: runExport, progress: exportProgress, cancel: cancelExport } = usePDFExportJob();
  const historyLimited = useHistoryStore(state => state.historyLimited);
  const contextToolbarHost = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = contextToolbarHost.current;
    if (!host) return;
    const measure = () => host.parentElement?.style.setProperty('--context-toolbar-height', `${host.offsetHeight}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(host); measure();
    return () => observer.disconnect();
  }, []);
  const [navigationHost, setNavigationHost] = useState<HTMLDivElement | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbnails');
  const [narrowViewport, setNarrowViewport] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [highlightDest, setHighlightDest] = useState<{ document: PDFDocumentProxy; version: number; destination: LinkDestination } | null>(null);
  const [goToPageOpen, setGoToPageOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeDialogKey, setMergeDialogKey] = useState(0);  // Key to force remount
  const pendingMergeOpen = useRef<symbol | null>(null);
  const [mergeDocumentData, setMergeDocumentData] = useState<{ data: ArrayBuffer; fileName: string; totalPages: number; documentVersion: number } | null>(null);
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [pageManagementAction, setPageManagementAction] = useState<PageManagementAction | null>(null);
  const [cropMargins, setCropMargins] = useState<PageManagementRequest['margins']>();
  const fileHandle = useRef<PDFFileHandle | undefined>(undefined);
  const [outputFileName, setOutputFileName] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const saving = useRef(false);
  const [pendingOpen, setPendingOpen] = useState<{ file: File; handle?: PDFFileHandle; generated?: boolean } | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [encryptDialogOpen, setEncryptDialogOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [ocrOpen, setOCROpen] = useState(false);
  const [createPDFOpen, setCreatePDFOpen] = useState(false);
  const [exportPagesOpen, setExportPagesOpen] = useState<'all' | 'images' | null>(null);
  const [formDesignerOpen, setFormDesignerOpen] = useState(false);
  const [pageDecorationsOpen, setPageDecorationsOpen] = useState(false);
  const [cleanDocumentOpen, setCleanDocumentOpen] = useState(false);
  const [compressPDFOpen, setCompressPDFOpen] = useState(false);
  const [textLayoutBlockId, setTextLayoutBlockId] = useState<string | null>(null);
  const [textCheckOpen, setTextCheckOpen] = useState(false);
  const [updateHistoryOpen, setUpdateHistoryOpen] = useState(false);
  const textLayoutCommit = useRef<((edit: TextEditOperation, signal: AbortSignal) => void) | null>(null);
  const [linksOpen, setLinksOpen] = useState(false);
  const linksApply = useRef<((operations: PDFLinkOperation[], signal: AbortSignal, onCommit: () => void) => Promise<void>) | null>(null);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarksApply = useRef<((tree: PDFBookmarkDraft[], signal: AbortSignal, onCommit: () => void) => Promise<void>) | null>(null);
  const [signatureSession, setSignatureSession] = useState<{ document: object; version: number } | null>(null);
  // Pending images waiting to be placed on the PDF
  const [pendingImages, setPendingImages] = useState<PendingImageData[]>([]);
  const mainRef = useRef<HTMLElement>(null);
  const historyBusy = useRef(false);

  const {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    loadFromFile,
    closeDocument,
    passwordRequest,
    submitPassword,
    cancelPasswordRequest,
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

  const persistence = useSessionPersistence();
  useDocumentSaveTracking();
  const hasUnsavedChanges = useDocumentSaveStore(state => state.isDirty);

  const { sidebarOpen: desktopSidebarOpen, searchOpen, toggleSidebar: toggleDesktopSidebar, toggleSearch } = useUIStore();
  const sidebarOpen = narrowViewport ? mobileSidebarOpen : desktopSidebarOpen;
  const toggleSidebar = useCallback(() => {
    if (narrowViewport) setMobileSidebarOpen(open => !open);
    else toggleDesktopSidebar();
  }, [narrowViewport, toggleDesktopSidebar]);
  const { query: searchQuery, clearSearch, getCurrentResult } = useSearchStore();
  const searchSource = useSearchDocument(document, searchOpen && !!searchQuery);
  const { annotations: annotationMap, currentTool, setCurrentTool, selectedAnnotationId, selectAnnotation, getAllAnnotations } = useAnnotationStore();
  const { fields: formFields, resetToOriginal: resetFormToOriginal } = useFormStore();
  const { redactions, mode: editingMode } = useEditingStore();

  useEffect(() => {
    if (currentTool !== 'select' || editingMode !== 'none') usePageCropStore.getState().cancel();
  }, [currentTool, editingMode]);
  const {
    undo: historyUndo,
    redo: historyRedo,
    canUndo,
    canRedo,
    getUndoActionName,
    getRedoActionName,
    getOriginalDocument,
    setUndoRedoInProgress,
  } = useHistoryStore();

  // Keep the mobile drawer independent of the user's desktop sidebar preference.
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)');
    const handleChange = (event: MediaQueryListEvent) => setNarrowViewport(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

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
      commitPendingEditors();
      if (document && useDocumentSaveStore.getState().isDirty) {
        e.preventDefault();
        // Modern browsers require returnValue to be set
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [document]);

  const openFileDirect = useCallback(async (file: File, handle?: PDFFileHandle) => {
    pendingMergeOpen.current = null;
    if (await loadFromFile(file)) {
      fileHandle.current = handle;
      setOutputFileName(file.name);
      usePageCropStore.getState().cancel();
      setSelectedPages([]);
      setPageManagementAction(null);
      setPendingImages([]);
      setHighlightDest(null);
      setMergeDialogOpen(false);
      setSplitDialogOpen(false);
      setEncryptDialogOpen(false);
      setPropertiesOpen(false);
      setOCROpen(false);
      setCreatePDFOpen(false);
      setExportPagesOpen(null);
      setFormDesignerOpen(false);
      setPageDecorationsOpen(false);
      setCompressPDFOpen(false);
      setTextLayoutBlockId(null);
      setTextCheckOpen(false);
      textLayoutCommit.current = null;
      setLinksOpen(false);
      setBookmarksOpen(false); bookmarksApply.current = null; setSignatureSession(null);
      linksApply.current = null;
      setCleanDocumentOpen(false);
      return true;
    }
    return false;
  }, [loadFromFile]);

  const handleOpenFile = useCallback(async (file: File, handle?: PDFFileHandle, generated = false) => {
    if (saving.current) return false;
    commitPendingEditors();
    if (useDocumentStore.getState().document && useDocumentSaveStore.getState().isDirty) {
      setPendingOpen({ file, handle, generated }); setCloseDialogOpen(true); return false;
    }
    const opened = await openFileDirect(file, handle);
    if (opened && generated) markDocumentUnsaved();
    return opened;
  }, [openFileDirect]);

  const handleOpenFromPicker = useCallback(async () => {
    if (saving.current) return;
    if (!canUseNativeOpenPicker()) { window.document.querySelector<HTMLInputElement>('.main-toolbar input[type="file"]')?.click(); return; }
    try { const selected = await openPDFFile(); if (selected) await handleOpenFile(selected.file, selected.handle); }
    catch (cause) { useDocumentStore.getState().setError(cause instanceof Error ? cause.message : 'Could not open the PDF.'); }
  }, [handleOpenFile]);

  const linkNavigationRequest = useRef(0);
  const linkNavigationMounted = useRef(false);
  const linkHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    linkNavigationMounted.current = true;
    return () => { linkNavigationMounted.current = false; if (linkHighlightTimer.current) clearTimeout(linkHighlightTimer.current); };
  }, []);
  useEffect(() => { linkNavigationRequest.current++; }, [document, documentVersion]);

  const handleLinkClick = useCallback(async (destination: unknown) => {
    const initial = useDocumentStore.getState();
    if (!document || initial.document !== document || initial.isLoading) return;
    const request = ++linkNavigationRequest.current;
    if (linkHighlightTimer.current) clearTimeout(linkHighlightTimer.current);
    setHighlightDest(null);
    // Save the currently displayed reference point before any async destination
    // lookup, page jump, or zoom can move it. Match the viewer's scroll insets.
    const container = mainRef.current?.querySelector<HTMLElement>('.pdf-viewer-container');
    const currentElement = container?.querySelector<HTMLElement>(`.page-wrapper[data-page="${initial.navigation.currentPage}"]`);
    const containerBounds = container?.getBoundingClientRect(), pageBounds = currentElement?.getBoundingClientRect();
    const visiblePosition = containerBounds && pageBounds ? {
      x: containerBounds.left + PDF_LINK_SCROLL_INSET.left - pageBounds.left,
      y: containerBounds.top + PDF_LINK_SCROLL_INSET.top - pageBounds.top, pageWidth: pageBounds.width,
    } : undefined;
    const isCurrent = () => {
      const current = useDocumentStore.getState();
      return linkNavigationMounted.current && request === linkNavigationRequest.current && current.document === document && current.documentVersion === initial.documentVersion
        && current.loadRequestId === initial.loadRequestId && !current.isLoading;
    };
    try {
      if (!isCurrent()) return;
      let resolved = await resolvePDFLinkNavigation(document, destination, isCurrent);
      if (!isCurrent()) return;
      if (!resolved) { initial.setError('This link does not point to an available page.'); return; }
      const page = await document.getPage(resolved.pageNumber);
      if (!isCurrent()) return;
      let currentScale = initial.navigation.zoom;
      if (visiblePosition) {
        const currentPage = resolved.pageNumber === initial.navigation.currentPage ? page : await document.getPage(initial.navigation.currentPage);
        if (!isCurrent()) return;
        const currentPosition = pdfLinkCurrentPosition(currentPage, initial.navigation.rotation, currentScale, visiblePosition);
        resolved = retainPDFLinkCoordinates(resolved, currentPosition); currentScale = currentPosition.scale;
      }
      if (container) setZoom(pdfLinkNavigationScale(resolved, page, initial.navigation.rotation,
        { width: container.clientWidth, height: container.clientHeight }, currentScale), 'manual');
      const highlight = { document, version: initial.documentVersion, destination: resolved };
      setHighlightDest(highlight); goToPage(resolved.pageNumber);
      linkHighlightTimer.current = setTimeout(() => {
        if (linkNavigationMounted.current) setHighlightDest(current => current === highlight ? null : current);
      }, 2500);
    } catch (cause) {
      if (isCurrent()) useDocumentStore.getState().setError(cause instanceof Error ? `Could not follow this link: ${cause.message}` : 'Could not follow this PDF link.');
    }
  }, [document, goToPage, setZoom]);

  const runOperation = useCallback((
    actionName: string,
    transform: (context: DocumentOperationContext) => Promise<DocumentOperationResult | null>,
  ) => performDocumentOperation(actionName, transform, loadFromFile), [loadFromFile]);

  const readLinksPDF = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted(); linksApply.current = null;
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const history = useHistoryStore.getState(), workspace = captureWorkspace();
    const checkCurrent = (duringCommit = false) => {
      signal.throwIfAborted();
      const current = useDocumentStore.getState(), currentHistory = useHistoryStore.getState();
      if ((!duringCommit && current.isLoading) || current.document !== initial.document || current.documentVersion !== initial.documentVersion
        || current.loadRequestId !== initial.loadRequestId || currentHistory.undoStack !== history.undoStack || currentHistory.redoStack !== history.redoStack) {
        throw new Error('The document or its drafts changed. Reopen Links.');
      }
    };
    const stored = await readActivePDF(); checkCurrent();
    const client = await import('./core/PDFLinksClient'); checkCurrent();
    const prepared = await client.preparePDFLinksWorkspaceInWorker(stored.data, workspace, { signal }); checkCurrent();
    linksApply.current = async (operations, saveSignal, onCommit) => {
      saveSignal.throwIfAborted(); checkCurrent();
      if (!operations.length) return;
      await runOperation('Edit links', async () => {
        saveSignal.throwIfAborted(); checkCurrent(true);
        const result = await client.applyPDFLinksWorkspaceInWorker(prepared.data, workspace, operations, { signal: saveSignal, expectedRevision: prepared.report.revision });
        saveSignal.throwIfAborted(); checkCurrent(true);
        onCommit(); return result;
      });
    };
    return { ...prepared, preview: async (operations: PDFLinkOperation[], previewSignal: AbortSignal) => {
      previewSignal.throwIfAborted(); checkCurrent();
      const result = await client.previewPDFLinksInWorker(prepared.data, workspace, operations, { signal: previewSignal, expectedRevision: prepared.report.revision });
      checkCurrent(); return result;
    } };
  }, [runOperation]);

  const applyLinks = useCallback(async (operations: PDFLinkOperation[], signal: AbortSignal, onCommit: () => void) => {
    if (!linksApply.current) throw new Error('Reopen Links before applying changes.');
    await linksApply.current(operations, signal, onCommit);
  }, []);

  const closeLinks = useCallback(() => { linksApply.current = null; setLinksOpen(false); }, []);

  const readBookmarksPDF = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted(); bookmarksApply.current = null;
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const history = useHistoryStore.getState(), workspace = captureWorkspace();
    const checkCurrent = (duringCommit = false) => {
      signal.throwIfAborted();
      const current = useDocumentStore.getState(), currentHistory = useHistoryStore.getState();
      if ((!duringCommit && current.isLoading) || current.document !== initial.document || current.documentVersion !== initial.documentVersion
        || current.loadRequestId !== initial.loadRequestId || currentHistory.undoStack !== history.undoStack || currentHistory.redoStack !== history.redoStack) {
        throw new Error('The document or its drafts changed. Reopen Bookmarks.');
      }
    };
    const stored = await readActivePDF(); checkCurrent();
    const client = await import('./core/PDFBookmarksClient'); checkCurrent();
    const prepared = await client.preparePDFBookmarksWorkspaceInWorker(stored.data, workspace, { signal }); checkCurrent();
    bookmarksApply.current = async (tree, saveSignal, onCommit) => {
      saveSignal.throwIfAborted(); checkCurrent();
      await runOperation('Edit bookmarks', async () => {
        saveSignal.throwIfAborted(); checkCurrent(true);
        const result = await client.applyPDFBookmarksWorkspaceInWorker(prepared.data, workspace, tree, { signal: saveSignal, expectedRevision: prepared.report.revision });
        saveSignal.throwIfAborted(); checkCurrent(true);
        onCommit(); return result;
      });
    };
    return { ...prepared, preview: async (tree: PDFBookmarkDraft[], previewSignal: AbortSignal) => {
      previewSignal.throwIfAborted(); checkCurrent();
      const result = await client.previewPDFBookmarksInWorker(prepared.data, workspace, tree, { signal: previewSignal, expectedRevision: prepared.report.revision });
      checkCurrent(); return result;
    } };
  }, [runOperation]);

  const applyBookmarks = useCallback(async (tree: PDFBookmarkDraft[], signal: AbortSignal, onCommit: () => void) => {
    if (!bookmarksApply.current) throw new Error('Reopen Bookmarks before applying changes.');
    await bookmarksApply.current(tree, signal, onCommit);
  }, []);

  const closeBookmarks = useCallback(() => { bookmarksApply.current = null; setBookmarksOpen(false); }, []);

  const restoreHistory = useCallback(async (direction: 'undo' | 'redo') => {
    if (historyBusy.current || useDocumentStore.getState().isLoading) return;
    commitPendingEditors();
    const beforeHistory = useHistoryStore.getState();
    const target = (direction === 'undo' ? beforeHistory.undoStack : beforeHistory.redoStack).at(-1);
    if (!target) return;
    if (isWorkspaceEntry(target)) {
      const patch = beforeHistory.restoreWorkspaceStep(direction, captureWorkspace());
      if (patch) applyWorkspacePatch(patch);
      return;
    }
    historyBusy.current = true;
    const initial = useDocumentStore.getState();
    const isSameSession = () => useHistoryStore.getState().originalDocument === beforeHistory.originalDocument;
    let snapshotTaken = false;
    initial.setLoading(true);
    try {
      const stored = await readActivePDF();
      if (!stored || !isSameSession() || useDocumentStore.getState().loadRequestId !== initial.loadRequestId) return;
      const snapshot = direction === 'undo'
        ? historyUndo(stored.data, stored.fileName, captureWorkspace())
        : historyRedo(stored.data, stored.fileName, captureWorkspace());
      if (!snapshot) return;
      snapshotTaken = true;
      setUndoRedoInProgress(true);
      const history = useHistoryStore.getState();
      const file = new File([snapshot.data], snapshot.fileName, { type: 'application/pdf' });
      if (!await loadFromFile(file, { preserveState: true, workspace: snapshot.workspace,
        history: { undoStack: history.undoStack, redoStack: history.redoStack } })) {
        throw new Error(`Could not ${direction} the document change`);
      }
    } catch (err) {
      if (!isSameSession()) return;
      if (snapshotTaken) useHistoryStore.setState({ undoStack: beforeHistory.undoStack, redoStack: beforeHistory.redoStack });
      useDocumentStore.getState().setError(err instanceof Error ? err.message : 'Could not restore document');
    } finally {
      setUndoRedoInProgress(false);
      if (useDocumentStore.getState().loadRequestId === initial.loadRequestId) initial.setLoading(false);
      historyBusy.current = false;
    }
  }, [historyUndo, historyRedo, loadFromFile, setUndoRedoInProgress]);

  const handleUndo = useCallback(() => restoreHistory('undo'), [restoreHistory]);
  const handleRedo = useCallback(() => restoreHistory('redo'), [restoreHistory]);

  const readPropertiesPDF = useCallback(async () => {
    const stored = await readActivePDF();
    if (!stored) throw new Error('No document is open');
    return stored.data;
  }, []);
  const applyProperties = useCallback((label: string, transform: (data: ArrayBuffer) => Promise<Uint8Array>) =>
    runOperation(label, async ({ data }) => ({ data: await transform(data) })), [runOperation]);

  const readOptimizationPDF = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const workspace = captureWorkspace(), stored = await readActivePDF();
    const checkCurrent = () => {
      signal.throwIfAborted();
      const current = useDocumentStore.getState();
      if (current.document !== initial.document || current.documentVersion !== initial.documentVersion || current.loadRequestId !== initial.loadRequestId) {
        throw new Error('The document changed. Reopen PDF compression.');
      }
    };
    checkCurrent();
    if (!stored) throw new Error('The current PDF is unavailable.');
    const { prepareOptimizationPDF } = await import('./core/PDFOptimizationWorkspace');
    checkCurrent();
    const data = await prepareOptimizationPDF(stored.data, workspace, signal);
    checkCurrent();
    return { data, fileName: outputFileName ?? stored.fileName };
  }, [outputFileName]);

  const readTextLayoutPDF = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    textLayoutCommit.current = null;
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const history = useHistoryStore.getState(), workspace = captureWorkspace();
    const block = [...workspace.editing.textBlocks.values()].flat().find(item => item.id === textLayoutBlockId);
    if (!block?.editable) throw new Error('The selected text block is unavailable or cannot be edited.');
    const checkCurrent = () => {
      signal.throwIfAborted();
      const current = useDocumentStore.getState(), currentHistory = useHistoryStore.getState();
      if (current.isLoading || current.document !== initial.document || current.documentVersion !== initial.documentVersion
        || current.loadRequestId !== initial.loadRequestId || currentHistory.undoStack !== history.undoStack || currentHistory.redoStack !== history.redoStack) {
        throw new Error('The document or its drafts changed. Reopen text layout.');
      }
    };
    const stored = await readActivePDF();
    checkCurrent();
    const { previewTextEditInWorker } = await import('./editing/TextLayoutClient');
    checkCurrent();
    textLayoutCommit.current = (edit, saveSignal) => {
      saveSignal.throwIfAborted(); checkCurrent();
      if (edit.blockId !== block.id || !useEditingStore.getState().getBlock(block.id)?.editable) {
        throw new Error('The selected text block changed. Reopen text layout.');
      }
      useEditingStore.getState().updateBlockLayout(edit);
    };
    return {
      data: stored.data, block, edit: workspace.editing.textEdits.find(item => item.blockId === block.id),
      preview: async (edit: TextEditOperation, previewSignal: AbortSignal) => {
        previewSignal.throwIfAborted(); checkCurrent();
        const result = await previewTextEditInWorker(stored.data, workspace, edit, { signal: previewSignal });
        checkCurrent(); return result;
      },
    };
  }, [textLayoutBlockId]);

  const saveTextLayout = useCallback((edit: TextEditOperation, signal: AbortSignal) => {
    if (!textLayoutCommit.current) throw new Error('Reopen text layout before saving.');
    textLayoutCommit.current(edit, signal);
  }, []);

  const closeTextLayout = useCallback(() => {
    textLayoutCommit.current = null; setTextLayoutBlockId(null);
  }, []);

  const readCleanupPDF = useCallback(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const workspace = captureWorkspace(), stored = await readActivePDF();
    const checkCurrent = () => {
      signal.throwIfAborted();
      const current = useDocumentStore.getState();
      if (current.document !== initial.document || current.documentVersion !== initial.documentVersion || current.loadRequestId !== initial.loadRequestId) {
        throw new Error('The document changed. Reopen document cleanup.');
      }
    };
    checkCurrent();
    if (!stored) throw new Error('The current PDF is unavailable.');
    const { prepareCleanupPDF, previewCleanupWorkspace, prepareVisibleWorkspacePDF } = await import('./core/DocumentCleanupWorkspace');
    const prepared = await prepareCleanupPDF(stored.data, workspace, signal);
    checkCurrent();
    const annotationPages = [...workspace.annotations].filter(([, items]) => items.length > 0);
    return {
      ...prepared, fileName: stored.fileName,
      workspaceAnnotations: { count: annotationPages.reduce((total, [, items]) => total + items.length, 0), pages: annotationPages.map(([page]) => page) },
      pendingRedactions: workspace.editing.redactions.filter(area => !area.applied).length,
      preparePreview: async (data: Uint8Array, options: CleanupOptions, previewSignal: AbortSignal) => {
        checkCurrent(); previewSignal.throwIfAborted();
        const result = await previewCleanupWorkspace(data, workspace, options, previewSignal);
        checkCurrent(); return result;
      },
      readVisiblePDF: async (copySignal: AbortSignal) => {
        checkCurrent(); copySignal.throwIfAborted();
        const result = await prepareVisibleWorkspacePDF(stored.data, workspace, copySignal);
        checkCurrent(); return result;
      },
    };
  }, []);

  const applyCleanup = useCallback(async (options: CleanupOptions, signal: AbortSignal, onCommit: () => void, onProgress?: CleanupControl['onProgress']) => {
    await runOperation('Clean document', async ({ data, workspace }) => {
      signal.throwIfAborted();
      const { cleanWorkspacePDF } = await import('./core/DocumentCleanupWorkspace');
      const cleaned = await cleanWorkspacePDF(data, workspace, options, { signal, onProgress });
      signal.throwIfAborted();
      onCommit();
      return { data: cleaned.data, workspace: cleaned.workspace };
    });
  }, [runOperation]);

  const handleOCR = useCallback(async (options: OCRRunOptions, signal: AbortSignal, onProgress: (progress: OCRDialogProgress) => void) => {
    let results: OCRPageResult[] = [];
    await runOperation('Scan OCR', async ({ data, workspace }) => {
      signal.throwIfAborted();
      const prepared = await applyWorkspaceContent(data, workspace);
      signal.throwIfAborted();
      const { recognizePDF } = await import('./ocr/recognizePDF');
      signal.throwIfAborted();
      const recognized = await recognizePDF(new Uint8Array(prepared).buffer, { ...options, signal, onProgress });
      signal.throwIfAborted();
      results = recognized.pages;
      if (!results.some(page => page.status === 'recognized')) return null;
      workspace.editing.textBlocks.clear();
      workspace.editing.images.clear();
      workspace.editing.textEdits = [];
      workspace.editing.imageEdits = [];
      workspace.editing.isDirty = workspace.editing.redactions.some(area => !area.applied);
      // Cancellation ends before the atomic PDF/history/cache commit starts.
      onProgress({ phase: 'committing', pageNumber: null, completedPages: options.pages.length,
        totalPages: options.pages.length, progress: 1, status: 'Saving recognized text…' });
      return { data: recognized.data, workspace };
    });
    return results;
  }, [runOperation]);

  const readFormDesignPDF = useCallback(async () => {
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const workspace = captureWorkspace();
    const stored = await readActivePDF();
    const isCurrent = () => {
      const current = useDocumentStore.getState();
      return current.document === initial.document && current.documentVersion === initial.documentVersion && current.loadRequestId === initial.loadRequestId;
    };
    if (!stored || !isCurrent()) throw new Error('The document changed. Reopen the form designer.');
    const { inspectFormDesign } = await import('./forms/FormDesigner');
    const inspection = await inspectFormDesign(stored.data);
    if (!isCurrent()) throw new Error('The document changed. Reopen the form designer.');
    if (!inspection.canEdit) return stored.data;
    const prepared = await prepareFormDesignPDF(stored.data, workspace);
    if (!isCurrent()) throw new Error('The document changed. Reopen the form designer.');
    return prepared;
  }, []);

  const saveFormDesign = useCallback(async (operations: FormDesignOperation[], signal: AbortSignal, onCommit: () => void) => {
    await runOperation('Design form', async ({ data, workspace }) => {
      signal.throwIfAborted();
      const { applyFormDesign, inspectFormDesign } = await import('./forms/FormDesigner');
      const inspection = await inspectFormDesign(data);
      signal.throwIfAborted();
      if (!inspection.canEdit) throw new Error(inspection.unsupportedReason || 'This PDF cannot be redesigned safely.');
      const prepared = await prepareFormDesignPDF(data, workspace);
      signal.throwIfAborted();
      const changed = await applyFormDesign(prepared, operations);
      signal.throwIfAborted();
      const fields = await extractFormFields(new Uint8Array(changed).buffer);
      signal.throwIfAborted();
      workspace.form = createWorkspace(fields).form;
      workspace.editing.textBlocks.clear(); workspace.editing.images.clear();
      workspace.editing.textEdits = []; workspace.editing.imageEdits = [];
      workspace.editing.isDirty = workspace.editing.redactions.some(area => !area.applied);
      onCommit();
      return { data: changed, workspace };
    });
  }, [runOperation]);

  const readDecorationsPDF = useCallback(async () => {
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading.');
    commitPendingEditors();
    const workspace = captureWorkspace(), stored = await readActivePDF();
    const isCurrent = () => {
      const current = useDocumentStore.getState();
      return current.document === initial.document && current.documentVersion === initial.documentVersion && current.loadRequestId === initial.loadRequestId;
    };
    if (!stored || !isCurrent()) throw new Error('The document changed. Reopen page decorations.');
    const { inspectPageDecorations } = await import('./core/PageDecorations');
    const inspection = await inspectPageDecorations(stored.data);
    if (!isCurrent()) throw new Error('The document changed. Reopen page decorations.');
    if (!inspection.canEdit) return stored.data;
    const prepared = await applyWorkspaceContent(stored.data, workspace);
    if (!isCurrent()) throw new Error('The document changed. Reopen page decorations.');
    return {
      data: new Uint8Array(prepared).buffer,
      // Apply overlays after decorations, matching the final export's layer order.
      preparePreview: async (decorated: Uint8Array) => {
        if (!isCurrent()) throw new Error('The document changed. Reopen page decorations.');
        let result = await applyWorkspaceFormValues(new Uint8Array(decorated).buffer, workspace);
        if (!isCurrent()) throw new Error('The document changed. Reopen page decorations.');
        if (workspace.annotations.size) result = new Uint8Array(await serializeAnnotationsToPDF(result, workspace.annotations)).buffer;
        if (!isCurrent()) throw new Error('The document changed. Reopen page decorations.');
        return new Uint8Array(result);
      },
    };
  }, []);

  const applyDecorations = useCallback(async (operations: PageDecorationOperation[], signal: AbortSignal, onCommit: () => void) => {
    await runOperation('Update page decorations', async ({ data, workspace }) => {
      signal.throwIfAborted();
      const { applyPageDecorations, inspectPageDecorations } = await import('./core/PageDecorations');
      const inspection = await inspectPageDecorations(data);
      signal.throwIfAborted();
      if (!inspection.canEdit) throw new Error(inspection.unsupportedReason || 'This PDF cannot be modified safely.');
      const prepared = await applyWorkspaceContent(data, workspace);
      signal.throwIfAborted();
      const changed = await applyPageDecorations(new Uint8Array(prepared).buffer, operations, { signal });
      signal.throwIfAborted();
      workspace.editing.textBlocks.clear(); workspace.editing.images.clear();
      workspace.editing.textEdits = []; workspace.editing.imageEdits = [];
      workspace.editing.isDirty = workspace.editing.redactions.some(area => !area.applied);
      onCommit();
      return { data: changed, workspace };
    });
  }, [runOperation]);

  const handleRotatePages = useCallback(async (pages: number[], degrees: 90 | -90 | 180) => {
    try {
      await runOperation(`Rotate ${pages.length > 1 ? `${pages.length} pages` : `page ${pages[0]}`} ${degrees}°`, async ({ data }) => ({
        data: await rotatePages(data, pages, degrees),
      }));
      setSelectedPages([]);
    } catch (err) { console.error('Failed to rotate pages:', err); }
  }, [runOperation]);

  const handleDeletePages = useCallback(async (pages: number[]) => {
    try {
      await runOperation(`Delete ${pages.length > 1 ? `${pages.length} pages` : `page ${pages[0]}`}`, async ({ data, totalPages }) => ({
        data: await deletePages(data, pages),
        pageMap: deletionPageMap(totalPages, pages),
      }));
      setSelectedPages([]);
    } catch (err) { console.error('Failed to delete pages:', err); }
  }, [runOperation]);

  const handleReorderPages = useCallback(async (order: number[]) => {
    try {
      await runOperation('Reorder pages', async ({ data, totalPages }) => ({
        data: await reorderPages(data, order), pageMap: reorderedPageMap(totalPages, order),
      }));
      setSelectedPages([]);
    } catch (err) { console.error('Failed to reorder pages:', err); }
  }, [runOperation]);

  const handleInsertBlankPage = useCallback(async (position: number) => {
    try {
      await runOperation('Insert blank page', async ({ data, totalPages }) => ({
        data: await insertBlankPages(data, { position }),
        pageMap: insertionPageMap(totalPages, position, 1),
      }));
    } catch (err) { console.error('Failed to insert blank page:', err); }
  }, [runOperation]);

  const handleInsertFromFile = useCallback((position: number) => {
    const initialDocument = useDocumentStore.getState().document;
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || useDocumentStore.getState().document !== initialDocument) return;
      try {
        await runOperation(`Insert pages from ${file.name}`, async ({ data, totalPages }) => {
          const insertedData = await file.arrayBuffer();
          const inserted = await PDFLibDocument.load(insertedData);
          return {
            data: await insertPagesFromPDF(data, insertedData, position),
            pageMap: insertionPageMap(totalPages, position, inserted.getPageCount()),
          };
        });
      } catch (err) { console.error('Failed to insert pages:', err); }
    };
    input.click();
  }, [runOperation]);

  const prepareExport = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const initial = useDocumentStore.getState();
    if (!initial.document || initial.isLoading) throw new Error('Wait until the document finishes loading');
    initial.setError(null);
    commitPendingEditors();
    const workspace = captureWorkspace();
    const stored = await readActivePDF();
    const isCurrent = () => {
      const current = useDocumentStore.getState();
      return current.document === initial.document && current.documentVersion === initial.documentVersion
        && current.loadRequestId === initial.loadRequestId;
    };
    if (!stored || !isCurrent()) throw new Error('Document changed during export');
    // Dialogs with their own progress/cancel controls own the entire operation.
    const data = await runExport(stored.data, workspace, { signal, showProgress: !signal });
    if (!isCurrent()) throw new Error('Document changed during export');
    return { data, fileName: outputFileName ?? stored.fileName };
  }, [outputFileName, runExport]);

  const handleExport = useCallback(async () => {
    try {
      const { data, fileName } = await prepareExport();
      await downloadPDF(data, fileName);
    } catch (err) {
      if (isAbortError(err)) return;
      useDocumentStore.getState().setError(`Failed to export PDF: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [prepareExport]);

  const saveCurrentFile = useCallback(async (saveAs = false) => {
    if (saving.current || useDocumentStore.getState().isLoading) return false;
    saving.current = true; setIsSaving(true);
    commitPendingEditors();
    const sessionId = useDocumentSessionStore.getState().active?.sessionId;
    let name = outputFileName ?? useDocumentSessionStore.getState().active?.fileName ?? 'document.pdf';
    try {
      let destination = saveAs ? undefined : fileHandle.current;
      if ((saveAs || !destination) && canUseNativeSavePicker()) {
        destination = await selectSavePDFHandle(name) ?? undefined;
        if (!destination) return false;
      } else if (saveAs) {
        const chosen = window.prompt(t('file.saveAs.name'), name);
        if (chosen === null) return false;
        if (!chosen.trim()) throw new Error(t('file.save.name.required'));
        name = /\.pdf$/i.test(chosen.trim()) ? chosen.trim() : `${chosen.trim()}.pdf`;
      }
      if (destination) await ensurePDFWritePermission(destination);
      if (useDocumentSessionStore.getState().active?.sessionId !== sessionId) return false;
      const point = captureDocumentSavePoint();
      const prepared = await prepareExport();
      const result = await savePDFFile(prepared.data, name, { handle: destination });
      if (!result.saved || useDocumentSessionStore.getState().active?.sessionId !== sessionId) return false;
      fileHandle.current = result.handle; setOutputFileName(result.fileName);
      const savedPoint = await point;
      if (savedPoint) markDocumentSaved(savedPoint);
      return true;
    } catch (cause) {
      if (isAbortError(cause)) return false;
      useDocumentStore.getState().setError(cause instanceof Error ? cause.message : 'Could not save the PDF.');
      throw cause;
    } finally { saving.current = false; setIsSaving(false); }
  }, [outputFileName, prepareExport]);
  const handleSave = useCallback(() => { void saveCurrentFile().catch(() => {}); }, [saveCurrentFile]);
  const handleSaveAs = useCallback(() => { void saveCurrentFile(true).catch(() => {}); }, [saveCurrentFile]);

  const handlePageManagement = useCallback(async (request: PageManagementRequest, signal: AbortSignal, onCommit: () => void) => {
    signal.throwIfAborted();
    if (request.action === 'extract') {
      const { data, fileName } = await prepareExport(signal);
      signal.throwIfAborted();
      const [extracted] = await splitPDF(new Uint8Array(data).buffer, { mode: 'extract-pages', pages: request.pages });
      signal.throwIfAborted();
      onCommit();
      await downloadPDF(extracted, `${fileName.replace(/\.pdf$/i, '')}-extracted.pdf`);
      return;
    }
    const actionName = request.action === 'duplicate' ? 'Duplicate pages' : request.action === 'replace' ? 'Replace pages'
      : request.resetCrop ? 'Restore page boundaries' : 'Crop pages';
    await runOperation(actionName, async ({ data, workspace }) => {
      const { performPageManagement } = await import('./core/PageManagementWorkspace');
      const result = await performPageManagement(data, workspace, request, signal);
      signal.throwIfAborted();
      onCommit();
      return result;
    });
    setSelectedPages([]);
  }, [prepareExport, runOperation]);

  const openPageTool = useCallback((action: PageManagementAction) => {
    commitPendingEditors();
    if (action !== 'crop') { setPageManagementAction(action); return; }
    const pageNumber = useDocumentStore.getState().navigation.currentPage;
    useEditingStore.getState().setMode('none'); setCurrentTool('select');
    usePageCropStore.getState().start({ pageNumber,
      onApply: (margins, signal, onCommit) => handlePageManagement({ action: 'crop', pages: [pageNumber], margins }, signal, onCommit),
      onOptions: margins => { setCropMargins(margins); setPageManagementAction('crop'); },
    });
  }, [handlePageManagement, setCurrentTool]);

  // Handle form data export
  const handleExportFormData = useCallback(async (format: 'json' | 'fdf' | 'xfdf') => {
    try {
      const stored = await readActivePDF();
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
      useDocumentStore.getState().setError(`Failed to export form data: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [formFields]);

  // Handle form data import
  const handleImportFormData = useCallback(async () => {
    const target = useDocumentStore.getState();
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.fdf,.xfdf';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const extension = file.name.split('.').at(-1)?.toLowerCase();
        const content = extension === 'fdf' ? '' : await readFileAsText(file);
        let fieldValues: Map<string, string | boolean | string[]>;

        if (extension === 'json') {
          fieldValues = importFromJSON(content);
        } else if (extension === 'fdf') {
          fieldValues = await importFromFDF(await file.arrayBuffer());
        } else if (extension === 'xfdf') {
          fieldValues = importFromXFDF(content);
        } else {
          throw new Error('Unsupported file format');
        }

        const current = useDocumentStore.getState();
        if (current.document !== target.document || current.loadRequestId !== target.loadRequestId) {
          throw new Error('Document changed. Reopen form data import for the current PDF.');
        }
        const validated = normalizeImportedFormValues(formFields, fieldValues, extension !== 'json');
        useFormStore.getState().setFieldValues(validated, 'Import form data');
        alert(translateMessage(`Imported ${validated.size} field values`));
      } catch (err) {
        console.error('Failed to import form data:', err);
        alert(translateMessage('Failed to import form data: ' + (err as Error).message));
      }
    };
    input.click();
  }, [formFields]);

  const handleFlattenForm = useCallback(async () => {
    if (!confirm(translateMessage('Convert all form fields to static page content? You can undo this operation.'))) return;
    try {
      await runOperation('Flatten form', ({ data, workspace }) => flattenWorkspaceForm(data, workspace));
    } catch (err) { console.error('Failed to flatten form:', err); }
  }, [runOperation]);

  const handleResetForm = useCallback(() => {
    resetFormToOriginal();
  }, [resetFormToOriginal]);

  const handleApplyRedactions = useCallback(async () => {
    const pending = redactions.filter(area => !area.applied);
    if (pending.length === 0) return;
    if (!confirm(translateMessage(`Apply ${pending.length} visual cover(s)? Underlying text and images remain recoverable. This does not remove sensitive information.`))) return;
    try {
      await runOperation(`Apply ${pending.length} visual cover(s)`, async ({ data, workspace }) => {
        const result = await applyRedactions(data, pending);
        if (!result.success || !result.modifiedPdf) throw new Error(result.errors.join('\n'));
        const applied = new Set(pending.map(area => area.id));
        workspace.editing.redactions = workspace.editing.redactions.map(area => applied.has(area.id) ? { ...area, applied: true } : area);
        return { data: result.modifiedPdf, workspace };
      });
    } catch (err) { console.error('Failed to apply visual covers:', err); }
  }, [redactions, runOperation]);

  const handleRemoveContent = useCallback(async () => {
    const areas = redactions.filter(area => !area.applied);
    if (!areas.length) return;
    if (!confirm(translateMessage(`Remove content from ${areas.length} marked area(s)? Forms and annotations become static page content. Selected text, graphics and image pixels are removed from the resulting PDF. Metadata and attachments are not cleaned. Local undo history retains the original.`))) return;
    try {
      await runOperation('Remove selected page content', async ({ data, workspace }) => {
        const prepared = await exportWorkspacePDF(data, workspace);
        const removed = await applySecureRedactions(new Uint8Array(prepared).buffer, areas, { flattenInteractive: true });
        return { data: removed, workspace: createWorkspace() };
      });
    } catch (err) { console.error('Failed to remove selected content:', err); }
  }, [redactions, runOperation]);

  const handleApplyContent = useCallback(async () => {
    const editing = useEditingStore.getState();
    if (!editing.textEdits.length && !editing.imageEdits.length) return;
    try {
      await runOperation('Apply text and image changes', async ({ data, workspace }) => {
        const updated = await applyWorkspaceContent(data, workspace);
        workspace.editing.textBlocks.clear();
        workspace.editing.images.clear();
        workspace.editing.textEdits = [];
        workspace.editing.imageEdits = [];
        workspace.editing.isDirty = workspace.editing.redactions.some(area => !area.applied);
        return { data: updated, workspace };
      });
    } catch (err) { console.error('Failed to apply content changes:', err); }
  }, [runOperation]);

  // Handle image insertion - set pending images and switch to image tool
  const handleInsertImage = useCallback((images: PendingImageData[]) => {
    if (images.length === 0) return;
    commitPendingEditors();
    useEditingStore.getState().setMode('none');
    selectAnnotation(null);
    setPendingImages(images);
    // Switch to image placement mode
    setCurrentTool('image');
  }, [setCurrentTool, selectAnnotation]);

  // A reset starts a clean session, including annotations and editing overlays.
  const handleResetToOriginal = useCallback(async () => {
    const original = getOriginalDocument();
    if (!original) return;
    const file = new File([original.data], original.fileName, { type: 'application/pdf' });
    const destination = fileHandle.current;
    if (await openFileDirect(file, destination)) { setOutputFileName(outputFileName); markDocumentUnsaved(); }
    setResetDialogOpen(false);
  }, [getOriginalDocument, openFileDirect, outputFileName]);

  const handleCloseDocument = useCallback(async () => {
    pendingMergeOpen.current = null;
    if (await closeDocument()) {
      fileHandle.current = undefined; setOutputFileName(undefined); setPendingOpen(null); usePageCropStore.getState().cancel();
      setSelectedPages([]);
      setPageManagementAction(null);
      setPendingImages([]);
      setCloseDialogOpen(false);
      setEncryptDialogOpen(false);
      setPropertiesOpen(false);
      setOCROpen(false);
      setCreatePDFOpen(false);
      setExportPagesOpen(null);
      setFormDesignerOpen(false);
      setPageDecorationsOpen(false);
      setCleanDocumentOpen(false);
      setCompressPDFOpen(false);
      setTextLayoutBlockId(null);
      setTextCheckOpen(false);
      textLayoutCommit.current = null;
      setHighlightDest(null);
      setLinksOpen(false);
      setBookmarksOpen(false); bookmarksApply.current = null; setSignatureSession(null);
      linksApply.current = null;
    }
  }, [closeDocument]);

  const requestCloseDocument = useCallback(() => {
    if (saving.current) return;
    commitPendingEditors(); setPendingOpen(null);
    if (useDocumentSaveStore.getState().isDirty) setCloseDialogOpen(true);
    else void handleCloseDocument();
  }, [handleCloseDocument]);
  const discardAndContinue = useCallback(async () => {
    if (pendingOpen) { const next = pendingOpen; setPendingOpen(null); setCloseDialogOpen(false); if (await openFileDirect(next.file, next.handle) && next.generated) markDocumentUnsaved(); }
    else await handleCloseDocument();
  }, [pendingOpen, openFileDirect, handleCloseDocument]);

  // Check if we can reset to original (has original and has made changes)
  const canResetToOriginal = useCallback(() => {
    return getOriginalDocument() !== null && (canUndo() || annotationMap.size > 0 || useFormStore.getState().isDirty || useEditingStore.getState().hasChanges());
  }, [getOriginalDocument, canUndo, annotationMap]);

  // Handle opening merge dialog
  const handleOpenMergeDialog = useCallback(async () => {
    const request = Symbol('merge-dialog');
    const loadRequest = useDocumentStore.getState().loadRequestId;
    pendingMergeOpen.current = request;
    const isCurrent = () => pendingMergeOpen.current === request
      && useDocumentStore.getState().document === document
      && useDocumentStore.getState().documentVersion === documentVersion
      && useDocumentStore.getState().loadRequestId === loadRequest
      && !useDocumentStore.getState().isLoading;
    // Increment key to force fresh dialog state (empty file list)
    setMergeDialogKey(k => k + 1);

    // Load current document data if available (for insert position options)
    try {
      const stored = document ? await readActivePDF() : null;
      if (!isCurrent()) return;
      setMergeDocumentData(stored && document ? {
        data: stored.data,
        fileName: stored.fileName,
        totalPages: document.numPages,
        documentVersion,
      } : null);
      setMergeDialogOpen(true);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Failed to load current PDF for merge:', err);
      useDocumentStore.getState().setError(err instanceof Error ? err.message : 'Could not prepare the PDF for merging');
    } finally {
      if (pendingMergeOpen.current === request) pendingMergeOpen.current = null;
    }
  }, [document, documentVersion]);

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
      if (file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
        await handleOpenFile(file);
      }
    },
    [handleOpenFile]
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.classList.add('drag-over');
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.currentTarget.classList.remove('drag-over');
  }, []);

  // Save belongs to the document even while a native/rich-text editor has focus.
  // Capture it before editor key handlers; modal dialogs keep their own Ctrl+S.
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey
        || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's'
        || !document || hasOpenModal()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!isLoading) { if (event.shiftKey) handleSaveAs(); else handleSave(); }
    };
    window.addEventListener('keydown', save, true);
    return () => window.removeEventListener('keydown', save, true);
  }, [document, isLoading, handleSave, handleSaveAs]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (hasOpenModal() || isTextInput(event.target)) return;
      if (event.key === 'Escape' && pendingMergeOpen.current) {
        pendingMergeOpen.current = null;
        event.preventDefault();
        return;
      }
      // Escape cancels the entire placement queue, including after placing its first image.
      if (event.key === 'Escape' && pendingImages.length > 0) {
        event.preventDefault();
        setPendingImages([]);
        setCurrentTool('select');
        return;
      }
      if (event.defaultPrevented || isLoading) return;

      const isMod = event.ctrlKey || event.metaKey;

      // Global shortcuts
      if (isMod && event.key === 'o') {
        event.preventDefault();
        void handleOpenFromPicker();
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
      if (isMod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (canUndo()) {
          handleUndo();
        }
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y
      if ((isMod && event.key.toLowerCase() === 'z' && event.shiftKey) || (isMod && event.key.toLowerCase() === 'y')) {
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
          if (!isMod && !useAnnotationStore.getState().selectedAnnotationId) {
            event.preventDefault();
            previousPage();
          }
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          if (!isMod && !useAnnotationStore.getState().selectedAnnotationId) {
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
          setPendingImages([]);
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
            if (event.shiftKey) handleSaveAs(); else handleSave();
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
    handleOpenFromPicker,
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
    handleSave,
    handleSaveAs,
    setZoom,
    canUndo,
    canRedo,
    setCurrentTool,
    pendingImages.length,
    isLoading,
  ]);

  // Mouse wheel: zoom (with Ctrl) or page navigation (single/two-page mode)
  useEffect(() => {
    let lastWheelTime = 0;

    const handleWheel = (event: WheelEvent) => {
      if (!document || isLoading || event.defaultPrevented || hasOpenModal() || isTextInput(event.target)) return;
      const viewer = event.target instanceof Element ? event.target.closest('.pdf-viewer-container') : null;
      if (!viewer || event.deltaY === 0) return;

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
        // Enlarged pages must remain scrollable; horizontal gestures also retain native scrolling.
        if (viewer.scrollHeight > viewer.clientHeight + 1 || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
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
      };
    }
  }, [document, isLoading, zoomIn, zoomOut, navigation.viewMode, nextPage, previousPage]);

  const locateTextIssue = (issue: TextCheckIssue, blocks: TextBlock[]) => {
    setTextCheckOpen(false);
    if (!issue.pageNumber) return;
    const editing = useEditingStore.getState();
    if (!editing.textBlocks.has(issue.pageNumber)) editing.setTextBlocks(issue.pageNumber, blocks);
    goToPage(issue.pageNumber);
    useUIStore.getState().setWorkspace('edit');
    editing.setMode('text');
    if (issue.blockId) {
      editing.selectBlock(issue.blockId);
      useUIStore.getState().setInspectorOpen(true);
      if (issue.kind === 'overflow') setTextLayoutBlockId(issue.blockId);
      else if (issue.blocking) editing.requestTextEdit(issue.blockId);
    }
  };

  return (
    <SearchDocumentContext.Provider value={searchSource}><Theme appearance="light" accentColor="blue" radius="medium">
      <div className="app-container" data-has-document={!!document} data-sidebar-open={!!document && sidebarOpen && !narrowViewport}>
        {/* Main Toolbar */}
        <MainToolbar
          navigationHost={navigationHost}
          currentPage={navigation.currentPage}
          totalPages={navigation.totalPages}
          zoom={navigation.zoom}
          zoomMode={navigation.zoomMode}
          viewMode={navigation.viewMode}
          sidebarOpen={sidebarOpen}
          onOpenFile={handleOpenFile}
          onExport={handleExport}
          onSave={handleSave} onSaveAs={handleSaveAs} onOpenFileFromPicker={handleOpenFromPicker} isSaving={isSaving}
          fileNameOverride={outputFileName} hasUnsavedChanges={hasUnsavedChanges}
          onCreatePDF={() => setCreatePDFOpen(true)}
          onExportPages={() => setExportPagesOpen('all')}
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
          hasDocument={!!document && !isLoading}
        />

        {/* Combined Toolbar - Page Operations & Annotations */}
        <CombinedToolbar
          documentKey={document}
          documentRevision={documentVersion}
          currentPage={navigation.currentPage}
          totalPages={navigation.totalPages}
          selectedPages={selectedPages}
          onRotatePages={handleRotatePages}
          onDeletePages={handleDeletePages}
          onInsertBlankPage={handleInsertBlankPage}
          onInsertFromFile={handleInsertFromFile}
          onMerge={handleOpenMergeDialog}
          onSplit={() => setSplitDialogOpen(true)}
          onManagePages={openPageTool}
          hasDocument={!!document}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo()}
          canRedo={canRedo()}
          undoActionName={getUndoActionName()}
          redoActionName={getRedoActionName()}
          onResetToOriginal={() => setResetDialogOpen(true)}
          onCloseDocument={requestCloseDocument}
          canResetToOriginal={canResetToOriginal()}
          onExportFormData={handleExportFormData}
          onImportFormData={handleImportFormData}
          onFlattenForm={handleFlattenForm}
          onResetForm={handleResetForm}
          onDesignForm={() => setFormDesignerOpen(true)}
          onApplyRedactions={handleApplyRedactions}
          onRemoveContent={handleRemoveContent}
          onApplyContent={handleApplyContent}
          onEncryptExport={() => setEncryptDialogOpen(true)}
          onDocumentProperties={() => setPropertiesOpen(true)}
          onOCR={() => setOCROpen(true)}
          onPageDecorations={() => setPageDecorationsOpen(true)}
          onCompressPDF={() => setCompressPDFOpen(true)}
          onManageLinks={() => setLinksOpen(true)}
          onManageBookmarks={() => setBookmarksOpen(true)}
          onCheckText={() => { commitPendingEditors(); setTextCheckOpen(true); }}
          onCreatePDF={() => setCreatePDFOpen(true)}
          onExportPages={() => setExportPagesOpen('all')}
          onPDFToImages={() => setExportPagesOpen('images')}
          onSignature={() => { if (document) setSignatureSession({ document, version: documentVersion }); }}
          onCleanDocument={() => setCleanDocumentOpen(true)}
          isBusy={isLoading}
          onInsertImage={handleInsertImage}
        />

        <div ref={contextToolbarHost} className="workspace-context-toolbar">
        {/* Text Box Formatting Toolbar (shown when editing text box) */}
        {tiptapEditor && !isLoading && (
          <div className="textbox-format-toolbar-container">
            <TipTapToolbar editor={tiptapEditor} />
          </div>
        )}

        {/* Image Toolbar (shown when image is selected) */}
        {selectedImageAnnotation && !tiptapEditor && !isLoading && (
          <div className="image-format-toolbar-container">
            <ImageToolbar
              annotation={selectedImageAnnotation}
              onDelete={() => selectAnnotation(null)}
            />
          </div>
        )}

        </div>
        {document && pendingImages.length > 0 && currentTool === 'image' && <div className="image-placement-status" role="status">
          <span>{t("m.click.a.page.to.place.f79307")}{' '}{pendingImages[0].filename}.{pendingImages.length > 1 ? t("m.images.remaining.a0d632", { v0: pendingImages.length }) : ''}</span>
          <button type="button" onClick={() => { setPendingImages([]); setCurrentTool('select'); }}>{t("m.cancel.placement.739c5b")}</button>
        </div>}
        {/* Main content area */}
        <div className="main-layout" role="region" aria-label={t("m.pdf.document.viewer.dcba98")}>
          {/* Sidebar */}
          {document && sidebarOpen && (
            <aside className="sidebar" role="complementary" aria-label={t("m.document.navigation.64cf35")}>
              <div className="sidebar-tabs" role="tablist" aria-label={t("m.sidebar.views.84995e")}>
                <button
                  className={`sidebar-tab ${sidebarTab === 'thumbnails' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('thumbnails')}
                  role="tab"
                  aria-selected={sidebarTab === 'thumbnails'}
                  aria-controls="thumbnail-panel"
                >
                  {t("m.pages.600584")}</button>
                <button
                  className={`sidebar-tab ${sidebarTab === 'outline' ? 'active' : ''}`}
                  onClick={() => setSidebarTab('outline')}
                  role="tab"
                  aria-selected={sidebarTab === 'outline'}
                  aria-controls="outline-panel"
                >
                  {t("m.bookmarks.ca3cdd")}</button>
              </div>
              <div className="sidebar-content">
                {sidebarTab === 'thumbnails' && (
                  <div id="thumbnail-panel" role="tabpanel" aria-label={t("m.page.thumbnails.8e90ea")}>
                    <ThumbnailPanel
                      key={documentVersion}
                      document={document}
                      currentPage={navigation.currentPage}
                      selectedPages={selectedPages}
                      onPageSelect={handlePageSelection}
                      onReorderPages={isLoading ? undefined : handleReorderPages}
                    />
                  </div>
                )}
                {sidebarTab === 'outline' && (
                  <div id="outline-panel" role="tabpanel" aria-label={t("m.document.outline.12ebeb")}>
                    <OutlinePanel
                      key={documentVersion}
                      document={document}
                      onNavigate={handleLinkClick}
                      onManage={() => setBookmarksOpen(true)}
                      manageDisabled={isLoading}
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
            aria-label={t("m.document.content.a2e7e0")}
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
                onMergeComplete={async (data, insertionPosition, fileName) => {
                  if (mergeDocumentData) {
                    if (useDocumentStore.getState().documentVersion !== mergeDocumentData.documentVersion) {
                      throw new Error('Document changed. Reopen the merge dialog.');
                    }
                    await runOperation('Insert pages', async ({ totalPages, workspace }) => {
                      const merged = await PDFLibDocument.load(data);
                      const pageMap = insertionPageMap(totalPages, insertionPosition ?? 0, merged.getPageCount() - totalPages);
                      return { data, pageMap, workspace: remapWorkspacePages(workspace, pageMap) };
                    });
                  } else {
                    const file = new File([new Uint8Array(data)], fileName || 'merged.pdf', { type: 'application/pdf' });
                    if (!await loadFromFile(file)) throw new Error('Could not open the merged PDF');
                    fileHandle.current = undefined; setOutputFileName(file.name); markDocumentUnsaved();
                  }
                  setMergeDialogOpen(false);
                  setMergeDocumentData(null);
                }}
                currentDocument={mergeDocumentData}
              />
            )}

            {/* Split dialog */}
            {document && splitDialogOpen && (
              <SplitDialog
                preparePDF={async () => (await prepareExport()).data}
                totalPages={navigation.totalPages}
                onClose={() => setSplitDialogOpen(false)}
              />
            )}

            {/* Reset to Original confirmation dialog */}
            <ConfirmationDialog
              isOpen={resetDialogOpen}
              title={t("m.reset.to.original.e49d7b")}
              message={t("m.this.will.discard.all.changes.rotations.page.mod.6b2a33")}
              confirmLabel={t("m.reset.44c57a")}
              cancelLabel={t("m.cancel.77dfd2")}
              confirmVariant="danger"
              onConfirm={handleResetToOriginal}
              onCancel={() => setResetDialogOpen(false)}
            />

            {closeDialogOpen && <Suspense fallback={null}><SaveChangesDialog
              fileName={outputFileName ?? useDocumentSessionStore.getState().active?.fileName ?? 'document.pdf'} purpose={pendingOpen ? 'open' : 'close'}
              busy={isSaving} onSave={async () => { if (!await saveCurrentFile()) throw new DOMException('Save cancelled', 'AbortError'); await discardAndContinue(); }}
              onDiscard={() => { void discardAndContinue(); }} onCancel={() => { setPendingOpen(null); setCloseDialogOpen(false); }}
            /></Suspense>}

            {/* Loading state */}
            {isLoading && (
              <div className="loading-state">
                <div className="loading-spinner" />
                <span>{t("m.loading.pdf.3f59ed")}</span>
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="error-state" role="alert">
                <span className="error-icon">⚠</span>
                <span>{t("m.error.787aa1")}{' '}<ErrorMessage error={error} /></span>
                {document && <button type="button" onClick={() => { commitPendingEditors(); setTextCheckOpen(true); }}>{t('text.check.title')}</button>}
                <button className="toolbar-btn" onClick={() => useDocumentStore.getState().setError(null)}>{t("m.dismiss.70afe9")}</button>
              </div>
            )}

            {!document && !isLoading && !error && <div className="welcome-workspace">
              <div className="welcome-heading"><span className="welcome-eyebrow"><ShieldCheck size={14} />{t("m.local.processing.32deec")}</span><h1>{t("m.your.pdf.your.workspace.98dfd1")}</h1><p>{t("m.create.edit.and.organize.pdfs.in.your.browser.d34a81")}</p></div>
              <div className="drop-zone" role="region" aria-label={t("m.open.pdf.40fdbd")}><div className="drop-icon"><FileUp size={34} strokeWidth={1.5} /></div><h2>{t("m.open.a.pdf.24d206")}</h2><p>{t("m.drag.and.drop.a.pdf.file.here.or.click.to.select.78d499")}</p><button className="welcome-open" onClick={() => window.document.querySelector<HTMLInputElement>('.main-toolbar input[type=file]')?.click()}><FileUp size={16} />{t("m.select.file.5c0c87")}</button><p className="keyboard-hint">{t("m.press.ea683a")}{' '}<kbd>{t("m.ctrl.dd6a02")}</kbd>+<kbd>{t("m.o.08a914")}</kbd> {' '}{t("m.to.open.e2c7f6")}</p></div>
              <div className="welcome-cards">{[{ icon: FilePenLine, title: 'Edit original content', detail: 'Update text and images directly on the page.' }, { icon: Highlighter, title: 'Review and annotate', detail: 'Highlight, draw, add notes and sign.' }, { icon: Files, title: 'Organize pages', detail: 'Merge, split, reorder and rotate.' }].map(({ icon: Icon, title, detail }) => <div key={title}><Icon size={22} /><h3>{translateMessage(title)}</h3><p>{translateMessage(detail)}</p></div>)}</div>
              <button className="welcome-create" onClick={() => setCreatePDFOpen(true)}><ImagePlus size={17} />{t("m.create.pdfs.from.images.4f6979")}</button>
            </div>}

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
                onTextLayout={setTextLayoutBlockId}
                onCalculatedZoomChange={(zoom) => setZoom(zoom, navigation.zoomMode)}
                highlightDestination={highlightDest?.document === document && highlightDest.version === documentVersion ? highlightDest.destination : null}
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
          {document && <WorkspaceInspector onTextLayout={setTextLayoutBlockId} onProperties={() => setPropertiesOpen(true)} isBusy={isLoading} />}
        </div>
        <footer className="document-statusbar">
          {document && historyLimited && <span className="history-budget-note" title={t('history.budget.help')}>{t('history.budget.limited')}</span>}
        {document && (
          <div className={`session-save-status status-${persistence.status}`} role="status" aria-live="polite">
            {persistence.status === 'error'
              ? t("m.local.save.failed.4bd8de", { v0: translateMessage(persistence.error) })
              : persistence.status === 'saving' ? t("m.saving.changes.on.this.device.d1aa54") : t("m.changes.saved.on.this.device.6baf60")}
            {persistence.status === 'error' && <button onClick={() => void persistence.flush()}>{t("m.retry.9f5cd8")}</button>}
          </div>
        )}

          <div ref={setNavigationHost} className="document-navigation-slot" />
        </footer>
        <div className="app-feedback">
          <span>{t('feedback.prompt')}{' '}<a href="https://github.com/JhuoW/PDF-Editor/issues" target="_blank" rel="noopener noreferrer">{t('feedback.link')}</a></span>
          <button type="button" className="update-history-trigger" aria-haspopup="dialog" onClick={() => setUpdateHistoryOpen(true)}><History size={13} aria-hidden="true" />{t('updates.title')}</button>
        </div>
        {updateHistoryOpen && <Suspense fallback={<div role="status">{t('updates.loading')}</div>}><UpdateHistoryDialog onClose={() => setUpdateHistoryOpen(false)} /></Suspense>}
        {document && !isLoading && <StickyNoteEditor />}
        {passwordRequest && <PasswordDialog request={passwordRequest} onSubmit={submitPassword} onCancel={cancelPasswordRequest} />}
        {document && propertiesOpen && <Suspense fallback={<div role="status">{t("m.loading.document.properties.3f510b")}</div>}><DocumentPropertiesDialog isOpen={propertiesOpen} documentKey={getOriginalDocument()} revision={documentVersion}
          onClose={() => setPropertiesOpen(false)} readPDF={readPropertiesPDF} onApply={applyProperties} /></Suspense>}
        {document && ocrOpen && <Suspense fallback={<div role="status">{t("m.loading.ocr.000da0")}</div>}><OCRDialog documentKey={getOriginalDocument()} totalPages={navigation.totalPages}
          currentPage={navigation.currentPage} onRun={handleOCR} onClose={() => setOCROpen(false)} /></Suspense>}
        {createPDFOpen && <Suspense fallback={<div role="status">{t("m.loading.pdf.creation.ca53ea")}</div>}><CreatePDFDialog onCreate={async file => {
          await handleOpenFile(file, undefined, true);
        }} onClose={() => setCreatePDFOpen(false)} /></Suspense>}
        {document && pageManagementAction && <Suspense fallback={<div role="status">{t('pages.loading')}</div>}><PageManagementDialog action={pageManagementAction}
          initialMargins={cropMargins} totalPages={navigation.totalPages} currentPage={navigation.currentPage} selectedPages={selectedPages} onRun={handlePageManagement} onClose={() => { setPageManagementAction(null); setCropMargins(undefined); }} /></Suspense>}
        {document && exportPagesOpen && <Suspense fallback={<div role="status">{t("m.loading.page.export.5b4fcb")}</div>}><ExportPagesDialog readPDF={prepareExport} imagesOnly={exportPagesOpen === 'images'}
          totalPages={navigation.totalPages} currentPage={navigation.currentPage} selectedPages={selectedPages} onClose={() => setExportPagesOpen(null)} /></Suspense>}
        {document && formDesignerOpen && <Suspense fallback={<div role="status">{t("m.loading.form.designer.de3723")}</div>}><FormDesignerDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readFormDesignPDF} onSave={saveFormDesign} onClose={() => setFormDesignerOpen(false)} /></Suspense>}
        {document && pageDecorationsOpen && <Suspense fallback={<div role="status">{t("m.loading.page.decorations.53b350")}</div>}><PageDecorationsDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readDecorationsPDF} onApply={applyDecorations} onClose={() => setPageDecorationsOpen(false)} /></Suspense>}
        {document && cleanDocumentOpen && <Suspense fallback={<div role="status">{t("m.loading.document.cleanup.c90f35")}</div>}><CleanDocumentDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readCleanupPDF} onApply={applyCleanup} onClose={() => setCleanDocumentOpen(false)} /></Suspense>}
        {document && compressPDFOpen && <Suspense fallback={<div role="status">{t("m.loading.pdf.compression.41563b")}</div>}><CompressPDFDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readOptimizationPDF} onClose={() => setCompressPDFOpen(false)} /></Suspense>}
        {document && bookmarksOpen && <Suspense fallback={<div role="status">{t("m.loading.bookmarks.aa55ad")}</div>}><PDFBookmarksDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readBookmarksPDF} onApply={applyBookmarks} onClose={closeBookmarks} /></Suspense>}
        {document && signatureSession?.document === document && signatureSession.version === documentVersion && <Suspense fallback={<div role="status">{t("m.loading.signature.997592")}</div>}><SignatureDialog documentKey={document} revision={documentVersion}
          onInsert={image => { handleInsertImage([image]); setSignatureSession(null); }} onClose={() => setSignatureSession(null)} /></Suspense>}
        {document && linksOpen && <Suspense fallback={<div role="status">{t("m.loading.links.70cd04")}</div>}><PDFLinksDialog documentKey={getOriginalDocument()} revision={documentVersion} currentPage={navigation.currentPage}
          readPDF={readLinksPDF} onApply={applyLinks} onClose={closeLinks} /></Suspense>}
        {document && textLayoutBlockId && <Suspense fallback={<div role="status">{t("m.loading.text.layout.f422e8")}</div>}><TextLayoutDialog documentKey={getOriginalDocument()} revision={documentVersion} blockId={textLayoutBlockId}
          readPDF={readTextLayoutPDF} onSave={saveTextLayout} onClose={closeTextLayout} /></Suspense>}
        {document && textCheckOpen && <Suspense fallback={<div role="status">{t('text.check.running')}</div>}><TextCheckDialog key={documentVersion} pdf={document} revision={documentVersion} onClose={() => setTextCheckOpen(false)} onLocate={locateTextIssue} /></Suspense>}
        {document && encryptDialogOpen && (
          <EncryptDialog preparePDF={prepareExport} onClose={() => setEncryptDialogOpen(false)} />
        )}
        <FontManagerHost />
        {exportProgress && <PDFExportProgressDialog progress={exportProgress} onCancel={cancelExport} />}
      </div>
    </Theme></SearchDocumentContext.Provider>
  );
}

export default App;
