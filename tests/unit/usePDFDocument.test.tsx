// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePDFDocument } from '../../src/hooks/usePDFDocument';
import { useDocumentStore } from '../../src/store/documentStore';
import { useAnnotationStore, createRectangleAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useEditingStore } from '../../src/store/editingStore';
import { useFormStore } from '../../src/store/formStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { useSearchStore } from '../../src/store/searchStore';
import { useTextBoxStore } from '../../src/store/textBoxStore';
import { captureWorkspace, createWorkspace } from '../../src/store/workspaceSnapshot';
import { useDocumentSessionStore } from '../../src/store/documentSession';
import { CURRENT_TAB_SESSION_KEY } from '../../src/utils/documentRecovery';
import { clearDocumentSaveState } from '../../src/store/documentSaveStore';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  saveCurrentPDF: vi.fn(),
  loadCurrentPDF: vi.fn(),
  clearCurrentPDF: vi.fn(),
  extractFormFields: vi.fn(),
  importEditableAnnotations: vi.fn(),
  decryptPDF: vi.fn(),
}));

vi.mock('../../src/utils/pdfConfig', () => ({
  pdfjsLib: { getDocument: mocks.getDocument, PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 } },
  pdfDocumentOptions: {},
}));
vi.mock('../../src/utils/pdfStorage', () => ({
  saveCurrentPDF: mocks.saveCurrentPDF,
  loadCurrentPDF: mocks.loadCurrentPDF,
  clearCurrentPDF: mocks.clearCurrentPDF,
}));

vi.mock('../../src/forms/FormFieldExtractor', () => ({ extractFormFields: mocks.extractFormFields }));
vi.mock('../../src/annotations/AnnotationImporter', () => ({ importEditableAnnotations: mocks.importEditableAnnotations }));
vi.mock('../../src/core/PDFEncryption', () => ({ decryptPDF: mocks.decryptPDF }));

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const buffer = (value: number): ArrayBuffer => new Uint8Array([value]).buffer;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pdfDocument(numPages = 3) {
  const destroy = vi.fn().mockResolvedValue(undefined);
  return {
    numPages, destroy, getData: vi.fn().mockResolvedValue(new Uint8Array([1])), getPermissions: vi.fn().mockResolvedValue(null),
  } as unknown as PDFDocumentProxy;
}

function loadingTask(promise: Promise<PDFDocumentProxy>) {
  return { promise, destroy: vi.fn().mockResolvedValue(undefined),
    onPassword: undefined as undefined | ((updatePassword: (password: string) => void, reason: number) => void) };
}

function pdfFile(name: string, data: ArrayBuffer) {
  const file = new File([data], name, { type: 'application/pdf' });
  // jsdom's File does not implement Blob.arrayBuffer().
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(data) });
  return file;
}

let root: Root | null;
let container: HTMLDivElement;
let api: ReturnType<typeof usePDFDocument>;
const originalNavigationGetter = Object.getOwnPropertyDescriptor(performance, 'getEntriesByType');
function navigation(type: 'navigate' | 'reload' | 'back_forward', sessionId?: string) {
  Object.defineProperty(performance, 'getEntriesByType', { configurable: true, value: vi.fn(() => [{ type }]) });
  if (sessionId) sessionStorage.setItem(CURRENT_TAB_SESSION_KEY, sessionId);
}

function Harness() {
  const result = usePDFDocument();
  useLayoutEffect(() => { api = result; });
  return null;
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
}

function seedCurrentDocument() {
  const oldDocument = pdfDocument();
  const annotation = createRectangleAnnotation(1, [10, 10, 20, 20]);
  useDocumentStore.getState().setDocument(oldDocument);
  useDocumentStore.getState().setCurrentPage(3);
  useDocumentStore.getState().setZoom(2);
  useDocumentStore.getState().setRotation(90);
  useAnnotationStore.getState().addAnnotation(annotation);
  useAnnotationStore.getState().enterCropMode(annotation.id);
  useAnnotationHistoryStore.getState().recordAdd(annotation);
  useHistoryStore.getState().setOriginalDocument(buffer(1), 'old.pdf');
  useHistoryStore.getState().pushState(buffer(1), 'old.pdf', 'Rotate page');
  useEditingStore.getState().setMode('redact');
  useEditingStore.getState().addRedaction({
    pageNumber: 1, rect: { x: 10, y: 10, width: 20, height: 20 }, overlayColor: '#000000',
  });
  useFormStore.getState().setFields([{
    id: 'name', name: 'name', type: 'text', value: 'unsaved value', pageNumber: 1,
    rect: { x: 10, y: 10, width: 20, height: 20 }, required: false, readOnly: false, hidden: false,
  }]);
  useSearchStore.getState().setQuery('old text');
  useTextBoxStore.getState().startEditing(annotation.id);
  return { oldDocument, annotation };
}

beforeEach(() => {
  root = null;
  vi.resetAllMocks();
  sessionStorage.clear(); navigation('navigate'); clearDocumentSaveState();
  mocks.loadCurrentPDF.mockResolvedValue(null);
  mocks.saveCurrentPDF.mockResolvedValue(undefined);
  mocks.clearCurrentPDF.mockResolvedValue(undefined);
  mocks.extractFormFields.mockResolvedValue([]);
  mocks.importEditableAnnotations.mockImplementation(async (data: ArrayBuffer) => ({ data, annotations: new Map() }));
  mocks.decryptPDF.mockImplementation(async (data: ArrayBuffer) => ({ data, authentication: 'user', permissions: {} }));
  useDocumentSessionStore.setState({ active: null });
  useDocumentStore.setState(useDocumentStore.getInitialState(), true);
  useAnnotationStore.setState(useAnnotationStore.getInitialState(), true);
  useAnnotationHistoryStore.setState(useAnnotationHistoryStore.getInitialState(), true);
  useEditingStore.setState(useEditingStore.getInitialState(), true);
  useFormStore.setState(useFormStore.getInitialState(), true);
  useHistoryStore.setState(useHistoryStore.getInitialState(), true);
  useSearchStore.setState(useSearchStore.getInitialState(), true);
  useTextBoxStore.setState(useTextBoxStore.getInitialState(), true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  if (originalNavigationGetter) Object.defineProperty(performance, 'getEntriesByType', originalNavigationGetter);
  else Reflect.deleteProperty(performance, 'getEntriesByType');
});

describe('PDF document sessions', () => {
  it.each(['navigate', 'back_forward'] as const)('starts empty on %s without reading or deleting another tab’s cache', async type => {
    navigation(type, 'previous-session');
    mocks.loadCurrentPDF.mockResolvedValue({ data: buffer(1), fileName: 'cached.pdf', sessionId: 'previous-session' });
    await mount();
    expect(api.document).toBeNull(); expect(mocks.loadCurrentPDF).not.toHaveBeenCalled();
    expect(mocks.clearCurrentPDF).not.toHaveBeenCalled(); expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CURRENT_TAB_SESSION_KEY)).toBeNull();
  });

  it.each([undefined, 'another-tab'])('does not recover a refresh without matching ownership (%s)', async owned => {
    navigation('reload', owned);
    mocks.loadCurrentPDF.mockResolvedValue({ data: buffer(1), fileName: 'cached.pdf', sessionId: 'cached-session' });
    await mount();
    expect(api.document).toBeNull(); expect(mocks.getDocument).not.toHaveBeenCalled(); expect(mocks.clearCurrentPDF).not.toHaveBeenCalled();
  });
  it('stores editable native notes separately while retaining the untouched original for Reset', async () => {
    const source = pdfDocument(1);
    const normalized = pdfDocument(1);
    const annotation = createRectangleAnnotation(1, [10, 20, 30, 40]);
    mocks.importEditableAnnotations.mockResolvedValue({ data: buffer(9), annotations: new Map([[1, [annotation]]]) });
    mocks.getDocument.mockReturnValueOnce(loadingTask(Promise.resolve(source)))
      .mockReturnValueOnce(loadingTask(Promise.resolve(normalized)));
    await mount();
    await act(async () => { expect(await api.loadDocument(buffer(1), { fileName: 'notes.pdf' })).toBe(true); });
    expect(source.destroy).toHaveBeenCalledOnce();
    expect(api.document).toBe(normalized);
    expect(useHistoryStore.getState().getOriginalDocument()?.data).toEqual(buffer(1));
    expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([annotation]);
    expect(mocks.saveCurrentPDF).toHaveBeenCalledWith(buffer(9), 'notes.pdf', expect.objectContaining({
      workspace: expect.objectContaining({ annotations: new Map([[1, [annotation]]]) }),
      originalDocument: expect.objectContaining({ data: buffer(1) }),
    }));
  });

  it('opens a new file and clears all edits belonging to the previous document', async () => {
    const { oldDocument } = seedCurrentDocument();
    const nextDocument = pdfDocument(2);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(nextDocument)));
    await mount();

    await act(async () => {
      expect(await api.loadFromFile(pdfFile('new.pdf', buffer(2)))).toBe(true);
    });

    expect(api.document).toBe(nextDocument);
    expect(mocks.saveCurrentPDF).toHaveBeenCalledWith(buffer(2), 'new.pdf', expect.objectContaining({ sessionId: expect.any(String) }));
    expect(useHistoryStore.getState().getOriginalDocument()).toMatchObject({
      data: buffer(2), fileName: 'new.pdf',
    });
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([]);
    expect(useAnnotationStore.getState().cropModeAnnotationId).toBeNull();
    expect(useAnnotationHistoryStore.getState().canUndo()).toBe(false);
    expect(useEditingStore.getState().redactions).toEqual([]);
    expect(useEditingStore.getState().mode).toBe('none');
    expect(useFormStore.getState().fields).toEqual([]);
    expect(useSearchStore.getState().query).toBe('');
    expect(useTextBoxStore.getState().editingTextBoxId).toBeNull();
    expect(api.navigation).toMatchObject({ currentPage: 1, zoomMode: 'fit-page', rotation: 0 });
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
  });

  it('preserves edits, the original file, history, and navigation on an internal reload', async () => {
    const { annotation } = seedCurrentDocument();
    const nextDocument = pdfDocument(2);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(nextDocument)));
    await mount();

    await act(async () => {
      expect(await api.loadFromFile(pdfFile('modified.pdf', buffer(2)), { preserveState: true })).toBe(true);
    });

    expect(api.document).toBe(nextDocument);
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(mocks.importEditableAnnotations).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().canUndo()).toBe(true);
    expect(useHistoryStore.getState().getOriginalDocument()).toMatchObject({
      data: buffer(1), fileName: 'old.pdf',
    });
    expect(useHistoryStore.getState().getUndoActionName()).toBe('Add removal area');
    expect(useEditingStore.getState().redactions).toHaveLength(1);
    expect(useFormStore.getState().fields[0].value).toBe('unsaved value');
    expect(useSearchStore.getState().query).toBe('old text');
    expect(useTextBoxStore.getState().editingTextBoxId).toBeNull();
    expect(api.navigation).toMatchObject({
      currentPage: 2, totalPages: 2, zoom: 2, zoomMode: 'manual', rotation: 90,
    });
  });

  it('keeps the current document and edits when parsing another file fails', async () => {
    const { oldDocument, annotation } = seedCurrentDocument();
    const pending = deferred<PDFDocumentProxy>();
    const task = loadingTask(pending.promise);
    mocks.getDocument.mockReturnValue(task);
    await mount();

    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadFromFile(pdfFile('broken.pdf', buffer(9))); });
    await act(async () => {
      pending.reject(new Error('Invalid PDF'));
      expect(await opening).toBe(false);
    });

    expect(api.document).toBe(oldDocument);
    expect(api.error).toBe('Invalid PDF');
    expect(api.isLoading).toBe(false);
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(useHistoryStore.getState().getOriginalDocument()?.fileName).toBe('old.pdf');
    expect(useHistoryStore.getState().canUndo()).toBe(true);
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
    expect(oldDocument.destroy).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the current session when saving the new file to storage fails', async () => {
    const { oldDocument, annotation } = seedCurrentDocument();
    const task = loadingTask(Promise.resolve(pdfDocument()));
    mocks.getDocument.mockReturnValue(task);
    mocks.saveCurrentPDF.mockRejectedValue(new Error('Storage quota exceeded'));
    await mount();

    await act(async () => {
      expect(await api.loadDocument(buffer(2), { fileName: 'new.pdf' })).toBe(false);
    });

    expect(api.document).toBe(oldDocument);
    expect(api.error).toBe('Storage quota exceeded');
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(oldDocument.destroy).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('prevents a slower earlier parse from replacing the latest opened file', async () => {
    const earlier = deferred<PDFDocumentProxy>();
    const later = deferred<PDFDocumentProxy>();
    const earlierDocument = pdfDocument();
    const laterDocument = pdfDocument();
    mocks.getDocument.mockReturnValueOnce(loadingTask(earlier.promise))
      .mockReturnValueOnce(loadingTask(later.promise));
    await mount();

    let firstOpen!: Promise<boolean>;
    let secondOpen!: Promise<boolean>;
    await act(async () => {
      firstOpen = api.loadDocument(buffer(1), { fileName: 'earlier.pdf' });
    });
    await act(async () => {
      secondOpen = api.loadDocument(buffer(2), { fileName: 'later.pdf' });
    });
    await act(async () => {
      later.resolve(laterDocument);
      expect(await secondOpen).toBe(true);
    });
    await act(async () => {
      earlier.resolve(earlierDocument);
      expect(await firstOpen).toBe(false);
    });

    expect(api.document).toBe(laterDocument);
    expect(api.error).toBeNull();
    expect(api.isLoading).toBe(false);
    expect(useHistoryStore.getState().getOriginalDocument()?.fileName).toBe('later.pdf');
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(2), 'later.pdf', expect.objectContaining({ sessionId: expect.any(String) }));
    expect(earlierDocument.destroy).toHaveBeenCalledOnce();
    expect(laterDocument.destroy).not.toHaveBeenCalled();
  });

  it('keeps the committed PDF visible and cached when a newer open fails during its save', async () => {
    const { oldDocument } = seedCurrentDocument();
    const firstDocument = pdfDocument();
    const firstSave = deferred<void>();
    const secondParse = deferred<PDFDocumentProxy>();
    let persisted = { data: buffer(1), fileName: 'old.pdf' };
    mocks.getDocument.mockReturnValueOnce(loadingTask(Promise.resolve(firstDocument)))
      .mockReturnValueOnce(loadingTask(secondParse.promise));
    mocks.saveCurrentPDF.mockImplementation(async (data: ArrayBuffer, fileName: string) => {
      await firstSave.promise;
      persisted = { data: data.slice(0), fileName };
    });
    await mount();

    let firstOpen!: Promise<boolean>;
    let secondOpen!: Promise<boolean>;
    await act(async () => {
      firstOpen = api.loadDocument(buffer(2), { fileName: 'first.pdf' });
    });
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(2), 'first.pdf', expect.objectContaining({ sessionId: expect.any(String) }));
    await act(async () => {
      secondOpen = api.loadDocument(buffer(3), { fileName: 'broken.pdf' });
    });
    expect(mocks.getDocument).toHaveBeenCalledOnce();
    expect(api.document).toBe(oldDocument);
    expect(persisted).toEqual({ data: buffer(1), fileName: 'old.pdf' });

    await act(async () => {
      firstSave.resolve(undefined);
      expect(await firstOpen).toBe(true);
    });
    expect(mocks.getDocument).toHaveBeenCalledTimes(2);
    expect(api.document).toBe(firstDocument);
    expect(persisted).toEqual({ data: buffer(2), fileName: 'first.pdf' });
    expect(api.isLoading).toBe(true);

    await act(async () => {
      secondParse.reject(new Error('Invalid newer PDF'));
      expect(await secondOpen).toBe(false);
    });
    expect(api.document).toBe(firstDocument);
    expect(persisted).toEqual({ data: buffer(2), fileName: 'first.pdf' });
    expect(useHistoryStore.getState().getOriginalDocument()).toMatchObject(persisted);
    expect(api.error).toBe('Invalid newer PDF');
    expect(api.isLoading).toBe(false);
    expect(mocks.saveCurrentPDF).toHaveBeenCalledOnce();
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
    expect(firstDocument.destroy).not.toHaveBeenCalled();
  });

  it('continues opening the next file after an earlier save rejects', async () => {
    const { oldDocument } = seedCurrentDocument();
    const firstTask = loadingTask(Promise.resolve(pdfDocument()));
    const secondDocument = pdfDocument();
    const firstSave = deferred<void>();
    let persisted = { data: buffer(1), fileName: 'old.pdf' };
    mocks.getDocument.mockReturnValueOnce(firstTask)
      .mockReturnValueOnce(loadingTask(Promise.resolve(secondDocument)));
    mocks.saveCurrentPDF.mockImplementation(async (data: ArrayBuffer, fileName: string) => {
      if (fileName === 'first.pdf') await firstSave.promise;
      persisted = { data: data.slice(0), fileName };
    });
    await mount();

    let firstOpen!: Promise<boolean>;
    let secondOpen!: Promise<boolean>;
    await act(async () => {
      firstOpen = api.loadDocument(buffer(2), { fileName: 'first.pdf' });
    });
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(2), 'first.pdf', expect.objectContaining({ sessionId: expect.any(String) }));
    await act(async () => {
      secondOpen = api.loadDocument(buffer(3), { fileName: 'second.pdf' });
    });
    expect(mocks.getDocument).toHaveBeenCalledOnce();

    await act(async () => {
      firstSave.reject(new Error('Storage write failed'));
      expect(await firstOpen).toBe(false);
      expect(await secondOpen).toBe(true);
    });

    expect(api.document).toBe(secondDocument);
    expect(persisted).toEqual({ data: buffer(3), fileName: 'second.pdf' });
    expect(useHistoryStore.getState().getOriginalDocument()).toMatchObject(persisted);
    expect(api.error).toBeNull();
    expect(api.isLoading).toBe(false);
    expect(mocks.saveCurrentPDF).toHaveBeenCalledTimes(2);
    expect(firstTask.destroy).toHaveBeenCalledOnce();
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
    expect(secondDocument.destroy).not.toHaveBeenCalled();
  });

  it('ignores a cached file returned after the user explicitly opens a file', async () => {
    navigation('reload', 'cached-session');
    const cached = deferred<{ data: ArrayBuffer; fileName: string; sessionId: string } | null>();
    mocks.loadCurrentPDF.mockReturnValue(cached.promise);
    const openedDocument = pdfDocument();
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(openedDocument)));
    await mount();

    await act(async () => {
      expect(await api.loadFromFile(pdfFile('chosen.pdf', buffer(2)))).toBe(true);
    });
    await act(async () => { cached.resolve({ data: buffer(1), fileName: 'cached.pdf', sessionId: 'cached-session' }); });

    expect(api.document).toBe(openedDocument);
    expect(mocks.getDocument).toHaveBeenCalledOnce();
    expect(useHistoryStore.getState().getOriginalDocument()?.fileName).toBe('chosen.pdf');
  });

  it('ignores an already parsing cached document when the user opens another file', async () => {
    navigation('reload', 'cached-session');
    mocks.loadCurrentPDF.mockResolvedValue({ data: buffer(1), fileName: 'cached.pdf', sessionId: 'cached-session' });
    const cachedParse = deferred<PDFDocumentProxy>();
    const cachedDocument = pdfDocument();
    const openedDocument = pdfDocument();
    mocks.getDocument.mockReturnValueOnce(loadingTask(cachedParse.promise))
      .mockReturnValueOnce(loadingTask(Promise.resolve(openedDocument)));
    await mount();

    await act(async () => {
      expect(await api.loadFromFile(pdfFile('chosen.pdf', buffer(2)))).toBe(true);
    });
    await act(async () => { cachedParse.resolve(cachedDocument); });

    expect(api.document).toBe(openedDocument);
    expect(cachedDocument.destroy).toHaveBeenCalledOnce();
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(2), 'chosen.pdf', expect.objectContaining({ sessionId: expect.any(String) }));
    expect(useHistoryStore.getState().getOriginalDocument()?.fileName).toBe('chosen.pdf');
  });

  it('leaves an unowned legacy cached PDF untouched instead of opening it on a new visit', async () => {
    mocks.loadCurrentPDF.mockResolvedValue({ data: buffer(1), fileName: 'cached.pdf' });
    const cachedDocument = pdfDocument();
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(cachedDocument)));
    await mount();

    expect(api.document).toBeNull();
    expect(mocks.loadCurrentPDF).not.toHaveBeenCalled(); expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
  });

  it('restores edits, form baselines, history, original bytes, and navigation after a refresh', async () => {
    navigation('reload', 'persisted-session');
    const { annotation } = seedCurrentDocument();
    useFormStore.getState().setFieldValue('name', 'edited form value');
    const workspace = captureWorkspace();
    const originalDocument = useHistoryStore.getState().originalDocument;
    const snapshot = {
      data: buffer(2), fileName: 'edited.pdf', sessionId: 'persisted-session', workspace, originalDocument,
      history: { undoStack: [{ ...originalDocument!, workspace }], redoStack: [] },
      navigation: { ...useDocumentStore.getState().navigation },
    };
    useAnnotationStore.getState().clearAnnotations();
    useFormStore.getState().clearForm();
    useHistoryStore.getState().clearHistory();
    useEditingStore.getState().clearAll();
    // A browser refresh creates a fresh store before restoring persisted state.
    useDocumentStore.setState(useDocumentStore.getInitialState(), true);
    mocks.loadCurrentPDF.mockResolvedValue(snapshot);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())));
    await mount();

    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(useHistoryStore.getState().canUndo()).toBe(true);
    expect(useFormStore.getState().fields[0].value).toBe('edited form value');
    expect(useFormStore.getState().originalValues.get('name')).toBe('unsaved value');
    expect(useFormStore.getState().isDirty).toBe(true);
    expect(useEditingStore.getState().redactions).toHaveLength(1);
    expect(useHistoryStore.getState().originalDocument?.data).toEqual(buffer(1));
    expect(useHistoryStore.getState().undoStack[0].workspace).toEqual(workspace);
    expect(api.navigation).toMatchObject({ currentPage: 3, zoom: 2, rotation: 90 });
    expect(mocks.extractFormFields).not.toHaveBeenCalled();
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
    expect(useDocumentSessionStore.getState().active?.sessionId).toBe('persisted-session');
  });

  it('keeps live edits when the editor remounts after a view failure on a reloaded page', async () => {
    navigation('reload', 'persisted-session');
    const { oldDocument, annotation } = seedCurrentDocument();
    useFormStore.getState().setFieldValue('name', 'new unsaved value');
    mocks.loadCurrentPDF.mockResolvedValue({ data: buffer(9), fileName: 'stale.pdf', sessionId: 'persisted-session' });
    const liveWorkspace = captureWorkspace();
    const liveHistory = useHistoryStore.getState().undoStack;

    await mount();
    await act(async () => root!.unmount());
    container.remove();
    await mount();

    expect(api.document).toBe(oldDocument);
    expect(captureWorkspace()).toEqual(liveWorkspace);
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(useHistoryStore.getState().undoStack).toEqual(liveHistory);
    expect(mocks.loadCurrentPDF).not.toHaveBeenCalled();
    expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(oldDocument.destroy).not.toHaveBeenCalled();
  });

  it('persists and publishes the supplied remapped workspace during internal reloads', async () => {
    seedCurrentDocument();
    const workspace = createWorkspace();
    const annotation = createRectangleAnnotation(2, [10, 10, 20, 20]);
    workspace.annotations.set(2, [annotation]);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())));
    await mount();
    await act(async () => {
      expect(await api.loadDocument(buffer(2), { fileName: 'edited.pdf', preserveState: true, workspace })).toBe(true);
    });
    expect(mocks.saveCurrentPDF).toHaveBeenCalledWith(buffer(2), 'edited.pdf', expect.objectContaining({ workspace }));
    expect(useAnnotationStore.getState().getAllAnnotations()).toEqual([annotation]);
    expect(useFormStore.getState().fields).toEqual([]);
    expect(mocks.extractFormFields).not.toHaveBeenCalled();
  });

  it.each([true, false])('commits a document operation and its proposed timeline together (storage succeeds=%s)', async succeeds => {
    const { oldDocument } = seedCurrentDocument();
    const oldHistory = useHistoryStore.getState().undoStack;
    const candidate = { undoStack: [...oldHistory, { data: buffer(1), fileName: 'old.pdf', actionName: 'Atomic rotation', timestamp: 1, workspace: captureWorkspace() }], redoStack: [] };
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())));
    mocks.saveCurrentPDF.mockImplementation(async (_data, _name, saved) => {
      expect(saved.history).toEqual(candidate);
      expect(useHistoryStore.getState().undoStack).toBe(oldHistory);
      expect(useDocumentStore.getState().document).toBe(oldDocument);
      if (!succeeds) throw new Error('Storage failed');
    });
    await mount();
    await act(async () => {
      expect(await api.loadDocument(buffer(2), { preserveState: true, fileName: 'old.pdf', workspace: captureWorkspace(), history: candidate })).toBe(succeeds);
    });
    expect(useHistoryStore.getState().undoStack).toEqual(succeeds ? candidate.undoStack : oldHistory);
    if (!succeeds) expect(useDocumentStore.getState().document).toBe(oldDocument);
  });

  it('extracts new form fields before publishing and stores their original values', async () => {
    seedCurrentDocument();
    const fields = useFormStore.getState().fields;
    mocks.extractFormFields.mockResolvedValue(fields);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())));
    await mount();
    await act(async () => { await api.loadDocument(buffer(2), { fileName: 'form.pdf' }); });
    expect(useFormStore.getState().fields).toEqual(fields);
    expect(mocks.saveCurrentPDF).toHaveBeenCalledWith(buffer(2), 'form.pdf', expect.objectContaining({
      workspace: expect.objectContaining({ form: { fields, originalValues: new Map([['name', 'unsaved value']]), isDirty: false } }),
    }));
  });

  it('cancels an unfinished open when the document is closed', async () => {
    const { oldDocument } = seedCurrentDocument();
    const pending = deferred<PDFDocumentProxy>();
    const parsedDocument = pdfDocument();
    mocks.getDocument.mockReturnValue(loadingTask(pending.promise));
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(2)); });
    await act(async () => { expect(await api.closeDocument()).toBe(true); });
    await act(async () => {
      pending.resolve(parsedDocument);
      expect(await opening).toBe(false);
    });
    expect(api.document).toBeNull();
    expect(useDocumentSessionStore.getState().active).toBeNull();
    expect(mocks.clearCurrentPDF).toHaveBeenCalledOnce();
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
    expect(parsedDocument.destroy).toHaveBeenCalledOnce();
  });

  it('deletes storage only after an already-started open commit finishes', async () => {
    seedCurrentDocument();
    const pendingSave = deferred<void>();
    mocks.saveCurrentPDF.mockReturnValue(pendingSave.promise);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(pdfDocument())));
    await mount();
    let opening!: Promise<boolean>;
    let closing!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(2)); });
    await act(async () => { closing = api.closeDocument(); });
    expect(mocks.clearCurrentPDF).not.toHaveBeenCalled();
    await act(async () => {
      pendingSave.resolve(undefined);
      expect(await opening).toBe(true);
      expect(await closing).toBe(true);
    });
    expect(mocks.clearCurrentPDF).toHaveBeenCalledOnce();
    expect(api.document).toBeNull();
    expect(api.isLoading).toBe(false);
    expect(useDocumentSessionStore.getState().active).toBeNull();
  });
});

describe('password-protected PDF loading', () => {
  it('retries an incorrect password, decrypts before importing edits, and retains only encrypted original bytes', async () => {
    const { oldDocument, annotation } = seedCurrentDocument();
    const parsed = deferred<PDFDocumentProxy>();
    const task = loadingTask(parsed.promise);
    const encryptedDocument = pdfDocument(2);
    vi.mocked(encryptedDocument.getPermissions).mockResolvedValue([4]);
    const unlockedDocument = pdfDocument(2);
    mocks.getDocument.mockReturnValueOnce(task)
      .mockReturnValueOnce(loadingTask(Promise.resolve(unlockedDocument)));
    mocks.decryptPDF.mockResolvedValue({ data: buffer(8), permissions: { print: true }, authentication: 'user' });
    const password = '中文,"private"\\=😀';
    const updatePassword = vi.fn((value: string) => {
      if (value === password) parsed.resolve(encryptedDocument);
      else task.onPassword!(updatePassword, 2);
    });
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7), { fileName: 'locked.pdf' }); });
    await act(async () => task.onPassword!(updatePassword, 1));
    expect(api.passwordRequest).toMatchObject({ fileName: 'locked.pdf', reason: 'required' });
    expect(api.document).toBe(oldDocument);
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);

    const firstId = api.passwordRequest!.id;
    await act(async () => api.submitPassword('wrong'));
    expect(api.passwordRequest).toMatchObject({ reason: 'incorrect' });
    expect(api.passwordRequest!.id).not.toBe(firstId);
    expect(api.error).toBeNull();
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
    await act(async () => { api.submitPassword(password); expect(await opening).toBe(true); });

    expect(api.document).toBe(unlockedDocument);
    expect(api.passwordRequest).toBeNull();
    expect(api.isLoading).toBe(false);
    expect(mocks.decryptPDF).toHaveBeenCalledExactlyOnceWith(buffer(7), password);
    expect(mocks.importEditableAnnotations).toHaveBeenCalledExactlyOnceWith(buffer(8));
    expect(mocks.extractFormFields).toHaveBeenCalledExactlyOnceWith(buffer(8));
    expect(mocks.saveCurrentPDF).toHaveBeenCalledWith(buffer(8), 'locked.pdf', expect.objectContaining({
      originalDocument: expect.objectContaining({ data: buffer(7) }),
    }));
    expect(JSON.stringify(mocks.saveCurrentPDF.mock.calls)).not.toContain(password);
    expect(encryptedDocument.destroy).toHaveBeenCalledOnce();
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
    expect(unlockedDocument.destroy).not.toHaveBeenCalled();
  });

  it('also decrypts owner-protected documents with an empty user password', async () => {
    const encryptedDocument = pdfDocument();
    vi.mocked(encryptedDocument.getPermissions).mockResolvedValue([]);
    const workingDocument = pdfDocument();
    mocks.getDocument.mockReturnValueOnce(loadingTask(Promise.resolve(encryptedDocument)))
      .mockReturnValueOnce(loadingTask(Promise.resolve(workingDocument)));
    mocks.decryptPDF.mockResolvedValue({ data: buffer(9), permissions: {}, authentication: 'user' });
    await mount();
    await act(async () => expect(await api.loadDocument(buffer(7))).toBe(true));
    expect(api.passwordRequest).toBeNull();
    expect(mocks.decryptPDF).toHaveBeenCalledExactlyOnceWith(buffer(7), '');
    expect(useHistoryStore.getState().getOriginalDocument()?.data).toEqual(buffer(7));
    expect(api.document).toBe(workingDocument);
  });

  it('settles cancellation even if a password-waiting PDF.js promise never rejects', async () => {
    const { oldDocument, annotation } = seedCurrentDocument();
    const pending = deferred<PDFDocumentProxy>();
    const task = loadingTask(pending.promise);
    mocks.getDocument.mockReturnValue(task);
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7)); });
    await act(async () => task.onPassword!(vi.fn(), 1));
    await act(async () => { api.cancelPasswordRequest(); expect(await opening).toBe(false); });
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(api.passwordRequest).toBeNull();
    expect(api.document).toBe(oldDocument);
    expect(api.error).toBeNull();
    expect(api.isLoading).toBe(false);
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
    expect(mocks.clearCurrentPDF).not.toHaveBeenCalled();
    expect(oldDocument.destroy).not.toHaveBeenCalled();
  });

  it('cancels a pending password request when another file opens and ignores late prompts', async () => {
    const pending = deferred<PDFDocumentProxy>();
    const task = loadingTask(pending.promise);
    const newerDocument = pdfDocument();
    mocks.getDocument.mockReturnValueOnce(task).mockReturnValueOnce(loadingTask(Promise.resolve(newerDocument)));
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7), { fileName: 'locked.pdf' }); });
    await act(async () => task.onPassword!(vi.fn(), 1));
    await act(async () => {
      expect(await api.loadDocument(buffer(8), { fileName: 'chosen.pdf' })).toBe(true);
      expect(await opening).toBe(false);
    });
    await act(async () => task.onPassword!(vi.fn(), 2));
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(api.passwordRequest).toBeNull();
    expect(api.document).toBe(newerDocument);
    expect(api.error).toBeNull();
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(8), 'chosen.pdf', expect.any(Object));
  });

  it('cancels a pending password request on close and does not leave an unresolved open', async () => {
    const { oldDocument } = seedCurrentDocument();
    const task = loadingTask(deferred<PDFDocumentProxy>().promise);
    mocks.getDocument.mockReturnValue(task);
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7)); });
    await act(async () => task.onPassword!(vi.fn(), 1));
    await act(async () => {
      expect(await api.closeDocument()).toBe(true);
      expect(await opening).toBe(false);
    });
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(oldDocument.destroy).toHaveBeenCalledOnce();
    expect(api.passwordRequest).toBeNull();
    expect(api.document).toBeNull();
    expect(api.isLoading).toBe(false);
  });

  it('settles a pending password request when the hook unmounts', async () => {
    const task = loadingTask(deferred<PDFDocumentProxy>().promise);
    mocks.getDocument.mockReturnValue(task);
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7)); });
    await act(async () => task.onPassword!(vi.fn(), 1));
    await act(async () => { root!.unmount(); root = null; expect(await opening).toBe(false); });
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
  });

  it('cancels an in-flight decrypt before it can overwrite a newer document', async () => {
    const encryptedDocument = pdfDocument();
    vi.mocked(encryptedDocument.getPermissions).mockResolvedValue([4]);
    const pendingDecrypt = deferred<{ data: ArrayBuffer }>();
    mocks.decryptPDF.mockReturnValue(pendingDecrypt.promise);
    const firstTask = loadingTask(Promise.resolve(encryptedDocument));
    const newerDocument = pdfDocument();
    mocks.getDocument.mockReturnValueOnce(firstTask).mockReturnValueOnce(loadingTask(Promise.resolve(newerDocument)));
    await mount();
    let opening!: Promise<boolean>;
    await act(async () => { opening = api.loadDocument(buffer(7)); });
    expect(mocks.decryptPDF).toHaveBeenCalledOnce();
    await act(async () => {
      expect(await api.loadDocument(buffer(8))).toBe(true);
      expect(await opening).toBe(false);
      pendingDecrypt.resolve({ data: buffer(9) });
    });
    expect(api.document).toBe(newerDocument);
    expect(mocks.getDocument).toHaveBeenCalledTimes(2);
    expect(firstTask.destroy).toHaveBeenCalledOnce();
    expect(mocks.saveCurrentPDF).toHaveBeenCalledExactlyOnceWith(buffer(8), 'document.pdf', expect.any(Object));
  });

  it('keeps real decryption failures visible without destroying the current session', async () => {
    const { oldDocument, annotation } = seedCurrentDocument();
    const encryptedDocument = pdfDocument();
    vi.mocked(encryptedDocument.getPermissions).mockResolvedValue([4]);
    mocks.getDocument.mockReturnValue(loadingTask(Promise.resolve(encryptedDocument)));
    mocks.decryptPDF.mockRejectedValue(new Error('The PDF page structure is missing or damaged.'));
    await mount();
    await act(async () => expect(await api.loadDocument(buffer(7))).toBe(false));
    expect(api.error).toContain('page structure is missing or damaged');
    expect(api.document).toBe(oldDocument);
    expect(api.passwordRequest).toBeNull();
    expect(useAnnotationStore.getState().getAllAnnotations()[0].id).toBe(annotation.id);
    expect(mocks.saveCurrentPDF).not.toHaveBeenCalled();
  });
});
