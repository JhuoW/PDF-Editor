// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionPersistence } from '../../src/hooks/useSessionPersistence';
import { useDocumentSessionStore } from '../../src/store/documentSession';
import { useDocumentStore } from '../../src/store/documentStore';
import { useAnnotationStore, createRectangleAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useFormStore } from '../../src/store/formStore';
import { useEditingStore } from '../../src/store/editingStore';
import { useHistoryStore } from '../../src/store/historyStore';

const mocks = vi.hoisted(() => ({ saveCurrentSession: vi.fn() }));
vi.mock('../../src/utils/pdfStorage', () => ({ saveCurrentSession: mocks.saveCurrentSession }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useSessionPersistence>;

function Harness() {
  const result = useSessionPersistence();
  useLayoutEffect(() => { api = result; });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.saveCurrentSession.mockResolvedValue(true);
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useAnnotationStore.setState(useAnnotationStore.getInitialState(), true);
  useAnnotationHistoryStore.setState(useAnnotationHistoryStore.getInitialState(), true);
  useFormStore.setState(useFormStore.getInitialState(), true);
  useEditingStore.setState(useEditingStore.getInitialState(), true);
  useHistoryStore.setState(useHistoryStore.getInitialState(), true);
  useHistoryStore.getState().setOriginalDocument(new ArrayBuffer(100), 'original.pdf');
  useDocumentSessionStore.setState({ active: { sessionId: 'session-a', fileName: 'current.pdf' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function tick() {
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
}

function addAnnotation() {
  const annotation = createRectangleAnnotation(1, [10, 10, 20, 20]);
  useAnnotationStore.getState().addAnnotation(annotation);
  return annotation;
}

describe('editing session autosave', () => {
  it('coalesces rapid edits and excludes unchanged PDF history from the frequent payload', async () => {
    act(() => {
      const annotation = addAnnotation();
      for (let x = 0; x < 100; x++) useAnnotationStore.getState().updateAnnotation(annotation.id, { rect: [x, 10, 20, 20] });
    });
    expect(mocks.saveCurrentSession).not.toHaveBeenCalled();
    await tick();
    expect(mocks.saveCurrentSession).toHaveBeenCalledOnce();
    const [sessionId, snapshot] = mocks.saveCurrentSession.mock.calls[0];
    expect(sessionId).toBe('session-a');
    expect(snapshot.workspace.annotations.get(1)[0].rect[0]).toBe(99);
    expect(snapshot).not.toHaveProperty('data');
    expect(snapshot).not.toHaveProperty('history');
    expect(snapshot).not.toHaveProperty('originalDocument');
    expect(api.status).toBe('saved');
  });

  it('checkpoints changed history once and keeps subsequent annotation saves small', async () => {
    act(() => useHistoryStore.getState().pushState(new ArrayBuffer(3), 'current.pdf', 'Rotate'));
    await tick();
    expect(mocks.saveCurrentSession.mock.calls[0][1].history.undoStack).toHaveLength(1);
    expect(mocks.saveCurrentSession.mock.calls[0][1].originalDocument.fileName).toBe('original.pdf');
    act(() => { addAnnotation(); });
    await tick();
    expect(mocks.saveCurrentSession.mock.calls[1][1]).not.toHaveProperty('history');
    expect(mocks.saveCurrentSession.mock.calls[1][1]).not.toHaveProperty('originalDocument');
  });

  it('does not persist intermediate state while a document operation is loading', async () => {
    act(() => {
      useDocumentStore.getState().setLoading(true);
      addAnnotation();
    });
    await tick();
    expect(mocks.saveCurrentSession).not.toHaveBeenCalled();
    act(() => useDocumentStore.getState().setLoading(false));
    await tick();
    expect(mocks.saveCurrentSession).toHaveBeenCalledOnce();
    expect(mocks.saveCurrentSession.mock.calls[0][1].workspace.annotations.size).toBe(1);
  });

  it('serializes writes and saves changes made during an in-flight write', async () => {
    const firstSave = deferred<boolean>();
    mocks.saveCurrentSession.mockReturnValueOnce(firstSave.promise);
    act(() => { addAnnotation(); });
    await tick();
    act(() => { addAnnotation(); });
    await tick();
    expect(mocks.saveCurrentSession).toHaveBeenCalledOnce();
    await act(async () => { firstSave.resolve(true); await api.flush(); });
    expect(mocks.saveCurrentSession.mock.calls[1][1].workspace.annotations.get(1)).toHaveLength(2);
    expect(api.status).toBe('saved');
  });

  it('drops a pending save when the document is closed', async () => {
    act(() => { addAnnotation(); });
    act(() => useDocumentSessionStore.setState({ active: null }));
    await tick();
    expect(mocks.saveCurrentSession).not.toHaveBeenCalled();
    expect(api.status).toBe('idle');
  });

  it('does not let an old failed save change the status of a newly opened session', async () => {
    const firstSave = deferred<boolean>();
    mocks.saveCurrentSession.mockReturnValueOnce(firstSave.promise);
    act(() => { addAnnotation(); });
    await tick();
    act(() => {
      useAnnotationStore.getState().clearAnnotations();
      useDocumentSessionStore.setState({ active: { sessionId: 'session-b', fileName: 'new.pdf' } });
      addAnnotation();
    });
    await tick();
    await act(async () => { firstSave.resolve(false); await api.flush(); });
    expect(mocks.saveCurrentSession.mock.calls[1][0]).toBe('session-b');
    expect(api.status).toBe('saved');
    expect(api.error).toBeNull();
  });

  it('reports write failures while retaining edits and supports an explicit retry', async () => {
    mocks.saveCurrentSession.mockRejectedValueOnce(new Error('Storage quota exceeded'));
    act(() => { addAnnotation(); });
    await tick();
    expect(api.status).toBe('error');
    expect(api.error).toBe('Storage quota exceeded');
    expect(useAnnotationStore.getState().getAllAnnotations()).toHaveLength(1);
    await act(async () => { await api.flush(); });
    expect(api.status).toBe('saved');
    expect(api.error).toBeNull();
  });

  it('saves form values, content edits, and navigation together', async () => {
    act(() => {
      useFormStore.getState().setFields([{
        id: 'field', name: 'Name', type: 'text', value: 'Original', pageNumber: 1,
        rect: { x: 10, y: 10, width: 20, height: 20 }, required: false, readOnly: false, hidden: false,
      }]);
      useFormStore.getState().setFieldValue('field', 'Edited');
      useEditingStore.getState().addRedaction({ pageNumber: 1, rect: { x: 20, y: 20, width: 10, height: 10 }, overlayColor: '#000000' });
      useDocumentStore.getState().setCurrentPage(2);
    });
    await tick();
    const state = mocks.saveCurrentSession.mock.calls[0][1];
    expect(state.workspace.form.fields[0].value).toBe('Edited');
    expect(state.workspace.form.originalValues.get('field')).toBe('Original');
    expect(state.workspace.editing.redactions).toHaveLength(1);
    expect(state.navigation.currentPage).toBe(2);
  });
});
