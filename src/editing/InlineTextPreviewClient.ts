import type { PreparedTextEditLayout } from './TextEditApplier';
import type { TextBlock, TextEditOperation, TextRect } from './types';

export interface InlineTextPreviewRequest {
  id: number; data?: ArrayBuffer; pageNumber: number; blocks: TextBlock[]; edits: TextEditOperation[];
  activeId: string | null; scale: number; rotation: number;
  htmlForms?: boolean;
}
export interface InlineTextPreviewResult {
  id: number; activeId?: string | null; png?: Uint8Array<ArrayBuffer>; bytes?: Uint8Array<ArrayBuffer>; prepared?: PreparedTextEditLayout; availableRect?: TextRect; error?: string;
}

/** One worker and one source copy per mounted page. Coalesce typing while busy. */
export class InlineTextPreviewClient {
  private worker = new Worker(new URL('./InlineTextPreview.worker.ts', import.meta.url), { type: 'module' });
  private pending?: InlineTextPreviewRequest;
  private busy = false;
  private disposed = false;
  private readonly result: (result: InlineTextPreviewResult) => void;
  constructor(result: (result: InlineTextPreviewResult) => void) {
    this.result = result;
    this.worker.onmessage = event => {
      if (this.disposed) return;
      this.busy = false;
      this.result(event.data);
      this.flush();
    };
    this.worker.onerror = event => {
      event.preventDefault(); this.busy = false;
      this.result({ id: -1, error: event.message || 'Could not start the PDF text editor.' });
    };
  }
  request(request: InlineTextPreviewRequest) {
    if (this.disposed) return;
    // Preserve initialization if newer keystrokes arrive before it is sent.
    this.pending = { ...request, data: request.data ?? this.pending?.data };
    this.flush();
  }
  private flush() {
    if (this.busy || !this.pending || this.disposed) return;
    const request = this.pending; this.pending = undefined; this.busy = true;
    this.worker.postMessage(request, request.data ? [request.data] : []);
  }
  destroy() { this.disposed = true; this.pending = undefined; this.worker.terminate(); }
}
