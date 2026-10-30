import type { PageViewport } from 'pdfjs-dist';
import type { PageCropRect } from '../../store/pageCropStore';
import { mapViewportRect } from '../../utils/viewportMapping';

type CropViewport = Pick<PageViewport, 'width' | 'height' | 'convertToPdfPoint' | 'convertToViewportPoint'>;
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
export function normalizePageCrop(rect: PageCropRect, viewport: { width: number; height: number }): PageCropRect {
  const left = clamp(rect.x, viewport.width), top = clamp(rect.y, viewport.height);
  return { x: left / viewport.width, y: top / viewport.height,
    width: Math.max(0, clamp(rect.x + rect.width, viewport.width) - left) / viewport.width,
    height: Math.max(0, clamp(rect.y + rect.height, viewport.height) - top) / viewport.height };
}
export function displayPageCrop(rect: PageCropRect, native: CropViewport, display: CropViewport): PageCropRect {
  return mapViewportRect({ x: rect.x * native.width, y: rect.y * native.height, width: rect.width * native.width, height: rect.height * native.height }, native, display);
}
export function capturePageCrop(rect: PageCropRect, display: CropViewport, native: CropViewport): PageCropRect {
  return normalizePageCrop(mapViewportRect(rect, display, native), native);
}
export function pageCropMargins(rect: PageCropRect, native: { width: number; height: number }) {
  return { top: Math.max(0, rect.y * native.height), right: Math.max(0, (1 - rect.x - rect.width) * native.width),
    bottom: Math.max(0, (1 - rect.y - rect.height) * native.height), left: Math.max(0, rect.x * native.width) };
}
