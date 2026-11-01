import type { TextRect } from './types';

export type ObjectResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const OBJECT_RESIZE_HANDLES: ObjectResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Geometry is measured in display-page pixels; viewport conversion handles page rotation. */
export function moveObjectRect(rect: TextRect, dx: number, dy: number, bounds: { width: number; height: number }): TextRect {
  // PDFs can contain artwork extending beyond the crop box. Keep its existing
  // overflow instead of snapping it on selection; movement can bring it inward.
  // Oversized artwork can pan between both page edges without changing its size.
  const move = (position: number, delta: number, size: number, limit: number) =>
    clamp(position + delta, Math.min(0, limit - size, position), Math.max(0, limit - size, position));
  return { ...rect, x: move(rect.x, dx, rect.width, bounds.width), y: move(rect.y, dy, rect.height, bounds.height) };
}

/** Keep the opposite edge/corner fixed, without flipping an object through its anchor. */
export function resizeObjectRect(rect: TextRect, handle: ObjectResizeHandle, dx: number, dy: number, bounds: { width: number; height: number }, preserveRatio: boolean, minimum = 4): TextRect {
  const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
  const anchorX = west ? rect.x + rect.width : rect.x, anchorY = north ? rect.y + rect.height : rect.y;
  const maxWidth = Math.max(rect.width, west ? anchorX : bounds.width - anchorX), maxHeight = Math.max(rect.height, north ? anchorY : bounds.height - anchorY);
  let width = rect.width + (west ? -dx : east ? dx : 0), height = rect.height + (north ? -dy : south ? dy : 0);
  if (preserveRatio && (west || east) && (north || south)) {
    const sx = width / rect.width, sy = height / rect.height;
    const requested = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    const maximum = Math.min(maxWidth / rect.width, maxHeight / rect.height);
    const min = Math.min(maximum, Math.max(minimum / rect.width, minimum / rect.height));
    const factor = clamp(requested, min, maximum);
    width = rect.width * factor; height = rect.height * factor;
  } else {
    if (west || east) width = clamp(width, Math.min(minimum, maxWidth), maxWidth);
    if (north || south) height = clamp(height, Math.min(minimum, maxHeight), maxHeight);
  }
  return { x: west ? anchorX - width : rect.x, y: north ? anchorY - height : rect.y, width, height };
}

export function sameObjectRect(a: TextRect, b: TextRect): boolean {
  return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < .01);
}

export function objectBounds(rects: TextRect[]): TextRect {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}
export type ObjectAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'horizontal' | 'vertical';
export function alignObjectRects(rects: TextRect[], action: ObjectAlignment): TextRect[] {
  if (rects.length < 2) return rects;
  const box = objectBounds(rects);
  if (action === 'horizontal' || action === 'vertical') {
    if (rects.length < 3) return rects;
    const horizontal = action === 'horizontal', position = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    const sorted = rects.map((rect, index) => ({ rect, index })).sort((a, b) => a.rect[position] - b.rect[position]);
    const gap = (box[size] - rects.reduce((sum, rect) => sum + rect[size], 0)) / (rects.length - 1);
    let cursor = box[position]; const result = [...rects];
    for (const { rect, index } of sorted) { result[index] = { ...rect, [position]: cursor }; cursor += rect[size] + gap; }
    return result;
  }
  return rects.map(rect => ({ ...rect,
    x: action === 'left' ? box.x : action === 'right' ? box.x + box.width - rect.width : action === 'center' ? box.x + (box.width - rect.width) / 2 : rect.x,
    y: action === 'top' ? box.y : action === 'bottom' ? box.y + box.height - rect.height : action === 'middle' ? box.y + (box.height - rect.height) / 2 : rect.y,
  }));
}
export function snapObjectRect(rect: TextRect, others: TextRect[], page: { width: number; height: number }, threshold = 6) {
  const axes = [
    { key: 'x' as const, size: 'width' as const, candidates: [0, page.width / 2, page.width, ...others.flatMap(box => [box.x, box.x + box.width / 2, box.x + box.width])] },
    { key: 'y' as const, size: 'height' as const, candidates: [0, page.height / 2, page.height, ...others.flatMap(box => [box.y, box.y + box.height / 2, box.y + box.height])] },
  ];
  const result = { ...rect }, guides: { axis: 'x' | 'y'; position: number }[] = [];
  for (const { key, size, candidates } of axes) {
    let nearest = threshold + .001, offset = 0, target = 0;
    for (const candidate of candidates) for (const point of [rect[key], rect[key] + rect[size] / 2, rect[key] + rect[size]]) {
      const delta = candidate - point;
      if (Math.abs(delta) < nearest && rect[key] + delta >= 0 && rect[key] + delta + rect[size] <= page[size] + .001) { nearest = Math.abs(delta); offset = delta; target = candidate; }
    }
    if (nearest <= threshold) { result[key] += offset; guides.push({ axis: key, position: target }); }
  }
  return { rect: result, guides };
}
