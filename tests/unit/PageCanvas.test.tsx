// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { PDFPageProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageCanvas } from '../../src/components/PDFViewer/PageCanvas';

const formLayer = vi.hoisted(() => vi.fn<(props: { rotation: number; page: PDFPageProxy }) => null>(() => null));

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { ENABLE: 1, ENABLE_FORMS: 2 } }));
vi.mock('../../src/components/PDFViewer/TextLayer', () => ({ TextLayer: () => null }));
vi.mock('../../src/components/PDFViewer/AnnotationLayer', () => ({ AnnotationLayer: () => null }));
vi.mock('../../src/components/PDFViewer/DrawingAnnotationLayer', () => ({ DrawingAnnotationLayer: () => null }));
vi.mock('../../src/components/PDFViewer/TextSelectionHandler', () => ({ TextSelectionHandler: () => null }));
vi.mock('../../src/components/PDFViewer/DestinationHighlight', () => ({ DestinationHighlight: () => null }));
vi.mock('../../src/components/PDFViewer/FormLayer', () => ({ FormLayer: formLayer }));
vi.mock('../../src/components/PDFViewer/TextEditLayer', () => ({ TextEditLayer: () => null }));
vi.mock('../../src/components/PDFViewer/ImageEditLayer', () => ({ ImageEditLayer: () => null }));
vi.mock('../../src/components/PDFViewer/RedactionLayer', () => ({ RedactionLayer: () => null }));

function makeRenderTask() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject, cancel: vi.fn() };
}

describe('PageCanvas render lifecycle', () => {
  let host: HTMLDivElement;
  let root: Root;
  let page: PDFPageProxy;
  let tasks: ReturnType<typeof makeRenderTask>[];

  beforeEach(() => {
    formLayer.mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    tasks = [];
    page = {
      pageNumber: 1,
      rotate: 0,
      view: [0, 0, 600, 800],
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: vi.fn(() => {
        const task = makeRenderTask();
        tasks.push(task);
        return task;
      }),
    } as unknown as PDFPageProxy;
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(scale: number) {
    await act(async () => { root.render(<PageCanvas page={page} pageNumber={1} scale={scale} rotation={0} />); });
  }

  it('keeps the current task active after a previous render is cancelled', async () => {
    await render(1);
    await render(2);
    expect(tasks[0].cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      tasks[0].reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
    });
    expect(host.querySelector('.page-loading-overlay')).not.toBeNull();

    await render(3);
    expect(tasks[1].cancel).toHaveBeenCalledTimes(1);
    await act(async () => { tasks[2].resolve(); });
    expect(host.querySelector('.page-loading-overlay')).toBeNull();
  });

  it('ignores late success from an obsolete render', async () => {
    await render(1);
    await render(2);
    await act(async () => { tasks[0].resolve(); });
    expect(host.querySelector('.page-loading-overlay')).not.toBeNull();

    await render(3);
    expect(tasks[1].cancel).toHaveBeenCalledTimes(1);
  });

  it.each([[90, 0], [90, 90], [270, 180]])(
    'passes native page rotation %i and view rotation %i separately to form widgets',
    async (nativeRotation, viewRotation) => {
      page = { ...page, rotate: nativeRotation } as PDFPageProxy;
      await act(async () => {
        root.render(<PageCanvas page={page} pageNumber={1} scale={1} rotation={viewRotation} />);
      });
      expect(formLayer.mock.calls.at(-1)?.[0].rotation).toBe(viewRotation);
      expect(formLayer.mock.calls.at(-1)?.[0].page).toBe(page);
    },
  );
});
