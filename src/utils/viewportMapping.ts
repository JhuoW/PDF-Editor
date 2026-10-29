import type { PageViewport } from 'pdfjs-dist';

export interface ViewportRect { x: number; y: number; width: number; height: number }
type CoordinateViewport = Pick<PageViewport, 'convertToPdfPoint' | 'convertToViewportPoint'>;

export function mapViewportPoint(x: number, y: number, from: CoordinateViewport, to: CoordinateViewport) {
  const [pdfX, pdfY] = from.convertToPdfPoint(x, y);
  const [mappedX, mappedY] = to.convertToViewportPoint(pdfX, pdfY);
  return { x: mappedX, y: mappedY };
}

export function mapViewportRect(rect: ViewportRect, from: CoordinateViewport, to: CoordinateViewport): ViewportRect {
  const points = [
    mapViewportPoint(rect.x, rect.y, from, to),
    mapViewportPoint(rect.x + rect.width, rect.y, from, to),
    mapViewportPoint(rect.x, rect.y + rect.height, from, to),
    mapViewportPoint(rect.x + rect.width, rect.y + rect.height, from, to),
  ];
  const x = Math.min(...points.map(point => point.x));
  const y = Math.min(...points.map(point => point.y));
  return {
    x, y,
    width: Math.max(...points.map(point => point.x)) - x,
    height: Math.max(...points.map(point => point.y)) - y,
  };
}
