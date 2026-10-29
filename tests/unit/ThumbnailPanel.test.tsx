// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThumbnailPanel } from '../../src/components/Sidebar/ThumbnailPanel';

let host: HTMLDivElement;
let root: Root;
let observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    callback: IntersectionObserverCallback;
    disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) { this.callback = callback; observers.push(this); }
    observe() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,thumbnail');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeDocument() {
  const jobs: { done: () => void; cancel: ReturnType<typeof vi.fn>; canvas: HTMLCanvasElement }[] = [];
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: ({ canvas }: { canvas: HTMLCanvasElement }) => {
      let done!: () => void;
      const promise = new Promise<void>(resolve => { done = resolve; });
      const job = { done, cancel: vi.fn(), canvas };
      jobs.push(job);
      return { promise, cancel: job.cancel };
    },
  }));
  return { document: { numPages: 8, getPage } as unknown as PDFDocumentProxy, jobs, getPage };
}

async function render(pdf: PDFDocumentProxy) {
  await act(async () => root.render(<ThumbnailPanel document={pdf} currentPage={1} onPageSelect={() => {}} />));
}

async function intersect(pages: number[]) {
  const entries = [...host.querySelectorAll('.thumbnail-item')].map(target => ({
    target, isIntersecting: pages.includes(Number(target.getAttribute('data-page'))),
  } as IntersectionObserverEntry));
  await act(async () => observers.at(-1)!.callback(entries, {} as IntersectionObserver));
}

it('bounds concurrent renders, drops offscreen queued pages, and keeps one observer across completions', async () => {
  const pdf = makeDocument();
  await render(pdf.document);
  await intersect([1, 2, 3, 4, 5, 6]);
  expect(pdf.getPage).toHaveBeenCalledTimes(2);
  expect(pdf.jobs[0].canvas.width).toBe(120);
  await intersect([5, 6]);
  await act(async () => pdf.jobs[0].done());
  expect(pdf.getPage.mock.calls.map(call => call[0])).toEqual([1, 2, 5]);
  expect(host.querySelectorAll('img')).toHaveLength(1);
  expect(observers).toHaveLength(1);
  expect(pdf.jobs[0].canvas.width).toBe(0);
});

it('cancels old tasks and prevents their results appearing after switching documents', async () => {
  const old = makeDocument();
  await render(old.document);
  await intersect([1, 2]);
  const next = makeDocument();
  await render(next.document);
  expect(old.jobs.every(job => job.cancel.mock.calls.length === 1)).toBe(true);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  await act(async () => old.jobs.forEach(job => job.done()));
  expect(host.querySelectorAll('img')).toHaveLength(0);
  await intersect([1]);
  await act(async () => next.jobs[0].done());
  expect(host.querySelectorAll('img')).toHaveLength(1);
});
