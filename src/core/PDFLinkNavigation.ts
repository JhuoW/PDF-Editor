import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PDFLinkView } from './PDFLinkTypes';

export interface PDFLinkNavigation {
  pageNumber: number;
  view: PDFLinkView;
  left?: number;
  top?: number;
  zoom?: number;
  rectangle?: [number, number, number, number];
}
export const PDF_LINK_SCROLL_INSET = { left: 40, top: 100 };
export interface PDFLinkCurrentPosition { left: number; top: number; scale: number }

/** Capture before navigation changes page layout, scale, or scroll position. */
export function pdfLinkCurrentPosition(
  page: PDFPageProxy, rotation: number, fallbackScale: number,
  visible: { x: number; y: number; pageWidth: number },
): PDFLinkCurrentPosition {
  const effectiveRotation = ((page.rotate + rotation) % 360 + 360) % 360;
  const base = page.getViewport({ scale: 1, rotation: effectiveRotation });
  const scale = visible.pageWidth > 0 && base.width > 0 ? visible.pageWidth / base.width : fallbackScale;
  const viewport = page.getViewport({ scale, rotation: effectiveRotation });
  const [left, top] = viewport.convertToPdfPoint(visible.x, visible.y);
  return { left, top, scale };
}

/** A PDF null coordinate retains that native axis, even on a rotated page. */
export function retainPDFLinkCoordinates(destination: PDFLinkNavigation, current: PDFLinkCurrentPosition): PDFLinkNavigation {
  const result = { ...destination };
  if ((result.view === 'XYZ' || result.view === 'FitV' || result.view === 'FitBV') && result.left === undefined) result.left = current.left;
  if ((result.view === 'XYZ' || result.view === 'FitH' || result.view === 'FitBH') && result.top === undefined) result.top = current.top;
  return result;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Resolve a PDF.js destination without letting an obsolete async navigation win. */
export async function resolvePDFLinkNavigation(document: PDFDocumentProxy, destination: unknown, isCurrent = () => true): Promise<PDFLinkNavigation | null> {
  const array: unknown = typeof destination === 'string' ? await document.getDestination(destination) : destination;
  if (!isCurrent() || !Array.isArray(array) || array.length < 2) return null;
  const first = array[0], mode = array[1];
  if (!mode || typeof mode !== 'object' || !('name' in mode)) return null;
  const view = mode.name as PDFLinkView;
  if (!['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'].includes(view)) return null;
  let index: number;
  if (Number.isInteger(first)) index = first as number;
  else if (first && typeof first === 'object' && Number.isInteger(first.num) && Number.isInteger(first.gen)) index = await document.getPageIndex(first);
  else return null;
  if (!isCurrent() || !Number.isInteger(index) || index < 0 || index >= document.numPages) return null;
  const result: PDFLinkNavigation = { pageNumber: index + 1, view };
  const coordinate = (value: unknown) => value === null || finite(value);
  if (view === 'XYZ') {
    if (array.length !== 5 || !coordinate(array[2]) || !coordinate(array[3]) || !coordinate(array[4]) || (finite(array[4]) && array[4] < 0)) return null;
    if (finite(array[2])) result.left = array[2];
    if (finite(array[3])) result.top = array[3];
    if (finite(array[4]) && array[4] > 0) result.zoom = array[4];
  } else if (view === 'FitR') {
    if (array.length !== 6 || !array.slice(2).every(finite) || array[4] <= array[2] || array[5] <= array[3]) return null;
    result.rectangle = array.slice(2) as [number, number, number, number]; result.left = array[2]; result.top = array[5];
  } else if (['FitH', 'FitBH', 'FitV', 'FitBV'].includes(view)) {
    if (array.length !== 3 || !coordinate(array[2])) return null;
    if (finite(array[2])) { if (view === 'FitH' || view === 'FitBH') result.top = array[2]; else result.left = array[2]; }
  } else if (array.length !== 2) return null;
  return result;
}

/** Respect the reader's supported zoom range while fitting the requested view. */
export function pdfLinkNavigationScale(destination: PDFLinkNavigation, page: PDFPageProxy, rotation: number, available: { width: number; height: number }, current: number) {
  const viewport = page.getViewport({ scale: 1, rotation: ((page.rotate + rotation) % 360 + 360) % 360 });
  const width = Math.max(1, available.width - 80), height = Math.max(1, available.height - 80);
  let scale = current;
  if (destination.view === 'XYZ') scale = destination.zoom ?? current;
  else if (destination.rectangle) {
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(destination.rectangle);
    scale = Math.min(width / Math.abs(x1 - x0), height / Math.abs(y1 - y0));
  } else if (destination.view === 'FitH' || destination.view === 'FitBH') scale = width / viewport.width;
  else if (destination.view === 'FitV' || destination.view === 'FitBV') scale = height / viewport.height;
  else scale = Math.min(width / viewport.width, height / viewport.height);
  return Math.max(.25, Math.min(4, scale));
}
