import type { TextRect } from './types';

export type ObjectResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const OBJECT_RESIZE_HANDLES: ObjectResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Geometry is measured in display-page pixels; viewport conversion handles page rotation. */
export function moveObjectRect(rect: TextRect, dx: number, dy: number, bounds: { width: number; height: number }): TextRect {
  return { ...rect, x: clamp(rect.x + dx, 0, Math.max(0, bounds.width - rect.width)), y: clamp(rect.y + dy, 0, Math.max(0, bounds.height - rect.height)) };
}

/** Keep the opposite edge/corner fixed, without flipping an object through its anchor. */
export function resizeObjectRect(rect: TextRect, handle: ObjectResizeHandle, dx: number, dy: number, bounds: { width: number; height: number }, preserveRatio: boolean, minimum = 4): TextRect {
  const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
  const anchorX = west ? rect.x + rect.width : rect.x, anchorY = north ? rect.y + rect.height : rect.y;
  const maxWidth = west ? anchorX : Math.max(0, bounds.width - anchorX), maxHeight = north ? anchorY : Math.max(0, bounds.height - anchorY);
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
