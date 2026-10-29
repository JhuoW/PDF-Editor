import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolvePDFLinkNavigation, pdfLinkNavigationScale, pdfLinkCurrentPosition, retainPDFLinkCoordinates } from '../../src/core/PDFLinkNavigation';

const reference = { num: 10, gen: 0 };
const proxy = () => ({ numPages: 3, getDestination: vi.fn(), getPageIndex: vi.fn(async () => 2) });
const document = (value: ReturnType<typeof proxy>) => value as unknown as PDFDocumentProxy;

describe('native link navigation', () => {
  it('resolves named and explicit destinations with position and zoom, including integer page indices', async () => {
    const pdf = proxy(); pdf.getDestination.mockResolvedValue([reference, { name: 'XYZ' }, 60, 520, 1.5]);
    expect(await resolvePDFLinkNavigation(document(pdf), 'chapter')).toEqual({ pageNumber: 3, view: 'XYZ', left: 60, top: 520, zoom: 1.5 });
    expect(await resolvePDFLinkNavigation(document(pdf), [1, { name: 'XYZ' }, null, null, 0])).toEqual({ pageNumber: 2, view: 'XYZ' });
    expect(await resolvePDFLinkNavigation(document(pdf), [0, { name: 'FitR' }, 10, 20, 120, 240])).toEqual({ pageNumber: 1, view: 'FitR', left: 10, top: 240, rectangle: [10, 20, 120, 240] });
  });

  it('abandons a named lookup or page lookup that belongs to a replaced document or newer link click', async () => {
    const pdf = proxy(); let current = true, finish!: (value: unknown) => void;
    pdf.getDestination.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = resolvePDFLinkNavigation(document(pdf), 'old chapter', () => current);
    current = false; finish([reference, { name: 'Fit' }]); expect(await pending).toBeNull(); expect(pdf.getPageIndex).not.toHaveBeenCalled();
    current = true;
    let finishPage!: (value: number) => void;
    pdf.getPageIndex.mockImplementation(() => new Promise<number>(resolve => { finishPage = resolve; }));
    const explicit = resolvePDFLinkNavigation(document(pdf), [reference, { name: 'Fit' }], () => current);
    current = false; finishPage(1); expect(await explicit).toBeNull();
  });

  it.each([
    [3, { name: 'Fit' }], [-1, { name: 'Fit' }], [0, { name: 'Launch' }],
    [0, { name: 'XYZ' }, NaN, null, null], [0, { name: 'XYZ' }, null, 50, -1],
    [0, { name: 'FitR' }, 30, 20, 10, 50], [0, { name: 'FitH' }, '500'],
  ])('rejects invalid or unavailable destination %j', async (...array) => {
    expect(await resolvePDFLinkNavigation(document(proxy()), array)).toBeNull();
  });

  it('fits native rotated/CropBox/UserUnit geometry and honors the bounded XYZ zoom', () => {
    const page = { rotate: 90, getViewport: vi.fn(({ rotation }: { rotation: number }) => ({
      width: rotation % 180 ? 900 : 600, height: rotation % 180 ? 600 : 900,
      convertToViewportRectangle: () => [200, 400, 600, 200],
    })) } as unknown as PDFPageProxy;
    const bounds = { width: 880, height: 680 };
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'XYZ', zoom: 1.5 }, page, 0, bounds, 1)).toBe(1.5);
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'XYZ', zoom: 100 }, page, 0, bounds, 1)).toBe(4);
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'Fit' }, page, 0, bounds, 1)).toBeCloseTo(800 / 900);
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'FitV' }, page, 0, bounds, 1)).toBe(1);
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'FitR', rectangle: [1, 2, 3, 4] }, page, 0, bounds, 1)).toBe(2);
    expect(pdfLinkNavigationScale({ pageNumber: 1, view: 'FitH' }, page, 90, bounds, 1)).toBeCloseTo(800 / 600);
  });

  it.each([0, 90, 180, 270])('retains null axes in original PDF coordinates with Rotate=%s, viewer rotation, CropBox and UserUnit', async nativeRotation => {
    const source = await PDFDocument.create(), nativePage = source.addPage([500, 700]);
    nativePage.setCropBox(50, 80, 300, 450); nativePage.setRotation(degrees(nativeRotation));
    nativePage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const task = getDocument({ data: await source.save() });
    try {
      const pdf = await task.promise, page = await pdf.getPage(1), viewRotation = 90, scale = 1.75;
      const viewport = page.getViewport({ scale, rotation: (nativeRotation + viewRotation) % 360 });
      const [x, y] = viewport.convertToViewportPoint(140, 330);
      // The DOM width records the actually displayed fit zoom, even if the
      // store's calculated-zoom notification has not caught up yet.
      const current = pdfLinkCurrentPosition(page, viewRotation, .5, { x, y, pageWidth: viewport.width });
      expect(current.left).toBeCloseTo(140); expect(current.top).toBeCloseTo(330); expect(current.scale).toBeCloseTo(scale);
      const nullXYZ = (await resolvePDFLinkNavigation(pdf, [0, { name: 'XYZ' }, null, null, null]))!;
      const retained = retainPDFLinkCoordinates(nullXYZ, current);
      expect(retained).toEqual({ pageNumber: 1, view: 'XYZ', left: 140, top: 330 });
      expect(nullXYZ).toEqual({ pageNumber: 1, view: 'XYZ' });
      expect(viewport.convertToViewportPoint(retained.left!, retained.top!)).toEqual([x, y]);
      expect(pdfLinkNavigationScale(retained, page, viewRotation, { width: 1000, height: 800 }, current.scale)).toBe(scale);
      const explicitX = (await resolvePDFLinkNavigation(pdf, [0, { name: 'XYZ' }, 70, null, 2]))!;
      expect(retainPDFLinkCoordinates(explicitX, current)).toMatchObject({ left: 70, top: 330, zoom: 2 });
      const explicitY = (await resolvePDFLinkNavigation(pdf, [0, { name: 'XYZ' }, null, 220, 0]))!;
      expect(retainPDFLinkCoordinates(explicitY, current)).toMatchObject({ left: 140, top: 220 });
      for (const view of ['FitH', 'FitBH'] as const) {
        expect(retainPDFLinkCoordinates({ pageNumber: 1, view }, current)).toEqual({ pageNumber: 1, view, top: 330 });
        expect(retainPDFLinkCoordinates({ pageNumber: 1, view, top: 240 }, current).top).toBe(240);
      }
      for (const view of ['FitV', 'FitBV'] as const) {
        expect(retainPDFLinkCoordinates({ pageNumber: 1, view }, current)).toEqual({ pageNumber: 1, view, left: 140 });
        expect(retainPDFLinkCoordinates({ pageNumber: 1, view, left: 70 }, current).left).toBe(70);
      }
      expect(retainPDFLinkCoordinates({ pageNumber: 1, view: 'Fit' }, current)).toEqual({ pageNumber: 1, view: 'Fit' });
    } finally { await task.destroy(); }
  });
});
