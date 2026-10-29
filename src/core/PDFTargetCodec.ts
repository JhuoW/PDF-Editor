import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFObject, PDFString, type PDFPage } from 'pdf-lib';
import { PDF_LINK_LIMITS as LIMIT, type PDFLinkRect, type PDFLinkTarget, type PDFLinkView } from './PDFLinkTypes';
const key = PDFName.of;
export interface Geometry { left: number; top: number; unit: number; width: number; height: number; rotation: number }
export function geometry(page: PDFPage): Geometry {
  const media = page.getMediaBox(), crop = page.getCropBox(), left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width), top = Math.min(media.y + media.height, crop.y + crop.height);
  const raw = page.node.lookup(key('UserUnit')), unit = raw === undefined ? 1 : raw instanceof PDFNumber ? raw.asNumber() : NaN;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (![left, bottom, right, top, unit].every(Number.isFinite) || right <= left || top <= bottom || unit <= 0 || unit > 75000 || ![0, 90, 180, 270].includes(rotation)) throw new Error('This PDF has ambiguous page geometry and cannot be edited safely.');
  return { left, top, unit, width: (right - left) * unit, height: (top - bottom) * unit, rotation };
}
export function number(value: PDFObject | undefined): number { if (!(value instanceof PDFNumber) || !Number.isFinite(value.asNumber())) throw new Error('The link contains an invalid numeric value.'); return value.asNumber(); }
export function rectValue(value: PDFObject | undefined, page: Geometry): PDFLinkRect {
  if (!(value instanceof PDFArray) || value.size() !== 4) throw new Error('The link has no valid rectangular hit area.');
  const [a, b, c, d] = Array.from({ length: 4 }, (_, index) => number(value.lookup(index)));
  return { x: (Math.min(a, c) - page.left) * page.unit, y: (page.top - Math.max(b, d)) * page.unit, width: Math.abs(c - a) * page.unit, height: Math.abs(d - b) * page.unit };
}
export function validRect(rect: PDFLinkRect, page: Geometry, label: string) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.x < -0.001 || rect.y < -0.001
    || rect.x + rect.width > page.width + 0.001 || rect.y + rect.height > page.height + 0.001) throw new Error(`${label} must be completely inside its visible page.`);
}
export function safeURL(raw: string, base?: string) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > LIMIT.urlCharacters || Array.from(raw).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Enter an http, https, or mailto URL of at most 4,096 characters without control characters.');
  let parsed: URL; try { parsed = new URL(raw.trim(), base); } catch { throw new Error('The link URL is invalid or its relative address has no valid document base.'); }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error(`The URL protocol ${parsed.protocol} is not supported for link editing.`);
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hostname) throw new Error('Web links need a hostname.');
  if (parsed.protocol === 'mailto:' && !parsed.pathname) throw new Error('Mail links need a recipient.');
  // PDF URI strings are ASCII; preserve existing percent escapes and delimiters.
  return Array.from(parsed.href, character => character.codePointAt(0)! > 127 ? encodeURIComponent(character) : character).join('');
}
const views = new Set<PDFLinkView>(['XYZ', 'Fit', 'FitB', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR']);
export function validateTarget(target: PDFLinkTarget, geometries: Geometry[]): PDFLinkTarget {
  if (!target || !['url', 'page'].includes(target.type)) throw new Error('Choose a URL or an internal page destination.');
  if (target.type === 'url') return { type: 'url', url: safeURL(target.url) };
  if (!Number.isInteger(target.pageNumber) || target.pageNumber < 1 || target.pageNumber > geometries.length || !views.has(target.view)) throw new Error('The link destination references an invalid page or view mode.');
  const page = geometries[target.pageNumber - 1], result: PDFLinkTarget = { type: 'page', pageNumber: target.pageNumber, view: target.view };
  const coordinate = (value: number | null | undefined, maximum: number, axis: string) => {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value) || value < -0.001 || value > maximum + 0.001) throw new Error(`Destination ${axis} must be inside the visible target page.`);
    return value;
  };
  if (['XYZ', 'FitV', 'FitBV'].includes(target.view)) result.x = coordinate(target.x, page.width, 'X');
  if (['XYZ', 'FitH', 'FitBH'].includes(target.view)) result.y = coordinate(target.y, page.height, 'Y');
  if (target.view === 'XYZ') {
    if (target.zoom !== undefined && target.zoom !== null && target.zoom !== 0 && (!Number.isFinite(target.zoom) || target.zoom < 0.01 || target.zoom > 64)) throw new Error('Destination zoom must be between 1% and 6,400%, or keep the current zoom.');
    result.zoom = target.zoom || null;
  }
  if (target.view === 'FitR') { validRect(target.rect!, page, 'The destination fit rectangle'); result.rect = { ...target.rect! }; }
  return result;
}
export function destination(array: PDFArray, pageNumber: number, geometries: Geometry[]): PDFLinkTarget {
  const view = array.lookup(1); if (!(view instanceof PDFName) || !views.has(view.decodeText() as PDFLinkView)) throw new Error('This internal destination view is not supported.');
  const mode = view.decodeText() as PDFLinkView, expected = mode === 'XYZ' ? 5 : mode === 'FitR' ? 6 : ['Fit', 'FitB'].includes(mode) ? 2 : 3;
  if (array.size() !== expected) throw new Error('The internal destination has an invalid parameter list.');
  const page = geometries[pageNumber - 1], target: PDFLinkTarget = { type: 'page', pageNumber, view: mode };
  const coordinate = (index: number, axis: 'x' | 'y') => { const value = array.lookup(index); return value === PDFNull ? null : axis === 'x' ? (number(value) - page.left) * page.unit : (page.top - number(value)) * page.unit; };
  if (mode === 'XYZ') { target.x = coordinate(2, 'x'); target.y = coordinate(3, 'y'); const zoom = array.lookup(4); target.zoom = zoom === PDFNull ? null : number(zoom); }
  if (mode === 'FitH' || mode === 'FitBH') target.y = coordinate(2, 'y');
  if (mode === 'FitV' || mode === 'FitBV') target.x = coordinate(2, 'x');
  if (mode === 'FitR') {
    const left = number(array.lookup(2)), bottom = number(array.lookup(3)), right = number(array.lookup(4)), top = number(array.lookup(5));
    if (right <= left || top <= bottom) throw new Error('The destination fit rectangle has invalid dimensions.');
    target.rect = { x: (left - page.left) * page.unit, y: (page.top - top) * page.unit, width: (right - left) * page.unit, height: (top - bottom) * page.unit };
  }
  return validateTarget(target, geometries);
}
export function nativeRect(rect: PDFLinkRect, page: Geometry) { return [page.left + rect.x / page.unit, page.top - (rect.y + rect.height) / page.unit, page.left + (rect.x + rect.width) / page.unit, page.top - rect.y / page.unit]; }
export function writeTarget(pdf: PDFDocument, annotation: PDFDict, target: PDFLinkTarget, geometries: Geometry[]) {
  annotation.delete(key('A')); annotation.delete(key('Dest'));
  if (target.type === 'url') { annotation.set(key('A'), pdf.context.register(pdf.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(target.url) }))); return; }
  const page = geometries[target.pageNumber - 1], values: Array<PDFObject | number | null> = [pdf.getPage(target.pageNumber - 1).ref, key(target.view)];
  const x = target.x == null ? null : page.left + target.x / page.unit, y = target.y == null ? null : page.top - target.y / page.unit;
  if (target.view === 'XYZ') values.push(x, y, target.zoom ?? null);
  if (target.view === 'FitH' || target.view === 'FitBH') values.push(y);
  if (target.view === 'FitV' || target.view === 'FitBV') values.push(x);
  if (target.view === 'FitR') values.push(...nativeRect(target.rect!, page));
  annotation.set(key('Dest'), pdf.context.obj(values));
}
