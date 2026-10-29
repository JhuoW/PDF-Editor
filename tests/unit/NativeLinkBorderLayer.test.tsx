// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { NativeLinkBorderLayer } from '../../src/components/PDFViewer/NativeLinkBorderLayer';
import { AnnotationLayer } from '../../src/components/PDFViewer/AnnotationLayer';

let root: Root, host: HTMLDivElement;
const tasks: PDFDocumentLoadingTask[] = [];
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); for (const task of tasks.splice(0)) await task.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(rotation = 0) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([350, 500]);
  page.setCropBox(50, 80, 200, 300); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  const add = (description: string, rect: number[], values: Record<string, unknown>) => page.node.addAnnot(pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: rect, Contents: PDFString.of(description), F: 4,
    A: { S: 'URI', URI: PDFString.of('https://never-access.example.invalid/') }, ...values,
  })));
  add('solid', [70, 110, 130, 135], { C: [1, 0, 0], BS: { W: 2, S: 'S' } });
  add('dashed', [70, 160, 130, 185], { C: [0, 0, 1], BS: { W: 2, S: 'D', D: [4, 2] } });
  add('underline', [70, 210, 130, 235], { C: [0, 1, 0], BS: { W: 2, S: 'U' } });
  const appearance = pdf.context.register(pdf.context.stream('0 0 1 rg 0 0 30 30 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 30, 30], Resources: {} }));
  add('with appearance', [150, 110, 180, 140], { C: [1, 0, 0], BS: { W: 4, S: 'S' }, AP: { N: appearance } });
  add('hidden', [150, 170, 180, 190], { F: 2, C: [1, 0, 0], BS: { W: 2, S: 'S' } });
  add('no view', [150, 200, 180, 220], { F: 32, C: [1, 0, 0], BS: { W: 2, S: 'S' } });
  add('invisible border', [150, 240, 180, 260], { C: [1, 0, 0], BS: { W: 0, S: 'S' } });
  add('transparent', [150, 280, 180, 300], { C: [], BS: { W: 2, S: 'S' } });
  const data = await pdf.save({ useObjectStreams: false });
  const task = getDocument({ data, useSystemFonts: false }); tasks.push(task);
  const document = await task.promise; return { page: await document.getPage(1), data };
}
async function render(page: PDFPageProxy, viewport: PageViewport, onReady = vi.fn(), onError = vi.fn()) {
  await act(async () => root.render(<NativeLinkBorderLayer page={page} viewport={viewport} onReady={onReady} onError={onError} />));
  // Warm the real PDF.js request, then let the React subscription commit.
  await act(async () => { await page.getAnnotations({ intent: 'display' }); });
  return { onReady, onError };
}
function colorBounds(pixels: Uint8ClampedArray, width: number, red: boolean) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = pixels.subarray(i, i + 4);
    if (a > 100 && (red ? r > 180 && g < 50 && b < 50 : g > 180 && r < 50 && b < 50)) {
      const x = i / 4 % width, y = Math.floor(i / 4 / width); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
    }
  }
  return { left, top, right, bottom, count };
}

describe('native link borders from real PDF annotations', () => {
  it.each([0, 90, 180, 270])('paints solid/dashed/underline with CropBox, UserUnit and Rotate=%s in native geometry', async rotation => {
    const { page } = await fixture(rotation), viewport = page.getViewport({ scale: 1.5 });
    const { onReady, onError } = await render(page, viewport);
    expect(onReady).toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(host.querySelector('a')).toBeNull();
    expect(host.querySelectorAll('rect')).toHaveLength(2); expect(host.querySelectorAll('line')).toHaveLength(1);
    expect(host.querySelector('g')!.getAttribute('transform')).toBe(`matrix(${viewport.transform.join(' ')})`);
    const rectangles = [...host.querySelectorAll('rect')];
    expect(rectangles[0].getAttribute('stroke-width')).toBe('2'); expect(rectangles[0].getAttribute('x')).toBe('71');
    expect(rectangles[1].getAttribute('stroke-dasharray')).toBe('4 2');
    const underline = host.querySelector('line')!; expect(underline.getAttribute('y1')).toBe('211'); expect(underline.getAttribute('y2')).toBe('211');
    const svg = host.querySelector('svg')!; svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const image = await loadImage(Buffer.from(svg.outerHTML));
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, red = colorBounds(pixels, canvas.width, true), green = colorBounds(pixels, canvas.width, false);
    expect(red.count).toBeGreaterThan(100); expect(green.count).toBeGreaterThan(100);
    const [a, b] = [viewport.convertToViewportPoint(70, 210), viewport.convertToViewportPoint(130, 212)];
    expect(green.left).toBeCloseTo(Math.min(a[0], b[0]), 0); expect(green.top).toBeCloseTo(Math.min(a[1], b[1]), 0);
    expect(green.right + 1).toBeCloseTo(Math.max(a[0], b[0]), 0); expect(green.bottom + 1).toBeCloseTo(Math.max(a[1], b[1]), 0);
  });

  it('proves the native no-AP border is absent from PDF.js canvas and supplied by SVG, while AP is painted only once', async () => {
    const { page } = await fixture(), viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height), context = canvas.getContext('2d');
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    expect(colorBounds(pixels, canvas.width, true).count).toBe(0);
    const [x, y] = viewport.convertToViewportPoint(165, 125), offset = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
    expect([...pixels.slice(offset, offset + 3)]).toEqual([0, 0, 255]);
    await render(page, viewport);
    const annotations = await page.getAnnotations(), appearance = annotations.find(item => item.contentsObj.str === 'with appearance');
    expect(appearance.hasAppearance).toBe(true);
    expect(host.querySelector(`[data-annotation-id="${appearance.id}"]`)).toBeNull();
  });

  it('integrates the same borders into reading without losing accessible link labels', async () => {
    const { page } = await fixture(90);
    await act(async () => root.render(<AnnotationLayer page={page} scale={1.5} rotation={90} onLinkClick={vi.fn()} />));
    await act(async () => { await page.getAnnotations(); });
    expect(host.querySelectorAll('.native-link-border-layer rect')).toHaveLength(2);
    expect(host.querySelector('a[aria-label="solid"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelector('a[aria-label="hidden"]')).toBeNull(); expect(host.querySelector('a[aria-label="no view"]')).toBeNull();
    expect(host.querySelector('.native-link-border-layer a')).toBeNull();
  });

  it('ignores late old-page annotations and reports rejected reads without marking them ready', async () => {
    const { page } = await fixture(), viewport = page.getViewport({ scale: 1 });
    let finish!: (annotations: unknown[]) => void;
    const old = { getAnnotations: () => new Promise<unknown[]>(resolve => { finish = resolve; }) } as unknown as PDFPageProxy;
    const ready = vi.fn(), error = vi.fn();
    await act(async () => root.render(<NativeLinkBorderLayer page={old} viewport={viewport} onReady={ready} onError={error} />));
    await render(page, viewport, ready, error); const count = ready.mock.calls.length;
    await act(async () => finish([{ subtype: 'Link', rect: [1, 2, 30, 40], borderStyle: { width: 2, style: 1 }, borderColor: [255, 0, 0] }]));
    expect(ready).toHaveBeenCalledTimes(count); expect(host.querySelectorAll('rect')).toHaveLength(2);
    const broken = { getAnnotations: async () => { throw new Error('Annotations failed'); } } as unknown as PDFPageProxy;
    await act(async () => root.render(<NativeLinkBorderLayer page={broken} viewport={viewport} onReady={ready} onError={error} />));
    expect(error).toHaveBeenCalledWith('Annotations failed'); expect(ready).toHaveBeenCalledTimes(count); expect(host.querySelectorAll('rect')).toHaveLength(0);
  });
});
