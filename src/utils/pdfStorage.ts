import type { DocumentSnapshot, HistorySnapshot } from '../store/historyStore';
import type { WorkspaceSnapshot } from '../store/workspaceSnapshot';
import type { useDocumentStore } from '../store/documentStore';
import type { PersistedDocumentSaveState } from '../store/documentSaveStore';

const DB_NAME = 'pdf-editor-storage';
const DB_VERSION = 1;
const STORE_NAME = 'pdfs';
const CURRENT_PDF_KEY = 'current-pdf';
const CURRENT_SESSION_KEY = 'current-session';
const CURRENT_HISTORY_KEY = 'current-history';
const REVISION_PREFIX = 'pdf-revision:';

export interface StoredSessionState {
  workspace?: WorkspaceSnapshot;
  originalDocument?: DocumentSnapshot | null;
  history?: { undoStack: HistorySnapshot[]; redoStack: HistorySnapshot[] };
  navigation?: ReturnType<typeof useDocumentStore.getState>['navigation'];
  fileSaveState?: PersistedDocumentSaveState;
}

export interface StoredPDF extends StoredSessionState {
  data: ArrayBuffer;
  fileName: string;
  sessionId?: string;
  needsMigration?: boolean;
}

type DocumentReference = Omit<DocumentSnapshot, 'data'> & { pdfRevision: string };
type StoredSnapshot = HistorySnapshot | DocumentReference;
type StoredHistory = { undoStack: StoredSnapshot[]; redoStack: StoredSnapshot[] };
interface HistoryRecord {
  id: string;
  version?: 2;
  sessionId?: string;
  originalDocument?: DocumentSnapshot | DocumentReference | null;
  history?: StoredHistory;
}
interface SessionRecord extends Pick<StoredSessionState, 'workspace' | 'navigation' | 'fileSaveState'> {
  id: string;
  sessionId?: string;
  pdfRevision?: string;
}
interface PDFRecord extends Omit<StoredPDF, 'data'> {
  id: string;
  version?: 2;
  data?: ArrayBuffer;
  pdfRevision?: string;
  lastOpened?: number;
}
interface RevisionRecord { id: string; sessionId?: string; data: ArrayBuffer }
interface RevisionRegistry {
  buffers: WeakMap<ArrayBuffer, { sessionId?: string; id: string }>;
  present: Set<string>;
}
// IndexedDB factories have independent storage (including isolated test databases).
const registries = new WeakMap<IDBFactory, RevisionRegistry>();
function revisionRegistry(): RevisionRegistry {
  let registry = registries.get(indexedDB);
  if (!registry) {
    registry = { buffers: new WeakMap(), present: new Set() };
    registries.set(indexedDB, registry);
  }
  return registry;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(new Error('Failed to open IndexedDB'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
  });
}

// Register immutable revisions only after transaction completion, never request success.
async function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, fail: (error: unknown) => void) => () => T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let failure: unknown;
    try {
      transaction = db.transaction(STORE_NAME, mode);
      const fail = (error: unknown) => { failure = error; transaction!.abort(); };
      transaction.oncomplete = () => {
        db.close();
        try { resolve(result()); } catch (error) { reject(error); }
      };
      transaction.onabort = () => {
        db.close();
        reject(failure ?? transaction?.error ?? new Error('PDF storage transaction aborted'));
      };
      const result = operation(transaction.objectStore(STORE_NAME), fail);
    } catch (error) {
      failure = error;
      if (transaction) transaction.abort();
      else { db.close(); reject(error); }
    }
  });
}

function revisionWriter(store: IDBObjectStore, registry: RevisionRegistry, sessionId: string | undefined, fail: (error: unknown) => void) {
  const pending = new Map<ArrayBuffer, string>();
  const retained = new Set<string>();
  const removed = new Set<string>();
  const checked = new Set<string>();
  const reference = (data: ArrayBuffer) => {
    if (!(data instanceof ArrayBuffer)) throw new Error('A PDF history snapshot has no readable data.');
    const registered = registry.buffers.get(data);
    let id = registered && registered.sessionId === sessionId && registry.present.has(registered.id) ? registered.id : pending.get(data);
    if (!id) {
      id = `${REVISION_PREFIX}${crypto.randomUUID()}`;
      store.put({ id, sessionId, data } satisfies RevisionRecord);
      pending.set(data, id);
    } else if (!pending.has(data) && !checked.has(id)) {
      // Another tab can prune a previously cached revision. Check its key
      // without reading/cloning bytes, and recreate it atomically if needed.
      const revisionId = id;
      checked.add(id);
      const exists = store.getKey(id);
      exists.onsuccess = () => {
        try {
          if (exists.result === undefined) {
            store.put({ id: revisionId, sessionId, data } satisfies RevisionRecord);
            pending.set(data, revisionId);
          }
        } catch (error) { fail(error); }
      };
    }
    retained.add(id);
    return id;
  };
  const snapshot = (entry: StoredSnapshot): StoredSnapshot => {
    if ('pdfRevision' in entry) { retained.add(entry.pdfRevision); return entry; }
    if (!('data' in entry)) return entry;
    const { data, ...metadata } = entry;
    return { ...metadata, pdfRevision: reference(data) };
  };
  const checkpoint = (state: Pick<HistoryRecord, 'originalDocument' | 'history'>): HistoryRecord => ({
    id: CURRENT_HISTORY_KEY, version: 2, sessionId,
    originalDocument: state.originalDocument ? snapshot(state.originalDocument) as DocumentReference : state.originalDocument,
    history: state.history ? {
      undoStack: state.history.undoStack.map(snapshot), redoStack: state.history.redoStack.map(snapshot),
    } : undefined,
  });
  return {
    reference, checkpoint,
    retain: (id?: string) => { if (id) retained.add(id); },
    collect: (fail: (error: unknown) => void) => {
      // Key cursors never read/clone the large revision values being collected.
      const cursor = store.openKeyCursor();
      cursor.onsuccess = () => {
        try {
          const entry = cursor.result;
          if (!entry) return;
          const key = entry.primaryKey;
          if (typeof key === 'string' && key.startsWith(REVISION_PREFIX) && !retained.has(key)) {
            store.delete(key); removed.add(key);
          }
          entry.continue();
        } catch (error) { fail(error); }
      };
    },
    commit: () => {
      for (const id of removed) registry.present.delete(id);
      for (const [data, id] of pending) {
        registry.buffers.set(data, { sessionId, id }); registry.present.add(id);
      }
    },
  };
}

/** Atomically replace the PDF, its editable workspace, and its history checkpoint. */
export async function saveCurrentPDF(
  data: ArrayBuffer,
  fileName: string,
  session: StoredSessionState & { sessionId?: string } = {},
): Promise<void> {
  const registry = revisionRegistry();
  await runTransaction('readwrite', (store, fail) => {
    let writer: ReturnType<typeof revisionWriter>;
    // Begin encoding in an active request callback: earlier queued transactions
    // have committed their revision identities before we attempt to reuse them.
    const ready = store.get(CURRENT_SESSION_KEY);
    ready.onsuccess = () => {
      try {
        writer = revisionWriter(store, registry, session.sessionId, fail);
        const pdfRevision = writer.reference(data);
        const history = writer.checkpoint(session);
        store.put({ id: CURRENT_PDF_KEY, version: 2, pdfRevision, fileName, sessionId: session.sessionId, lastOpened: Date.now() } satisfies PDFRecord);
        store.put({ id: CURRENT_SESSION_KEY, pdfRevision, sessionId: session.sessionId, workspace: session.workspace, navigation: session.navigation, fileSaveState: session.fileSaveState } satisfies SessionRecord);
        store.put(history);
        writer.collect(fail);
      } catch (error) { fail(error); }
    };
    return () => { writer.commit(); };
  });
}

/** Read one consistent checkpoint, hydrating each referenced PDF buffer only once. */
export async function loadCurrentPDF(): Promise<StoredPDF | null> {
  const registry = revisionRegistry();
  return runTransaction('readonly', (store, fail) => {
    const base = store.get(CURRENT_PDF_KEY);
    const workspace = store.get(CURRENT_SESSION_KEY);
    const checkpoint = store.get(CURRENT_HISTORY_KEY);
    let combined: (Omit<PDFRecord, 'history' | 'originalDocument'> & Pick<HistoryRecord, 'history' | 'originalDocument'>) | undefined;
    let needsMigration = false;
    const revisions = new Map<string, ArrayBuffer>();
    checkpoint.onsuccess = () => {
      try {
        const record = base.result as PDFRecord | undefined;
        if (!record) return;
        const session = workspace.result as SessionRecord | undefined;
        const history = checkpoint.result as HistoryRecord | undefined;
        needsMigration = Boolean(record.sessionId && (record.version !== 2 || session?.sessionId !== record.sessionId));
        combined = { ...record,
          ...(session?.sessionId === record.sessionId ? session : {}),
          ...(history?.sessionId === record.sessionId ? history : {}),
        };
        const ids = new Set<string>();
        const inspect = (entry: StoredSnapshot | null | undefined) => { if (entry && 'pdfRevision' in entry) ids.add(entry.pdfRevision); };
        if (combined.pdfRevision) ids.add(combined.pdfRevision);
        inspect(combined.originalDocument);
        for (const entry of [...combined.history?.undoStack ?? [], ...combined.history?.redoStack ?? []]) inspect(entry);
        for (const id of ids) {
          const request = store.get(id);
          request.onsuccess = () => {
            const revision = request.result as RevisionRecord | undefined;
            if (!revision || !(revision.data instanceof ArrayBuffer) || revision.sessionId !== record.sessionId) {
              fail(new Error('A saved PDF history revision is missing or belongs to another session.'));
            } else revisions.set(id, revision.data);
          };
        }
      } catch (error) { fail(error); }
    };
    return () => {
      if (!combined) return null;
      const hydrate = (entry: StoredSnapshot): HistorySnapshot => {
        if (!('pdfRevision' in entry)) return entry;
        const { pdfRevision, ...metadata } = entry;
        return { ...metadata, data: revisions.get(pdfRevision)! };
      };
      const result: StoredPDF = { data: combined.pdfRevision ? revisions.get(combined.pdfRevision)! : combined.data!, fileName: combined.fileName };
      if (!(result.data instanceof ArrayBuffer)) throw new Error('The saved PDF has no readable data.');
      if (combined.sessionId !== undefined) result.sessionId = combined.sessionId;
      if (needsMigration) result.needsMigration = true;
      if (combined.workspace !== undefined) result.workspace = combined.workspace;
      if (combined.navigation !== undefined) result.navigation = combined.navigation;
      if (combined.fileSaveState !== undefined) result.fileSaveState = combined.fileSaveState;
      if (combined.originalDocument !== undefined) result.originalDocument = combined.originalDocument ? hydrate(combined.originalDocument) as DocumentSnapshot : null;
      if (combined.history) result.history = { undoStack: combined.history.undoStack.map(hydrate), redoStack: combined.history.redoStack.map(hydrate) };
      for (const [id, data] of revisions) {
        registry.buffers.set(data, { sessionId: combined.sessionId, id }); registry.present.add(id);
      }
      return result;
    };
  });
}

/** Write editing state and small history metadata without rewriting immutable PDF revisions. */
export async function saveCurrentSession(sessionId: string, state: StoredSessionState): Promise<boolean> {
  const registry = revisionRegistry();
  return runTransaction('readwrite', (store, fail) => {
    const request = store.get(CURRENT_SESSION_KEY);
    let updated = false;
    let writer: ReturnType<typeof revisionWriter> | undefined;
    request.onsuccess = () => {
      const current = request.result as SessionRecord | undefined;
      if (!current || current.sessionId !== sessionId) return;
      try {
        const next = { ...current };
        if (state.workspace !== undefined) next.workspace = state.workspace;
        if (state.navigation !== undefined) next.navigation = state.navigation;
        if (state.fileSaveState !== undefined) next.fileSaveState = state.fileSaveState;
        store.put(next);
        updated = true;
        if (state.originalDocument === undefined && state.history === undefined) return;
        const saveHistory = (previous: HistoryRecord = { id: CURRENT_HISTORY_KEY }) => {
          try {
            writer = revisionWriter(store, registry, sessionId, fail);
            writer.retain(current.pdfRevision);
            const history = writer.checkpoint({
              originalDocument: state.originalDocument !== undefined ? state.originalDocument : previous.originalDocument,
              history: state.history ?? previous.history,
            });
            store.put(history);
            writer.collect(fail);
          } catch (error) { fail(error); }
        };
        if (state.originalDocument !== undefined && state.history !== undefined) saveHistory();
        else {
          const previous = store.get(CURRENT_HISTORY_KEY);
          previous.onsuccess = () => {
            const record = previous.result as HistoryRecord | undefined;
            saveHistory(record?.sessionId === sessionId ? record : undefined);
          };
        }
      } catch (error) { fail(error); }
    };
    return () => { writer?.commit(); return updated; };
  });
}

export async function clearCurrentPDF(expectedSessionId?: string): Promise<void> {
  const registry = revisionRegistry();
  await runTransaction('readwrite', (store, fail) => {
    let writer: ReturnType<typeof revisionWriter> | undefined;
    const clear = () => {
      store.delete(CURRENT_PDF_KEY); store.delete(CURRENT_SESSION_KEY); store.delete(CURRENT_HISTORY_KEY);
      writer = revisionWriter(store, registry, undefined, fail); writer.collect(fail);
    };
    if (expectedSessionId) {
      const request = store.get(CURRENT_PDF_KEY);
      request.onsuccess = () => { if ((request.result as PDFRecord | undefined)?.sessionId === expectedSessionId) clear(); };
    } else clear();
    return () => { if (writer) { writer.commit(); registry.buffers = new WeakMap(); } };
  });
}
