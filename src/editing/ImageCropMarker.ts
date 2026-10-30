import type { TextRect } from './types';
import { validImageCrop } from './imageAppearance';

const PREFIX = 'PDFEditorCrop1_';
/** A native marked-content span makes the clip travel with this one image draw. */
export function imageCropTag(crop: TextRect): string {
  return PREFIX + [crop.x, crop.y, crop.width, crop.height].map(value => Math.round(value * 1e9).toString(36)).join('_');
}
export function imageCropFromTag(tag: unknown): TextRect | undefined {
  if (tag && typeof tag === 'object' && 'name' in tag) tag = tag.name;
  if (typeof tag !== 'string' || !tag.startsWith(PREFIX)) return;
  const parts = tag.slice(PREFIX.length).split('_');
  if (parts.length !== 4 || parts.some(part => !/^[0-9a-z]{1,7}$/.test(part))) return;
  const [x, y, width, height] = parts.map(part => parseInt(part, 36) / 1e9), crop = { x, y, width, height };
  return validImageCrop(crop) ? crop : undefined;
}
