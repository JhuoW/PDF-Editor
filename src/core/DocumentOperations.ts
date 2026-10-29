import { useDocumentStore } from '../store/documentStore';
import { appendDocumentCheckpoint, useHistoryStore, type HistoryTimeline } from '../store/historyStore';
import { commitPendingEditors } from '../store/workspaceHistory';
import { captureWorkspace, remapWorkspacePages, type WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { readActivePDF } from './ActiveDocument';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { reconcileFormState } from '../forms/reconcileFormState';

export interface DocumentOperationContext {
  data: ArrayBuffer;
  fileName: string;
  totalPages: number;
  workspace: WorkspaceSnapshot;
}

export interface DocumentOperationResult {
  data: Uint8Array;
  pageMap?: Map<number, number>;
  workspace?: WorkspaceSnapshot;
}

export type DocumentLoader = (file: File, options: {
  preserveState: boolean;
  workspace: WorkspaceSnapshot;
  history: HistoryTimeline;
}) => Promise<boolean>;

let operationInProgress = false;

/** Commit PDF bytes and all page-bound editing state together, or leave both intact. */
export async function performDocumentOperation(
  actionName: string,
  transform: (context: DocumentOperationContext) => Promise<DocumentOperationResult | null>,
  load: DocumentLoader,
): Promise<void> {
  commitPendingEditors();
  const initial = useDocumentStore.getState();
  if (!initial.document) throw new Error('No PDF loaded');
  if (initial.isLoading || operationInProgress) throw new Error('Wait for the current document operation to finish');
  operationInProgress = true;
  const session = useHistoryStore.getState().originalDocument;
  const isSameDocument = () => useDocumentStore.getState().document === initial.document
    && useDocumentStore.getState().documentVersion === initial.documentVersion
    && useDocumentStore.getState().loadRequestId === initial.loadRequestId;
  const isSameSession = () => useHistoryStore.getState().originalDocument === session;
  const beforeWorkspace = captureWorkspace();
  initial.setLoading(true);
  initial.setError(null);
  try {
    const stored = await readActivePDF();
    if (!isSameDocument()) throw new Error('Document changed before the operation started');
    if (!stored) throw new Error('The current PDF is unavailable');
    const result = await transform({
      data: stored.data,
      fileName: stored.fileName,
      totalPages: initial.document.numPages,
      workspace: structuredClone(beforeWorkspace),
    });
    if (!isSameDocument()) throw new Error('Document changed while the operation was running');
    // A completed inspection (for example OCR skipping text pages) is not an edit.
    if (result === null) return;
    const afterWorkspace = result.workspace ?? (result.pageMap
      ? remapWorkspacePages(beforeWorkspace, result.pageMap)
      : structuredClone(beforeWorkspace));
    if (result.pageMap) {
      const fields = await extractFormFields(new Uint8Array(result.data).buffer);
      if (!isSameDocument()) throw new Error('Document changed while the operation was running');
      afterWorkspace.form = reconcileFormState(afterWorkspace.form, fields);
    }
    // Earlier annotation actions are part of this document history entry.
    afterWorkspace.annotationHistory = { past: [], future: [] };
    const history = useHistoryStore.getState();
    const nextHistory = appendDocumentCheckpoint(history, {
      data: stored.data.slice(0), fileName: stored.fileName, actionName, timestamp: Date.now(), workspace: beforeWorkspace,
    }, history.maxHistory);
    const file = new File([new Uint8Array(result.data)], stored.fileName, { type: 'application/pdf' });
    if (!await load(file, { preserveState: true, workspace: afterWorkspace, history: nextHistory })) {
      throw new Error('Could not load the modified PDF');
    }
    if (!isSameSession()) return;
    if (result.pageMap) {
      const currentPage = result.pageMap.get(initial.navigation.currentPage)
        ?? Math.min(initial.navigation.currentPage, result.pageMap.size || 1);
      useDocumentStore.getState().setCurrentPage(currentPage);
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError') && isSameSession()
      && useDocumentStore.getState().loadRequestId === initial.loadRequestId) {
      useDocumentStore.getState().setError(error instanceof Error ? error.message : 'Document operation failed');
    }
    throw error;
  } finally {
    if (isSameDocument()) initial.setLoading(false);
    operationInProgress = false;
  }
}
