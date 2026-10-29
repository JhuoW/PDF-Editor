import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { performDocumentOperation, type DocumentLoader } from '../../src/core/DocumentOperations';
import { deletionPageMap, insertionPageMap, reorderedPageMap, movePageSelection } from '../../src/core/pageMapping';
import { useDocumentStore } from '../../src/store/documentStore';
import { useHistoryStore } from '../../src/store/historyStore';
import { useAnnotationStore, createRectangleAnnotation } from '../../src/store/annotationStore';
import { useAnnotationHistoryStore } from '../../src/store/annotationHistoryStore';
import { useFormStore } from '../../src/store/formStore';
import { captureWorkspace, createWorkspace, restoreWorkspace } from '../../src/store/workspaceSnapshot';

const mocks = vi.hoisted(() => ({ loadCurrentPDF: vi.fn(), extractFormFields: vi.fn() }));
vi.mock('../../src/core/ActiveDocument', () => ({ readActivePDF: mocks.loadCurrentPDF }));
vi.mock('../../src/forms/FormFieldExtractor', () => mocks);
const bytes = (value: number) => new Uint8Array([value]).buffer;
const proxy = (numPages: number) => ({ numPages }) as PDFDocumentProxy;

beforeEach(() => {
  vi.resetAllMocks();
  restoreWorkspace(createWorkspace());
  useHistoryStore.getState().clearHistory();
  useHistoryStore.getState().setOriginalDocument(bytes(1), 'sample.pdf');
  useDocumentStore.setState(useDocumentStore.getInitialState());
  useDocumentStore.getState().setDocument(proxy(3));
  mocks.extractFormFields.mockResolvedValue([]);
  mocks.loadCurrentPDF.mockResolvedValue({ data: bytes(1), fileName: 'sample.pdf' });
});

describe('document operations and editable state', () => {
  it('deleting a page moves its surviving edits together and undo restores deleted edits and their history', async () => {
    const first = createRectangleAnnotation(1, [10, 10, 30, 30]);
    const second = createRectangleAnnotation(2, [20, 20, 40, 40]);
    useAnnotationStore.getState().addAnnotation(first);
    useAnnotationStore.getState().addAnnotation(second);
    useAnnotationHistoryStore.getState().recordAdd(first);
    useAnnotationHistoryStore.getState().recordAdd(second);
    useFormStore.getState().setFields([{
      id: 'form', name: 'name', type: 'text', pageNumber: 2, value: 'original',
      rect: { x: 1, y: 1, width: 20, height: 20 }, required: false, readOnly: false, hidden: false,
    }]);
    mocks.extractFormFields.mockResolvedValue([{ ...useFormStore.getState().fields[0], pageNumber: 1 }]);
    useFormStore.getState().setFieldValue('form', 'filled value');
    useDocumentStore.getState().setCurrentPage(2);
    const loader: DocumentLoader = async (_file, options) => {
      restoreWorkspace(options.workspace);
      useHistoryStore.setState(options.history);
      useDocumentStore.getState().setDocument(proxy(2), true);
      useDocumentStore.getState().setLoading(false);
      return true;
    };
    await performDocumentOperation('Delete page 1', async () => ({
      data: new Uint8Array([2]), pageMap: deletionPageMap(3, [1]),
    }), loader);
    expect(useAnnotationStore.getState().getAllAnnotations()).toMatchObject([{ id: second.id, pageNumber: 1 }]);
    expect(useFormStore.getState().fields[0]).toMatchObject({ pageNumber: 1, value: 'filled value' });
    expect(useFormStore.getState().isDirty).toBe(true);
    expect(useDocumentStore.getState().navigation.currentPage).toBe(1);
    expect(useAnnotationHistoryStore.getState().canUndo()).toBe(false);

    const snapshot = useHistoryStore.getState().undo(bytes(2), 'sample.pdf', captureWorkspace())!;
    restoreWorkspace(snapshot.workspace!);
    expect(useAnnotationStore.getState().getAllAnnotations()).toMatchObject([
      { id: first.id, pageNumber: 1 }, { id: second.id, pageNumber: 2 },
    ]);
    expect(useFormStore.getState().fields[0]).toMatchObject({ pageNumber: 2, value: 'filled value' });
    expect(useHistoryStore.getState().undoStack).toHaveLength(3);
    expect(useAnnotationHistoryStore.getState().past).toHaveLength(0);
    const redo = useHistoryStore.getState().redo(bytes(1), 'sample.pdf', captureWorkspace())!;
    restoreWorkspace(redo.workspace!);
    expect(useAnnotationStore.getState().getAllAnnotations()).toMatchObject([{ id: second.id, pageNumber: 1 }]);
  });

  it('a failed transformation changes neither edits nor history and releases loading', async () => {
    const annotation = createRectangleAnnotation(2, [1, 2, 3, 4]);
    useAnnotationStore.getState().addAnnotation(annotation);
    const before = captureWorkspace();
    const load = vi.fn();
    await expect(performDocumentOperation('Delete', async () => { throw new Error('Invalid PDF'); }, load))
      .rejects.toThrow('Invalid PDF');
    expect(captureWorkspace()).toEqual(before);
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(useDocumentStore.getState()).toMatchObject({ isLoading: false, error: 'Invalid PDF' });
    expect(load).not.toHaveBeenCalled();
  });

  it('a no-change result keeps the current PDF and redo branch without creating a checkpoint', async () => {
    useHistoryStore.getState().pushState(bytes(2), 'sample.pdf', 'Prior edit');
    useHistoryStore.getState().undo(bytes(3), 'sample.pdf', captureWorkspace());
    const before = useHistoryStore.getState();
    const load = vi.fn();
    await performDocumentOperation('OCR', async () => null, load);
    expect(load).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().undoStack).toEqual(before.undoStack);
    expect(useHistoryStore.getState().redoStack).toEqual(before.redoStack);
    expect(useDocumentStore.getState()).toMatchObject({ isLoading: false, error: null });
  });

  it('an explicitly cancelled operation releases loading without reporting a document failure', async () => {
    const before = captureWorkspace();
    const load = vi.fn();
    await expect(performDocumentOperation('OCR', async () => {
      throw new DOMException('Recognition cancelled', 'AbortError');
    }, load)).rejects.toMatchObject({ name: 'AbortError' });
    expect(captureWorkspace()).toEqual(before);
    expect(load).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(useDocumentStore.getState()).toMatchObject({ isLoading: false, error: null });
  });

  it('cancels a pending transformation as soon as opening another file is requested', async () => {
    let finish!: (value: { data: Uint8Array }) => void;
    const pending = new Promise<{ data: Uint8Array }>(resolve => { finish = resolve; });
    const load = vi.fn();
    const operation = performDocumentOperation('Rotate', () => pending, load);
    await Promise.resolve();
    useDocumentStore.getState().beginLoadRequest();
    useDocumentStore.getState().setLoading(true);
    finish({ data: new Uint8Array([2]) });
    await expect(operation).rejects.toThrow('Document changed');
    expect(load).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    // The old operation must not stop or add an error to the newer loading request.
    expect(useDocumentStore.getState()).toMatchObject({ isLoading: true, error: null });
  });
});

describe('page mapping validation', () => {
  it('moves a selection together in document order without dropping or duplicating pages', () => {
    expect(movePageSelection(5, [4, 2], 1)).toEqual([2, 4, 1, 3, 5]);
    expect(movePageSelection(5, [2, 4], 0)).toEqual([1, 3, 5, 2, 4]);
    expect(movePageSelection(3, [1], 3)).toEqual([2, 1, 3]);
    expect(movePageSelection(3, [3], 2)).toEqual([1, 3, 2]);
    expect(movePageSelection(3, [1, 2, 3], 2)).toEqual([1, 2, 3]);
  });
  it('maps insertion, deletion with duplicate selections, and reorder exactly', () => {
    expect([...insertionPageMap(3, 2, 2)]).toEqual([[1, 1], [2, 4], [3, 5]]);
    expect([...insertionPageMap(3, 0, 2)]).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect([...deletionPageMap(3, [1, 1])]).toEqual([[2, 1], [3, 2]]);
    expect([...reorderedPageMap(3, [3, 1, 2])]).toEqual([[3, 1], [1, 2], [2, 3]]);
  });
  it('rejects invalid positions, counts, and incomplete page orders', () => {
    expect(() => deletionPageMap(1, [1])).toThrow();
    expect(() => deletionPageMap(3, [1.5])).toThrow();
    expect(() => insertionPageMap(3, 1, 0)).toThrow();
    expect(() => insertionPageMap(3, 5, 1)).toThrow();
    expect(() => reorderedPageMap(3, [1, 1, 3])).toThrow();
  });
});
