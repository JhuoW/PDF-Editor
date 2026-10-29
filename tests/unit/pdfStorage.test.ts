import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { clearCurrentPDF, loadCurrentPDF, saveCurrentPDF, saveCurrentSession } from '../../src/utils/pdfStorage';
import { createWorkspace } from '../../src/store/workspaceSnapshot';

const data = new Uint8Array([1, 2, 3]).buffer;

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function writeLegacyRecord(record: object) {
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('pdf-editor-storage', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('pdfs', { keyPath: 'id' });
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('pdfs', 'readwrite');
      transaction.objectStore('pdfs').put({ id: 'current-pdf', ...record });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

async function storedRecords(): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('pdf-editor-storage', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, transaction = db.transaction('pdfs', 'readonly');
      const request = transaction.objectStore('pdfs').getAll();
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

async function rawWrite(operation: (store: IDBObjectStore) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('pdf-editor-storage', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, transaction = db.transaction('pdfs', 'readwrite');
      operation(transaction.objectStore('pdfs') as unknown as IDBObjectStore);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

describe('PDF storage transaction completion', () => {
  it('waits for the transaction commit after a write request succeeds', async () => {
    let finished = false;
    let requestSucceeded = false;
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => {
        requestSucceeded = true;
        expect(finished).toBe(false);
      });
      return request;
    });
    await saveCurrentPDF(data, 'sample.pdf').then(() => { finished = true; });
    expect(requestSucceeded).toBe(true);
    expect(finished).toBe(true);
  });

  it('rejects an aborted commit and atomically retains all previous session records', async () => {
    const oldSession = { sessionId: 'old', workspace: createWorkspace(), history: { undoStack: [], redoStack: [] } };
    await saveCurrentPDF(data, 'old.pdf', oldSession);
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(saveCurrentPDF(new ArrayBuffer(4), 'new.pdf', { sessionId: 'new', workspace: createWorkspace() }))
      .rejects.toThrow('aborted');
    await expect(loadCurrentPDF()).resolves.toEqual({ data, fileName: 'old.pdf', ...oldSession });
  });

  it('keeps support for bare PDF records and deletes every session record on close', async () => {
    await writeLegacyRecord({ data, fileName: 'legacy.pdf' });
    await expect(loadCurrentPDF()).resolves.toEqual({ data, fileName: 'legacy.pdf' });
    await saveCurrentPDF(data, 'sample.pdf', { sessionId: 'session', workspace: createWorkspace() });
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete');
    await clearCurrentPDF();
    expect(deletion.mock.calls.map(([key]) => key)).toEqual([
      'current-pdf', 'current-session', 'current-history', expect.stringMatching(/^pdf-revision:/),
    ]);
    await expect(loadCurrentPDF()).resolves.toBeNull();
    await expect(saveCurrentSession('session', { workspace: createWorkspace() })).resolves.toBe(false);
  });
});

describe('complete session storage', () => {
  it('round-trips workspace, original bytes, navigation, and both history stacks', async () => {
    const session = {
      sessionId: 'session-a', workspace: createWorkspace(),
      originalDocument: { data: new ArrayBuffer(2), fileName: 'original.pdf', timestamp: 1, actionName: 'Original' },
      history: { undoStack: [], redoStack: [] },
      navigation: { currentPage: 2, totalPages: 3, zoom: 1.5, zoomMode: 'manual' as const, viewMode: 'continuous' as const, rotation: 90 },
    };
    await saveCurrentPDF(data, 'edited.pdf', session);
    await expect(loadCurrentPDF()).resolves.toEqual({ data, fileName: 'edited.pdf', ...session });
  });

  it('updates frequent workspace changes without reading or writing PDF or history buffers', async () => {
    const originalDocument = { data: new ArrayBuffer(2), fileName: 'original.pdf', timestamp: 1, actionName: 'Original' };
    await saveCurrentPDF(data, 'edited.pdf', {
      sessionId: 'session-a', workspace: createWorkspace(), originalDocument,
      history: { undoStack: [originalDocument], redoStack: [] },
    });
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const workspace = createWorkspace();
    await expect(saveCurrentSession('session-a', { workspace })).resolves.toBe(true);
    expect(read.mock.calls.map(([key]) => key)).toEqual(['current-session']);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toMatchObject({ id: 'current-session', sessionId: 'session-a', workspace });
    expect(put.mock.calls[0][0]).not.toHaveProperty('data');
    expect(put.mock.calls[0][0]).not.toHaveProperty('history');
    expect(put.mock.calls[0][0]).not.toHaveProperty('originalDocument');
    expect((await loadCurrentPDF())?.originalDocument).toEqual(originalDocument);
  });

  it('writes a separate history checkpoint only when supplied', async () => {
    await saveCurrentPDF(data, 'edited.pdf', { sessionId: 'session-a', workspace: createWorkspace() });
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const originalDocument = { data, fileName: 'original.pdf', timestamp: 1, actionName: 'Original' };
    const history = { undoStack: [originalDocument], redoStack: [] };
    await saveCurrentSession('session-a', { originalDocument, history });
    expect(read.mock.calls.map(([key]) => key)).toEqual(['current-session']);
    expect(put.mock.calls.map(([record]) => record.id)).toEqual(['current-session', 'current-history']);
    const reference = { fileName: 'original.pdf', timestamp: 1, actionName: 'Original', pdfRevision: expect.stringMatching(/^pdf-revision:/) };
    expect(put.mock.calls[1][0]).toEqual({ id: 'current-history', version: 2, sessionId: 'session-a',
      originalDocument: reference, history: { undoStack: [reference], redoStack: [] } });
    expect((await loadCurrentPDF())?.history).toEqual(history);
  });

  it('rejects stale saves after a replacement without modifying the replacement', async () => {
    await saveCurrentPDF(data, 'new.pdf', { sessionId: 'new-session', workspace: createWorkspace() });
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await expect(saveCurrentSession('old-session', { workspace: createWorkspace() })).resolves.toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect((await loadCurrentPDF())?.fileName).toBe('new.pdf');
  });

  it('restores the previous all-in-one session format', async () => {
    const session = {
      data, fileName: 'old-format.pdf', sessionId: 'legacy-complete', workspace: createWorkspace(),
      originalDocument: { data, fileName: 'original.pdf', timestamp: 1, actionName: 'Original' },
      history: { undoStack: [], redoStack: [] },
    };
    await writeLegacyRecord(session);
    await expect(loadCurrentPDF()).resolves.toEqual({ ...session, needsMigration: true });
  });
});

describe('immutable PDF revisions and mixed history', () => {
  it('writes large PDF buffers once while each text-edit history checkpoint stays small', async () => {
    const originalBytes = new ArrayBuffer(4 * 1024 * 1024), editedBytes = new ArrayBuffer(3 * 1024 * 1024);
    const originalDocument = { data: originalBytes, fileName: 'large.pdf', actionName: 'Original', timestamp: 1 };
    const documentEntry = { data: editedBytes, fileName: 'large.pdf', actionName: 'Rotate', timestamp: 2, workspace: createWorkspace() };
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveCurrentPDF(originalBytes, 'large.pdf', { sessionId: 'large', originalDocument,
      history: { undoStack: [documentEntry], redoStack: [documentEntry] } });
    expect(put.mock.calls.filter(([record]) => record.data instanceof ArrayBuffer)).toHaveLength(2);
    put.mockClear();
    for (let index = 0; index < 5; index++) {
      const fieldEdit = { kind: 'workspace' as const, actionName: 'Type in form', timestamp: 3 + index,
        patch: { form: { ...createWorkspace().form, isDirty: true } } };
      await saveCurrentSession('large', { originalDocument, workspace: createWorkspace(),
        history: { undoStack: [documentEntry, fieldEdit], redoStack: [] } });
    }
    expect(put.mock.calls.filter(([record]) => record.data instanceof ArrayBuffer)).toEqual([]);
    expect(put.mock.calls.map(([record]) => record.id)).toEqual(Array.from({ length: 5 }, () => ['current-session', 'current-history']).flat());
    for (const [record] of put.mock.calls.filter(([record]) => record.id === 'current-history')) {
      expect(record.originalDocument).not.toHaveProperty('data');
      expect(record.history.undoStack[0]).not.toHaveProperty('data');
      expect(record.history.undoStack[1]).toMatchObject({ kind: 'workspace', patch: { form: { isDirty: true } } });
    }
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const loaded = await loadCurrentPDF();
    expect(read.mock.calls.filter(([key]) => String(key).startsWith('pdf-revision:'))).toHaveLength(2);
    expect(loaded?.originalDocument?.data).toBe(loaded?.data);
    expect(loaded?.history?.undoStack[0]).toEqual(documentEntry);
    // Hydrated buffers are registered too: saving immediately after a reload
    // reuses revision records rather than duplicating the restored history.
    put.mockClear();
    await saveCurrentSession('large', { originalDocument: loaded!.originalDocument, history: loaded!.history });
    expect(put.mock.calls.filter(([record]) => record.data instanceof ArrayBuffer)).toEqual([]);
  });

  it('hydrates shared revision references once across both stacks', async () => {
    const snapshot = { data, fileName: 'same.pdf', actionName: 'Same PDF', timestamp: 1 };
    await saveCurrentPDF(data, 'same.pdf', { sessionId: 'same', originalDocument: snapshot,
      history: { undoStack: [snapshot], redoStack: [snapshot] } });
    const read = vi.spyOn(IDBObjectStore.prototype, 'get');
    const loaded = await loadCurrentPDF();
    const undo = loaded!.history!.undoStack[0], redo = loaded!.history!.redoStack[0];
    expect('data' in undo && undo.data).toBe(loaded?.data);
    expect('data' in redo && redo.data).toBe(loaded?.data);
    expect(read.mock.calls.filter(([key]) => String(key).startsWith('pdf-revision:'))).toHaveLength(1);
  });

  it('does not register aborted revision writes and safely retries the same buffer', async () => {
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'retry', originalDocument: null, history: { undoStack: [], redoStack: [] } });
    const nextBytes = new ArrayBuffer(4096);
    const entry = { data: nextBytes, fileName: 'source.pdf', actionName: 'Change', timestamp: 1 };
    const originalPut = IDBObjectStore.prototype.put;
    const aborted = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
      const request = originalPut.call(this, value, key);
      if (value.data === nextBytes) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(saveCurrentSession('retry', { originalDocument: null, history: { undoStack: [entry], redoStack: [] } })).rejects.toThrow('aborted');
    aborted.mockRestore();
    expect((await loadCurrentPDF())?.history?.undoStack).toEqual([]);
    const retry = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveCurrentSession('retry', { originalDocument: null, history: { undoStack: [entry], redoStack: [] } });
    expect(retry.mock.calls.filter(([record]) => record.data === nextBytes)).toHaveLength(1);
    expect((await loadCurrentPDF())?.history?.undoStack).toEqual([entry]);
  });

  it('collects unreachable revisions on branch truncation, replacement, and close', async () => {
    const oldBytes = new ArrayBuffer(5);
    const entry = { data: oldBytes, fileName: 'source.pdf', actionName: 'Old branch', timestamp: 1 };
    const originalDocument = { data, fileName: 'source.pdf', actionName: 'Original', timestamp: 0 };
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'gc', originalDocument, history: { undoStack: [], redoStack: [entry] } });
    expect((await storedRecords()).filter(record => String(record.id).startsWith('pdf-revision:'))).toHaveLength(2);
    // Partial checkpoint updates preserve the original reference and active PDF.
    await saveCurrentSession('gc', { history: { undoStack: [], redoStack: [] } });
    expect((await storedRecords()).filter(record => String(record.id).startsWith('pdf-revision:'))).toHaveLength(1);
    expect((await loadCurrentPDF())?.originalDocument).toEqual(originalDocument);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveCurrentSession('gc', { history: { undoStack: [entry], redoStack: [] } });
    expect(put.mock.calls.filter(([record]) => record.data === oldBytes)).toHaveLength(1);
    await saveCurrentPDF(new ArrayBuffer(7), 'replacement.pdf', { sessionId: 'replacement', originalDocument: null, history: { undoStack: [], redoStack: [] } });
    expect((await storedRecords()).filter(record => String(record.id).startsWith('pdf-revision:'))).toHaveLength(1);
    await clearCurrentPDF();
    expect(await storedRecords()).toEqual([]);
  });

  it('rolls back revision collection together with an aborted history checkpoint', async () => {
    const previous = new ArrayBuffer(12), entry = { data: previous, fileName: 'source.pdf', actionName: 'Previous', timestamp: 1 };
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'rollback', originalDocument: null, history: { undoStack: [entry], redoStack: [] } });
    const originalDelete = IDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (key) {
      const request = originalDelete.call(this, key);
      if (String(key).startsWith('pdf-revision:')) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(saveCurrentSession('rollback', { originalDocument: null, history: { undoStack: [], redoStack: [] } })).rejects.toThrow('aborted');
    deletion.mockRestore();
    expect((await loadCurrentPDF())?.history?.undoStack).toEqual([entry]);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveCurrentSession('rollback', { originalDocument: null, history: { undoStack: [entry], redoStack: [] } });
    expect(put.mock.calls.filter(([record]) => record.data instanceof ArrayBuffer)).toEqual([]);
  });

  it('deduplicates overlapping queued saves only after the first transaction commits', async () => {
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'queued' });
    const shared = new ArrayBuffer(4096), entry = { data: shared, fileName: 'source.pdf', actionName: 'Change', timestamp: 1 };
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await Promise.all([
      saveCurrentSession('queued', { originalDocument: null, history: { undoStack: [entry], redoStack: [] } }),
      saveCurrentSession('queued', { originalDocument: null, history: { undoStack: [entry], redoStack: [entry] } }),
    ]);
    expect(put.mock.calls.filter(([record]) => record.data === shared)).toHaveLength(1);
    expect((await loadCurrentPDF())?.history?.redoStack).toEqual([entry]);
  });

  it('recreates a cached revision pruned by another tab without leaving dangling references', async () => {
    const previous = new ArrayBuffer(9), entry = { data: previous, fileName: 'source.pdf', actionName: 'Previous', timestamp: 1 };
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'tabs', originalDocument: null, history: { undoStack: [entry], redoStack: [] } });
    const records = await storedRecords();
    const checkpoint = records.find(record => record.id === 'current-history')!;
    const revision = (checkpoint.history as { undoStack: Array<{ pdfRevision: string }> }).undoStack[0].pdfRevision;
    await rawWrite(store => {
      store.put({ ...checkpoint, history: { undoStack: [], redoStack: [] } }); store.delete(revision);
    });
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveCurrentSession('tabs', { originalDocument: null, history: { undoStack: [entry], redoStack: [] } });
    expect(put.mock.calls.filter(([record]) => record.data === previous)).toHaveLength(1);
    expect((await loadCurrentPDF())?.history?.undoStack).toEqual([entry]);
  });

  it('reads the legacy three-record format and migrates it atomically on the next full save', async () => {
    const originalDocument = { data, fileName: 'legacy.pdf', actionName: 'Original', timestamp: 1 };
    const history = { undoStack: [{ ...originalDocument, data: new ArrayBuffer(8), actionName: 'Legacy edit' }], redoStack: [] };
    const workspace = createWorkspace();
    await writeLegacyRecord({ data, fileName: 'legacy.pdf', sessionId: 'legacy-three' });
    await rawWrite(store => {
      store.put({ id: 'current-session', sessionId: 'legacy-three', workspace });
      store.put({ id: 'current-history', sessionId: 'legacy-three', originalDocument, history });
    });
    const loaded = await loadCurrentPDF();
    expect(loaded).toEqual({ data, fileName: 'legacy.pdf', sessionId: 'legacy-three', originalDocument, history, workspace, needsMigration: true });
    await saveCurrentPDF(loaded!.data, loaded!.fileName, loaded!);
    expect((await loadCurrentPDF())?.needsMigration).toBeUndefined();
    const checkpoint = (await storedRecords()).find(record => record.id === 'current-history')!;
    expect(checkpoint).toMatchObject({ version: 2, originalDocument: { pdfRevision: expect.any(String) } });
    expect(checkpoint.originalDocument).not.toHaveProperty('data');
  });

  it('reports a missing revision instead of returning an unusable partial history', async () => {
    await saveCurrentPDF(data, 'source.pdf', { sessionId: 'missing' });
    const revision = (await storedRecords()).find(record => String(record.id).startsWith('pdf-revision:'))!;
    await rawWrite(store => store.delete(revision.id as string));
    await expect(loadCurrentPDF()).rejects.toThrow('revision is missing');
  });
});
