import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfjsLib, pdfDocumentOptions } from '../utils/pdfConfig';
import { useDocumentStore } from '../store/documentStore';
import { saveCurrentPDF, loadCurrentPDF, clearCurrentPDF, type StoredSessionState } from '../utils/pdfStorage';
import { startDocumentSession, clearDocumentSession, useDocumentSessionStore } from '../store/documentSession';
import { captureWorkspace, createWorkspace, restoreWorkspace, type WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { useHistoryStore, type HistoryTimeline } from '../store/historyStore';
import { migrateLegacyHistory } from '../store/migrateHistory';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { importEditableAnnotations } from '../annotations/AnnotationImporter';
import { decryptPDF } from '../core/PDFEncryption';

export interface PDFPasswordRequest {
  id: string;
  fileName: string;
  reason: 'required' | 'incorrect';
}

export interface LoadOptions {
  fileName?: string;
  preserveState?: boolean;
  persist?: boolean;
  workspace?: WorkspaceSnapshot;
  restore?: StoredSessionState;
  sessionId?: string;
  history?: HistoryTimeline;
}

export function usePDFDocument() {
  const {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    setDocument,
    setLoading,
    setError,
    setCurrentPage,
    setZoom,
    setZoomMode,
    setViewMode,
    setRotation,
  } = useDocumentStore();

  const loadVersion = useRef(0);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const activeLoad = useRef<{ cancel: (updateUI?: boolean) => void; committing: boolean } | null>(null);
  const passwordHandler = useRef<{ version: number; apply: (password: string) => void } | null>(null);
  const [passwordRequest, setPasswordRequest] = useState<PDFPasswordRequest | null>(null);

  const submitPassword = useCallback((password: string) => {
    const pending = passwordHandler.current;
    if (!pending || pending.version !== loadVersion.current) return;
    passwordHandler.current = null;
    setPasswordRequest(null);
    pending.apply(password);
  }, []);

  const cancelPasswordRequest = useCallback(() => {
    activeLoad.current?.cancel();
  }, []);

  const loadDocument = useCallback(async (
    source: string | ArrayBuffer | Uint8Array | File,
    options: LoadOptions = {}
  ): Promise<boolean> => {
    useDocumentStore.getState().beginLoadRequest();
    const version = ++loadVersion.current;
    activeLoad.current?.cancel();
    let cancelled = false;
    const isCurrent = () => !cancelled && version === loadVersion.current;
    const fileName = options.fileName ?? (source instanceof File ? source.name : 'document.pdf');
    setLoading(true);
    setError(null);
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | undefined;
    let suppliedPassword: string | undefined;
    let signalCancellation!: () => void;
    const cancellation = new Promise<void>(resolve => { signalCancellation = resolve; });
    const cancelledError = new Error('PDF loading was cancelled');
    const destroyedTasks = new WeakSet<object>();
    const disposedDocuments = new WeakSet<object>();
    const disposeDocument = async (doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>) => {
      if (disposedDocuments.has(doc)) return;
      disposedDocuments.add(doc);
      await doc.destroy();
    };
    const destroyTask = () => {
      if (loadingTask && !destroyedTasks.has(loadingTask)) {
        destroyedTasks.add(loadingTask);
        void loadingTask.destroy().catch(() => {});
      }
    };
    const request = {
      committing: false,
      cancel(updateUI = true) {
        // A started save and its publication remain one indivisible commit.
        if (request.committing || cancelled) return;
        cancelled = true;
        suppliedPassword = undefined;
        if (passwordHandler.current?.version === version) {
          passwordHandler.current = null;
          if (updateUI) setPasswordRequest(null);
        }
        destroyTask();
        signalCancellation();
      },
    };
    activeLoad.current = request;
    const waitFor = <T,>(promise: Promise<T>): Promise<T> => Promise.race([
      promise, cancellation.then(() => { throw cancelledError; }),
    ]);
    const parseDocument = async (input: Parameters<typeof pdfjsLib.getDocument>[0], allowPassword = false) => {
      const task = pdfjsLib.getDocument(input);
      loadingTask = task;
      if (allowPassword) task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
        if (!isCurrent()) { destroyTask(); return; }
        passwordHandler.current = {
          version, apply: password => { suppliedPassword = password; updatePassword(password); },
        };
        setPasswordRequest({ id: crypto.randomUUID(), fileName,
          reason: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required' });
      };
      // Destruction normally rejects PDF.js's promise. Also settle our own
      // cancellation race and release a late proxy from custom PDF transports.
      void task.promise.then(doc => {
        if (cancelled) void disposeDocument(doc).catch(() => {});
      }).catch(() => {});
      return waitFor(task.promise);
    };

    try {
      // Finish a commit that has already started before opening another file.
      // This keeps the visible document and the persisted PDF in the same order.
      await waitFor(persistenceQueue.current);
      if (!isCurrent()) return false;
      const input = source instanceof File ? await waitFor(source.arrayBuffer()) : source;
      if (!isCurrent()) return false;

      // Keep our own bytes: PDF.js transfers its input buffer to its worker.
      const bytes = typeof input === 'string' ? null : new Uint8Array(
        input instanceof Uint8Array ? input : new Uint8Array(input)
      );
      let doc = await parseDocument({ ...pdfDocumentOptions,
        ...(typeof input === 'string' ? { url: input } : { data: bytes!.slice() }) }, true);
      if (!isCurrent()) {
        await disposeDocument(doc);
        return false;
      }
      let data = bytes ? bytes.buffer : new Uint8Array(await waitFor(doc.getData())).buffer;
      // Reset to Original must retain the unmodified source, including native notes.
      const originalData = data;
      // PDF.js returns null permissions only for unencrypted documents. This
      // detects empty-user-password encryption without loading WASM for every
      // ordinary PDF; authentication alone would miss those protected files.
      const sourcePermissions = await waitFor(doc.getPermissions());
      if (suppliedPassword !== undefined || sourcePermissions !== null) {
        const unlocked = await waitFor(decryptPDF(data, suppliedPassword ?? ''));
        suppliedPassword = undefined;
        await disposeDocument(doc);
        if (!isCurrent()) return false;
        data = unlocked.data;
        doc = await parseDocument({ ...pdfDocumentOptions, data: new Uint8Array(data).slice() });
      }

      let workspace = options.workspace ?? options.restore?.workspace;
      let formWarning: string | null = null;
      if (!workspace) {
        if (options.preserveState) {
          workspace = captureWorkspace();
        } else {
          let imported: Awaited<ReturnType<typeof importEditableAnnotations>> | undefined;
          try {
            imported = await waitFor(importEditableAnnotations(data));
          } catch (error) {
            formWarning = `PDF opened, but native notes could not be prepared for editing: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
          if (!isCurrent()) { await disposeDocument(doc); return false; }
          if (imported && imported.data !== data) {
            await disposeDocument(doc);
            if (!isCurrent()) return false;
            data = imported.data;
            doc = await parseDocument({ ...pdfDocumentOptions, data: new Uint8Array(data).slice() });
            if (!isCurrent()) { await disposeDocument(doc); return false; }
          }
          try {
            workspace = createWorkspace(await waitFor(extractFormFields(data)));
          } catch (error) {
            workspace = createWorkspace();
            formWarning = `PDF opened, but form fields could not be loaded: ${error instanceof Error ? error.message : 'Unknown error'}`;
          }
          if (imported) workspace.annotations = imported.annotations;
        }
      }
      if (!isCurrent()) {
        await disposeDocument(doc);
        return false;
      }
      const history = useHistoryStore.getState();
      const migrated = migrateLegacyHistory(workspace, options.history ?? options.restore?.history ?? (options.preserveState
        ? { undoStack: history.undoStack, redoStack: history.redoStack } : { undoStack: [], redoStack: [] }), history.maxHistory);
      workspace = migrated.workspace;
      const navigation = options.restore?.navigation ?? {
        ...useDocumentStore.getState().navigation,
        currentPage: options.preserveState ? useDocumentStore.getState().navigation.currentPage : 1,
        zoomMode: options.preserveState ? useDocumentStore.getState().navigation.zoomMode : 'fit-page' as const,
        rotation: options.preserveState ? useDocumentStore.getState().navigation.rotation : 0,
      };
      const sessionId = options.sessionId ?? crypto.randomUUID();
      const session: StoredSessionState & { sessionId: string } = {
        sessionId,
        workspace,
        originalDocument: options.restore?.originalDocument ?? (options.preserveState ? history.originalDocument : null) ?? {
          data: originalData, fileName, timestamp: Date.now(), actionName: 'Original',
        },
        history: migrated.history,
        navigation: {
          ...navigation,
          currentPage: Math.max(1, Math.min(navigation.currentPage, doc.numPages)),
          totalPages: doc.numPages,
        },
      };
      const publishDocument = () => {
        const previousDocument = useDocumentStore.getState().document;
        if (!options.preserveState) startDocumentSession(data, fileName, session);
        else {
          restoreWorkspace(workspace);
          useHistoryStore.setState({ ...session.history!, coalescingKey: null });
        }
        setDocument(doc, options.preserveState);
        useDocumentStore.setState({ navigation: session.navigation! });
        useDocumentSessionStore.setState({ active: { sessionId, fileName } });
        setError(formWarning);
        void previousDocument?.destroy().catch(err => console.error('Failed to release PDF:', err));
      };

      if (options.persist !== false) {
        const commit = persistenceQueue.current.then(async () => {
          if (!isCurrent()) return false;
          request.committing = true;
          await saveCurrentPDF(data, fileName, session);
          // Once a write starts it is committed as a unit with the visible file.
          // A newer open waits for this commit before parsing its own input.
          publishDocument();
          return true;
        });
        persistenceQueue.current = commit.then(() => {}, () => {});
        const committed = await commit;
        if (!committed) await disposeDocument(doc);
        return committed;
      }
      if (!isCurrent()) {
        await disposeDocument(doc);
        return false;
      }
      publishDocument();
      return true;
    } catch (err) {
      destroyTask();
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : 'Failed to load PDF');
      }
      // Keep the current file and its edits available if opening another file fails.
      return false;
    } finally {
      suppliedPassword = undefined;
      if (passwordHandler.current?.version === version) {
        passwordHandler.current = null;
        setPasswordRequest(null);
      }
      if (activeLoad.current === request) activeLoad.current = null;
      if (version === loadVersion.current) setLoading(false);
    }
  }, [setDocument, setLoading, setError]);

  const loadFromFile = useCallback((file: File, options: LoadOptions = {}) => {
    return loadDocument(file, options);
  }, [loadDocument]);

  useEffect(() => {
    let cancelled = false;
    const version = loadVersion.current;
    void loadCurrentPDF().then(stored => {
      // An explicit open takes precedence over restoring the previous session.
      if (!cancelled && version === loadVersion.current && stored) {
        void loadDocument(stored.data, {
          fileName: stored.fileName,
          restore: stored,
          sessionId: stored.sessionId,
          // Old records contain only PDF bytes. Upgrade them to an identified session.
          persist: !stored.sessionId || stored.needsMigration === true,
        });
      }
    }).catch(err => {
      if (!cancelled && version === loadVersion.current) {
        setError(`Could not restore the last session: ${err instanceof Error ? err.message : 'Storage unavailable'}`);
      }
    });

    return () => {
      cancelled = true;
      // This is a request counter, not a DOM ref; invalidate all pending loads.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadVersion.current++;
      activeLoad.current?.cancel(false);
    };
  }, [loadDocument, setError]);

  const closeDocument = useCallback(async (): Promise<boolean> => {
    useDocumentStore.getState().beginLoadRequest();
    const version = ++loadVersion.current;
    activeLoad.current?.cancel();
    setLoading(true);
    const closing = persistenceQueue.current.then(async () => {
      await clearCurrentPDF();
      const previousDocument = useDocumentStore.getState().document;
      clearDocumentSession();
      setDocument(null);
      setError(null);
      void previousDocument?.destroy().catch(err => console.error('Failed to release PDF:', err));
    });
    persistenceQueue.current = closing.then(() => {}, () => {});
    try {
      await closing;
      return true;
    } catch (err) {
      if (version === loadVersion.current) setError(err instanceof Error ? err.message : 'Could not close the document');
      return false;
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [setDocument, setError, setLoading]);

  const loadFromUrl = useCallback((url: string) => loadDocument(url), [loadDocument]);

  const goToPage = useCallback((page: number) => {
    if (document && Number.isInteger(page) && page >= 1 && page <= document.numPages) {
      setCurrentPage(page);
    }
  }, [document, setCurrentPage]);

  const nextPage = useCallback(() => {
    if (document && navigation.currentPage < document.numPages) {
      setCurrentPage(navigation.currentPage + 1);
    }
  }, [document, navigation.currentPage, setCurrentPage]);

  const previousPage = useCallback(() => {
    if (navigation.currentPage > 1) {
      setCurrentPage(navigation.currentPage - 1);
    }
  }, [navigation.currentPage, setCurrentPage]);

  const zoomIn = useCallback(() => {
    const newZoom = Math.min(navigation.zoom * 1.25, 4);
    setZoom(newZoom, 'manual');
  }, [navigation.zoom, setZoom]);

  const zoomOut = useCallback(() => {
    const newZoom = Math.max(navigation.zoom / 1.25, 0.25);
    setZoom(newZoom, 'manual');
  }, [navigation.zoom, setZoom]);

  const fitToPage = useCallback(() => {
    setZoomMode('fit-page');
  }, [setZoomMode]);

  const fitToWidth = useCallback(() => {
    setZoomMode('fit-width');
  }, [setZoomMode]);

  const rotate = useCallback((degrees: 90 | -90 | 180) => {
    const newRotation = (navigation.rotation + degrees + 360) % 360;
    setRotation(newRotation);
  }, [navigation.rotation, setRotation]);

  return {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    loadDocument,
    loadFromFile,
    loadFromUrl,
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
    setZoomMode,
    fitToPage,
    fitToWidth,
    setViewMode,
    rotate,
    setCurrentPage,
  };
}
