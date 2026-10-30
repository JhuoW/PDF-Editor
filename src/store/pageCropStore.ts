import { create } from 'zustand';
import { useDocumentStore } from './documentStore';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageCropMargins } from '../core/PageManagement';

export interface PageCropRect { x: number; y: number; width: number; height: number }
export interface PageCropOptions {
  pageNumber: number;
  onApply: (margins: PageCropMargins, signal: AbortSignal, onCommit: () => void) => Promise<void>;
  onOptions?: (margins?: PageCropMargins) => void;
}
interface PageCropSession extends PageCropOptions {
  document: PDFDocumentProxy;
  version: number;
  requestId: number;
}
let activeRequest: AbortController | null = null;
export const usePageCropStore = create<{
  session: PageCropSession | null;
  /** Normalized coordinates in the page's intrinsic-rotation viewport. */
  rect: PageCropRect | null;
  busy: boolean;
  committing: boolean;
  error: string | null;
  start: (options: PageCropOptions) => void;
  cancel: () => void;
  setRect: (rect: PageCropRect | null) => void;
  apply: (margins: PageCropMargins) => Promise<void>;
  options: (margins?: PageCropMargins) => void;
}>((set, get) => ({
  session: null, rect: null, busy: false, committing: false, error: null,
  start: options => {
    const current = useDocumentStore.getState();
    if (!current.document || current.isLoading || get().committing || !Number.isInteger(options.pageNumber)
      || options.pageNumber < 1 || options.pageNumber > current.document.numPages) return;
    activeRequest?.abort(); activeRequest = null;
    set({ session: { ...options, document: current.document, version: current.documentVersion, requestId: current.loadRequestId }, rect: null, busy: false, committing: false, error: null });
  },
  cancel: () => {
    if (get().committing) return;
    activeRequest?.abort(); activeRequest = null;
    set({ session: null, rect: null, busy: false, committing: false, error: null });
  },
  setRect: rect => {
    if (!get().busy) set({ rect, error: null });
  },
  apply: async margins => {
    const session = get().session, source = useDocumentStore.getState();
    if (!session || get().busy || !get().rect || source.document !== session.document
      || source.documentVersion !== session.version || source.loadRequestId !== session.requestId || source.isLoading) return;
    const request = new AbortController(); activeRequest = request; set({ busy: true, error: null });
    try {
      await session.onApply(margins, request.signal, () => {
        request.signal.throwIfAborted();
        if (get().session !== session) throw new DOMException('Crop canceled', 'AbortError');
        set({ committing: true });
      });
      if (get().session === session) set({ session: null, rect: null, busy: false, committing: false, error: null });
    } catch (cause) {
      if (get().session === session && !request.signal.aborted) set({ busy: false, committing: false,
        error: cause instanceof Error ? cause.message : 'Could not crop the page.' });
    } finally { if (activeRequest === request) activeRequest = null; }
  },
  options: margins => {
    const state = get();
    if (!state.session?.onOptions || state.busy) return;
    const callback = state.session.onOptions; get().cancel(); callback(margins);
  },
}));

useDocumentStore.subscribe((next, previous) => {
  const crop = usePageCropStore.getState();
  if (!crop.session) return;
  if (next.document !== previous.document || next.documentVersion !== previous.documentVersion
    || next.loadRequestId !== previous.loadRequestId || next.navigation.currentPage !== previous.navigation.currentPage) {
    // Our own atomic document commit may replace the PDF after cancellation is
    // disabled. A different document request before that point aborts preparation.
    if (!crop.committing) activeRequest?.abort();
    usePageCropStore.setState({ session: null, rect: null, busy: false, committing: false, error: null });
  }
});
