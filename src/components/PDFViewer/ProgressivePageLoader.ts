import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/** Page requests are shared between navigation and the background dimensions scan.
 * A slow earlier page never blocks an explicit jump to a later page. */
export class ProgressivePageLoader {
  private stopped = false;
  private requests = new Map<number, Promise<void>>();
  private pending = new Map<number, PDFPageProxy>();
  private urgent = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private document: PDFDocumentProxy;
  private first: number;
  private last: number;
  private onPages: (pages: PDFPageProxy[]) => void;
  private onError: (pageNumber: number, error: unknown) => void;
  constructor(
    document: PDFDocumentProxy,
    first: number,
    last: number,
    onPages: (pages: PDFPageProxy[]) => void,
    onError: (pageNumber: number, error: unknown) => void,
  ) {
    this.document = document; this.first = first; this.last = last;
    this.onPages = onPages; this.onError = onError;
  }
  private flush = () => {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.stopped || !this.pending.size) return;
    const pages = [...this.pending.values()]; this.pending.clear();
    this.onPages(pages);
  };
  private load(pageNumber: number, urgent = false): Promise<void> {
    if (this.stopped || pageNumber < this.first || pageNumber > this.last) return Promise.resolve();
    if (urgent) this.urgent.add(pageNumber);
    const existing = this.requests.get(pageNumber);
    if (existing) {
      if (urgent) this.flush();
      return existing;
    }
    const request = this.document.getPage(pageNumber).then(page => {
      if (this.stopped) return;
      this.pending.set(pageNumber, page);
      if (this.urgent.has(pageNumber)) this.flush();
      else if (this.timer === undefined) this.timer = setTimeout(this.flush, 16);
    }).catch(error => { if (!this.stopped) this.onError(pageNumber, error); });
    this.requests.set(pageNumber, request);
    return request;
  }
  prioritize(pageNumbers: Iterable<number>) {
    for (const pageNumber of pageNumbers) void this.load(pageNumber, true);
  }
  async start(currentPage: number) {
    await this.load(currentPage, true);
    // Sequential background work bounds page-tree parsing pressure; foreground
    // requests have their own path and do not wait behind this scan.
    for (let pageNumber = this.first; pageNumber <= this.last && !this.stopped; pageNumber++) await this.load(pageNumber);
    this.flush();
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); this.pending.clear();
  }
}
