import { useCallback, useEffect, useRef, useState } from 'react';
import { saveCurrentSession } from '../utils/pdfStorage';
import { captureSessionState, useDocumentSessionStore } from '../store/documentSession';
import { useDocumentStore } from '../store/documentStore';
import { useAnnotationStore } from '../store/annotationStore';
import { useAnnotationHistoryStore } from '../store/annotationHistoryStore';
import { useFormStore } from '../store/formStore';
import { useEditingStore } from '../store/editingStore';
import { useHistoryStore } from '../store/historyStore';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
interface PersistenceState {
  status: SaveStatus;
  error: string | null;
}

const SAVE_INTERVAL = 500;

/** Save complete editing sessions at most once per interval, never once per mouse move. */
export function useSessionPersistence() {
  const [state, setState] = useState<PersistenceState>({ status: 'idle', error: null });
  const flushRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    let disposed = false;
    let changeVersion = 0;
    const checkpoint = () => {
      const { originalDocument, undoStack, redoStack } = useHistoryStore.getState();
      return { originalDocument, undoStack, redoStack, sessionId: useDocumentSessionStore.getState().active?.sessionId };
    };
    // A newly opened session was committed with these history references already.
    let savedCheckpoint = checkpoint();

    const updateState = (status: SaveStatus, error: string | null = null) => {
      if (disposed) return;
      setState(previous => previous.status === status && previous.error === error ? previous : { status, error });
    };

    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const session = useDocumentSessionStore.getState().active;
      if (!session || useDocumentStore.getState().isLoading) return queue;
      const expectedVersion = changeVersion;
      queue = queue.catch(() => {}).then(async () => {
        if (useDocumentSessionStore.getState().active !== session || useDocumentStore.getState().isLoading) return;
        updateState('saving');
        try {
          // Snapshot once, after queued writes finish; no PDF buffers are copied on edit events.
          const snapshot = captureSessionState();
          const currentCheckpoint = checkpoint();
          if (savedCheckpoint.sessionId === currentCheckpoint.sessionId
            && savedCheckpoint.originalDocument === currentCheckpoint.originalDocument
            && savedCheckpoint.undoStack === currentCheckpoint.undoStack
            && savedCheckpoint.redoStack === currentCheckpoint.redoStack) {
            delete snapshot.originalDocument;
            delete snapshot.history;
          }
          const saved = await saveCurrentSession(session.sessionId, snapshot);
          if (useDocumentSessionStore.getState().active !== session) return;
          if (!saved) throw new Error('The cached document changed. Reopen this file to resume automatic saving.');
          savedCheckpoint = currentCheckpoint;
          if (expectedVersion === changeVersion) updateState('saved');
        } catch (error) {
          if (useDocumentSessionStore.getState().active === session) {
            updateState('error', error instanceof Error ? error.message : 'Could not save the editing session');
          }
        }
      });
      return queue;
    };

    const schedule = () => {
      changeVersion++;
      if (!useDocumentSessionStore.getState().active) {
        clearTimeout(timer);
        timer = undefined;
        updateState('idle');
        return;
      }
      if (useDocumentStore.getState().isLoading) return;
      updateState('saving');
      if (timer === undefined) timer = setTimeout(() => { void flush(); }, SAVE_INTERVAL);
    };

    flushRef.current = flush;
    const unsubscribers = [
      useDocumentSessionStore.subscribe(() => {
        savedCheckpoint = checkpoint();
        schedule();
      }),
      useDocumentStore.subscribe((next, previous) => {
        if (next.navigation !== previous.navigation || next.isLoading !== previous.isLoading) schedule();
      }),
      useAnnotationStore.subscribe((next, previous) => {
        if (next.annotations !== previous.annotations) schedule();
      }),
      useAnnotationHistoryStore.subscribe((next, previous) => {
        if (next.past !== previous.past || next.future !== previous.future) schedule();
      }),
      useFormStore.subscribe((next, previous) => {
        if (next.fields !== previous.fields || next.originalValues !== previous.originalValues || next.isDirty !== previous.isDirty) schedule();
      }),
      useEditingStore.subscribe((next, previous) => {
        if (next.textBlocks !== previous.textBlocks || next.images !== previous.images || next.redactions !== previous.redactions
          || next.textEdits !== previous.textEdits || next.imageEdits !== previous.imageEdits) schedule();
      }),
      useHistoryStore.subscribe((next, previous) => {
        if (next.originalDocument !== previous.originalDocument || next.undoStack !== previous.undoStack || next.redoStack !== previous.redoStack) schedule();
      }),
    ];
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const flushOnPageHide = () => { void flush(); };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushOnPageHide);

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribers.forEach(unsubscribe => unsubscribe());
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
      flushRef.current = async () => {};
    };
  }, []);

  const flush = useCallback(() => flushRef.current(), []);
  return { ...state, flush };
}
