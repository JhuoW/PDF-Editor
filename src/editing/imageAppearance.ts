import type { ImageEditOperation, PDFImage, TextRect } from './types';
import { matrixBounds, multiplyMatrix, type ImageMatrix } from './imageMatrix';

export interface ImageAppearance { rect: TextRect; crop: TextRect; rotation: number; flipX: boolean; flipY: boolean; deleted: boolean }
export function imageAppearance(image: PDFImage, edits: ImageEditOperation[]): ImageAppearance {
  const result: ImageAppearance = { rect: image.rect, crop: image.source?.cropRect ?? { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, flipX: false, flipY: false, deleted: false };
  for (const edit of edits) {
    if (edit.imageId !== image.id) continue;
    if (edit.newRect) result.rect = edit.newRect;
    if (edit.cropRect) result.crop = edit.cropRect;
    if (edit.rotation !== undefined) result.rotation = edit.rotation;
    if (edit.flipX !== undefined) result.flipX = edit.flipX;
    if (edit.flipY !== undefined) result.flipY = edit.flipY;
    if (edit.type === 'delete') result.deleted = true;
    if (edit.type === 'replace') result.deleted = false;
  }
  return result;
}
export function validImageCrop(rect: TextRect): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > .000001 && rect.height > .000001
    && rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001;
}
/** Convert a top-left image crop into the PDF image's bottom-left unit square. */
export function imageCropUV(crop: TextRect): TextRect { return { ...crop, y: 1 - crop.y - crop.height }; }
export function rectMatrix(from: TextRect, to: TextRect): ImageMatrix {
  const x = to.width / from.width, y = to.height / from.height;
  return [x, 0, 0, y, to.x - from.x * x, to.y - from.y * y];
}
function bounds(matrix: ImageMatrix, rect: TextRect) {
  return matrixBounds(multiplyMatrix(matrix, [rect.width, 0, 0, rect.height, rect.x, rect.y]));
}
/** Geometry only: the original matrix retains the PDF image's intrinsic orientation. */
function baseMatrix(image: PDFImage): ImageMatrix {
  const m = image.source?.transform ?? [image.rect.width, 0, 0, image.rect.height, 0, 0];
  const original = image.source?.rawRect ?? image.originalRect;
  const native = matrixBounds(m), unit = original.width / native.width;
  const linear: ImageMatrix = [m[0] * unit, -m[1] * unit, m[2] * unit, -m[3] * unit, 0, 0];
  const box = matrixBounds(linear);
  linear[4] = original.x - box.x; linear[5] = original.y - box.y;
  return linear;
}
export function naturalImageMatrix(image: PDFImage, state: ImageAppearance, base = baseMatrix(image)): ImageMatrix {
  const angle = state.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const original = image.source?.rawRect ?? image.originalRect;
  const cx = original.x + original.width / 2, cy = original.y + original.height / 2;
  const rotate: ImageMatrix = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
  const fx = state.flipX ? -1 : 1, fy = state.flipY ? -1 : 1;
  return multiplyMatrix(rotate, multiplyMatrix([fx, 0, 0, fy, cx * (1 - fx), cy * (1 - fy)], base));
}
export function imageAppearanceMatrix(image: PDFImage, state: ImageAppearance, base?: ImageMatrix): ImageMatrix {
  const natural = naturalImageMatrix(image, state, base), crop = imageCropUV(state.crop);
  return multiplyMatrix(rectMatrix(bounds(natural, crop), state.rect), natural);
}
/** Crop preserves the remaining pixels' size and location; rotations preserve the center. */
export function changeImageAppearance(image: PDFImage, current: ImageAppearance, patch: Partial<Pick<ImageAppearance, 'rotation' | 'flipX' | 'flipY' | 'crop'>>): ImageEditOperation {
  const next = { ...current, ...patch };
  // Reflect in page coordinates after the current rotation: F R(a) = R(-a) F.
  if ((patch.flipX !== undefined && patch.flipX !== current.flipX) !== (patch.flipY !== undefined && patch.flipY !== current.flipY)) next.rotation = -current.rotation;
  let rect = { ...current.rect };
  if (patch.crop) {
    if (!validImageCrop(patch.crop)) throw new Error('The image crop must leave a nonempty area inside the original image.');
    const matrix = naturalImageMatrix(image, current);
    const before = bounds(matrix, imageCropUV(current.crop)), after = bounds(matrix, imageCropUV(patch.crop));
    const mapped = multiplyMatrix(rectMatrix(before, current.rect), [after.width, 0, 0, after.height, after.x, after.y]);
    rect = matrixBounds(mapped);
  } else if (patch.rotation !== undefined) {
    const delta = (patch.rotation - current.rotation) * Math.PI / 180;
    const width = Math.abs(Math.cos(delta)) * rect.width + Math.abs(Math.sin(delta)) * rect.height;
    const height = Math.abs(Math.sin(delta)) * rect.width + Math.abs(Math.cos(delta)) * rect.height;
    rect = { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
  }
  return { imageId: image.id, type: patch.crop ? 'crop' : patch.rotation !== undefined ? 'rotate' : 'flip', newRect: rect,
    cropRect: next.crop, rotation: ((next.rotation % 360) + 360) % 360, flipX: next.flipX, flipY: next.flipY, timestamp: Date.now() };
}
