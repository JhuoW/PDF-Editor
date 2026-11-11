import { AnnotationFlags, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, type PDFDocument, type PDFPage, type PDFRef, type PDFObject } from 'pdf-lib';
import type { Annotation } from './types';

type EditableAnnotation = Exclude<Annotation, { type: 'sticky-note' }>;
const subtypes: Record<EditableAnnotation['type'], string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', ink: 'Ink', rectangle: 'Square', ellipse: 'Circle',
  line: 'Line', arrow: 'Line', freetext: 'FreeText', image: 'Stamp', stamp: 'Stamp',
};
const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
const finite = (values: unknown): values is number[] => Array.isArray(values) && values.every(value => typeof value === 'number' && Number.isFinite(value));
export function annotationBounds(annotation: EditableAnnotation): [number, number, number, number] {
  let bounds: number[];
  if ('rect' in annotation) {
    const [x, y, width, height] = annotation.rect;
    if (!finite(annotation.rect) || width <= 0 || height <= 0) throw new Error('Annotation dimensions must be finite positive numbers');
    const angle = ('rotation' in annotation ? annotation.rotation ?? 0 : 0) * Math.PI / 180;
    if (!Number.isFinite(angle)) throw new Error('Annotation rotation is invalid');
    const w = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle)), h = Math.abs(height * Math.cos(angle)) + Math.abs(width * Math.sin(angle));
    bounds = [x + width / 2 - w / 2, y + height / 2 - h / 2, x + width / 2 + w / 2, y + height / 2 + h / 2];
  } else {
    const points = 'quadPoints' in annotation ? annotation.quadPoints.flatMap(quad => Array.from({ length: 4 }, (_, index) => quad.slice(index * 2, index * 2 + 2)))
      : annotation.type === 'ink' ? annotation.paths.flat() : [annotation.start, annotation.end];
    if (!points.length || points.some(point => !finite(point) || point.length !== 2)) throw new Error('Annotation geometry is invalid');
    bounds = [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
  }
  const stroke = 'strokeWidth' in annotation ? annotation.strokeWidth : annotation.type === 'freetext' ? annotation.boxStyle?.borderWidth ?? annotation.style?.borderWidth ?? 0 : 'borderWidth' in annotation ? annotation.borderWidth : 0;
  const margin = Math.max(.5, stroke / 2, annotation.type === 'arrow' ? 12 : 0);
  return [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
const boundKeys = ['Subtype', 'Rect', 'Contents', 'C', 'CA', 'BS', 'IC', 'QuadPoints', 'InkList', 'L', 'LE', 'DA', 'Q', 'F', 'Name'];
async function fingerprint(dictionary: PDFDict) {
  const ap = dictionary.lookup(PDFName.of('AP'));
  const normal = ap instanceof PDFDict ? ap.lookup(PDFName.of('N')) : undefined;
  if (!(normal instanceof PDFRawStream)) throw new Error('Missing annotation appearance');
  // Include the appearance bytes and all native editing fields. If another editor
  // or redaction changed them, stale workspace metadata must not revive old content.
  // Appearance content often lives in nested Form XObjects. Bind their resources
  // too: hashing only `/Fm1 Do` would miss externally replaced/redacted glyphs.
  const seen = new Map<PDFObject, number>();
  let totalBytes = 0;
  async function resource(object: PDFObject): Promise<unknown> {
    const resolved = dictionary.context.lookup(object);
    if (!resolved) return null;
    if (!(resolved instanceof PDFRawStream) && !(resolved instanceof PDFDict) && !(resolved instanceof PDFArray)) return resolved.toString();
    if (seen.has(resolved)) return ['ref', seen.get(resolved)];
    if (seen.size > 4096) throw new Error('Annotation appearance is too complex');
    seen.set(resolved, seen.size);
    if (resolved instanceof PDFRawStream) {
      totalBytes += resolved.contents.length;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('Annotation appearance is too large');
      const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(resolved.contents));
      return [await resource(resolved.dict), Array.from(new Uint8Array(hash)).join(',')];
    }
    if (resolved instanceof PDFDict) {
      const entries = [];
      for (const [key, value] of resolved.entries().filter(([key]) => key !== PDFName.of('Length')).sort(([a], [b]) => a.toString().localeCompare(b.toString()))) entries.push([key.toString(), await resource(value)]);
      return entries;
    }
    if (resolved instanceof PDFArray) {
      const entries = [];
      for (const value of resolved.asArray()) entries.push(await resource(value));
      return entries;
    }
    return null;
  }
  const graph = await resource(normal);
  return digest(JSON.stringify([boundKeys.map(key => dictionary.lookup(PDFName.of(key))?.toString() ?? null), graph]));
}
export async function addNativeAnnotation(document: PDFDocument, page: PDFPage, annotation: EditableAnnotation, appearance: PDFRef, bounds: number[]) {
  const color = rgb('strokeColor' in annotation ? annotation.strokeColor : annotation.color);
  const dictionary = document.context.obj({ Type: 'Annot', Subtype: subtypes[annotation.type], Rect: bounds, P: page.ref,
    F: AnnotationFlags.Print, C: color, CA: annotation.opacity, NM: PDFHexString.fromText(annotation.id),
    CreationDate: PDFString.fromDate(new Date(annotation.createdAt)), M: PDFString.fromDate(new Date(annotation.modifiedAt)),
    AP: { N: appearance }, ...(annotation.author ? { T: PDFHexString.fromText(annotation.author) } : {}),
  });
  if ('content' in annotation) dictionary.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.content));
  if ('selectedText' in annotation && annotation.selectedText) dictionary.set(PDFName.of('Contents'), PDFHexString.fromText(annotation.selectedText));
  if ('quadPoints' in annotation) dictionary.set(PDFName.of('QuadPoints'), document.context.obj(annotation.quadPoints.flat()));
  if (annotation.type === 'ink') dictionary.set(PDFName.of('InkList'), document.context.obj(annotation.paths.map(path => path.flat())));
  if ('strokeWidth' in annotation) dictionary.set(PDFName.of('BS'), document.context.obj({ W: annotation.strokeWidth, S: 'S' }));
  if ('fillColor' in annotation && annotation.fillColor) dictionary.set(PDFName.of('IC'), document.context.obj(rgb(annotation.fillColor)));
  if ('start' in annotation) {
    dictionary.set(PDFName.of('L'), document.context.obj([...annotation.start, ...annotation.end]));
    dictionary.set(PDFName.of('LE'), document.context.obj([annotation.startArrow ? 'OpenArrow' : 'None', annotation.type === 'arrow' || annotation.endArrow ? 'OpenArrow' : 'None']));
  }
  if (annotation.type === 'freetext') {
    dictionary.set(PDFName.of('DA'), PDFString.of(`/Helvetica ${annotation.style.fontSize} Tf ${rgb(annotation.style.color).join(' ')} rg`));
    dictionary.set(PDFName.of('Q'), PDFNumber.of(annotation.style.textAlign === 'center' ? 1 : annotation.style.textAlign === 'right' ? 2 : 0));
  }
  if (annotation.type === 'image' || annotation.type === 'stamp') dictionary.set(PDFName.of('Name'), PDFName.of('Draft'));
  // pdf-lib defers image/font embedding until flush; all referenced resources
  // must exist before computing the appearance integrity check.
  await document.flush();
  const payload = JSON.stringify({ version: 1, annotation });
  dictionary.set(PDFName.of('PDFEditorData'), PDFHexString.fromText(payload));
  dictionary.set(PDFName.of('PDFEditorDigest'), PDFHexString.fromText(await digest(payload + await fingerprint(dictionary))));
  page.node.addAnnot(document.context.register(dictionary));
}

/** Only our validated, unchanged appearances are promoted to editable overlays. */
export async function readNativeAnnotation(dictionary: PDFDict, pageNumber: number): Promise<Annotation | null> {
  const data = dictionary.lookup(PDFName.of('PDFEditorData')), signature = dictionary.lookup(PDFName.of('PDFEditorDigest'));
  if (!(data instanceof PDFHexString) || !(signature instanceof PDFHexString)) return null;
  try {
    const payload = data.decodeText();
    if (payload.length > 48 * 1024 * 1024 || signature.decodeText() !== await digest(payload + await fingerprint(dictionary))) return null;
    const parsed = JSON.parse(payload);
    if (parsed.version !== 1) return null;
    const annotation = parsed.annotation as EditableAnnotation;
    if (!annotation || !(annotation.type in subtypes) || typeof annotation.id !== 'string' || !annotation.id
      || typeof annotation.opacity !== 'number' || !Number.isFinite(annotation.opacity) || annotation.opacity < 0 || annotation.opacity > 1
      || typeof annotation.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(annotation.color)
      || dictionary.lookup(PDFName.of('Subtype')) !== PDFName.of(subtypes[annotation.type])) return null;
    if (!Number.isFinite(Date.parse(String(annotation.createdAt))) || !Number.isFinite(Date.parse(String(annotation.modifiedAt)))) return null;
    if (!validMetadata(annotation)) return null;
    annotationBounds(annotation);
    if (annotation.type === 'freetext') {
      if (typeof annotation.content !== 'string' || annotation.content.length > 80_000 || !annotation.style || !Number.isFinite(annotation.style.fontSize)) return null;
      // Rebuild editable HTML from the typed segments. Never inject serialized HTML.
      delete annotation.htmlContent;
      if (annotation.richContent && (!Array.isArray(annotation.richContent) || annotation.richContent.some(segment => typeof segment.text !== 'string' || !segment.style)
        || annotation.richContent.map(segment => segment.text).join('') !== annotation.content)) return null;
    }
    return { ...annotation, id: crypto.randomUUID(), pageNumber, createdAt: new Date(annotation.createdAt), modifiedAt: new Date(annotation.modifiedAt) };
  } catch { return null; }
}

/** Native shapes from other producers stay intact unless their exact style is supported. */
export function isNativeAnnotationShared(dictionary: PDFDict, occurrences: Map<PDFDict, number>) {
  return occurrences.get(dictionary) !== 1 || dictionary.has(PDFName.of('IRT')) || dictionary.has(PDFName.of('Popup'));
}

// Metadata is untrusted document input, even when its appearance checksum matches.
// Only admit the scalar fields our controls and HTML builder can safely consume.
const color = (value: unknown, transparent = false) => typeof value === 'string' && (/^#[0-9a-f]{6}$/i.test(value) || transparent && value === 'transparent');
const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const enumeration = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
function validTextStyle(style: unknown): boolean {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return false;
  for (const [key, value] of Object.entries(style)) {
    if (key === 'fontFamily' && !(typeof value === 'string' && /^[\p{L}\p{N} _.,-]{1,160}$/u.test(value))) return false;
    if (key === 'fontSize' && !number(value, .1, 1000)) return false;
    if (key === 'lineHeight' && !number(value, .1, 20)) return false;
    if (key === 'letterSpacing' && !number(value, -100, 1000)) return false;
    if (key === 'borderWidth' && !number(value, 0, 1000)) return false;
    if (['color', 'borderColor', 'highlightColor'].includes(key) && !color(value)) return false;
    if (key === 'backgroundColor' && !color(value, true)) return false;
    const allowed: Record<string, string[]> = { fontWeight: ['normal', 'bold'], fontStyle: ['normal', 'italic'], textDecoration: ['none', 'underline', 'line-through'], textAlign: ['left', 'center', 'right', 'justify'], verticalAlign: ['top', 'middle', 'bottom'] };
    if (key in allowed && !enumeration(value, allowed[key])) return false;
    if (!['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'borderWidth', 'color', 'borderColor', 'backgroundColor', 'highlightColor', ...Object.keys(allowed)].includes(key)) return false;
  }
  return true;
}
function validMetadata(annotation: EditableAnnotation): boolean {
  if ('zIndex' in annotation && !number(annotation.zIndex, -1_000_000, 1_000_000)) return false;
  if ('strokeWidth' in annotation && !number(annotation.strokeWidth, 0, 1000)) return false;
  if ('strokeColor' in annotation && !color(annotation.strokeColor)) return false;
  if ('fillColor' in annotation && annotation.fillColor !== undefined && !color(annotation.fillColor, true)) return false;
  if ('rect' in annotation && (!finite(annotation.rect) || annotation.rect.length !== 4 || annotation.rect.some(value => Math.abs(value) > 1_000_000))) return false;
  if ('quadPoints' in annotation && (!Array.isArray(annotation.quadPoints) || annotation.quadPoints.length > 20_000 || annotation.quadPoints.some(quad => !finite(quad) || quad.length !== 8))) return false;
  if (annotation.type === 'ink' && (!Array.isArray(annotation.paths) || annotation.paths.flat().length > 200_000)) return false;
  if (annotation.type === 'freetext') {
    if (!validTextStyle(annotation.style) || !number(annotation.style.fontSize, .1, 1000)) return false;
    if (annotation.richContent && (!Array.isArray(annotation.richContent) || annotation.richContent.length > 20_000 || annotation.richContent.some(segment => !validTextStyle(segment.style)))) return false;
    if (annotation.boxStyle) {
      const box = annotation.boxStyle;
      if (!color(box.backgroundColor, true) || !color(box.borderColor) || !number(box.backgroundOpacity, 0, 1) || !number(box.borderWidth, 0, 1000)
        || !number(box.borderRadius, 0, 14_400) || !enumeration(box.borderStyle, ['solid', 'dashed', 'dotted', 'none'])
        || !box.padding || !['top', 'right', 'bottom', 'left'].every(key => number(box.padding[key as keyof typeof box.padding], 0, 14_400))) return false;
    }
  }
  if (annotation.type === 'image' || annotation.type === 'stamp' && annotation.stampType === 'custom') {
    const data = annotation.type === 'image' ? annotation.imageData : annotation.customImageData;
    if (typeof data !== 'string' || !/^data:image\/(png|jpeg);base64,[a-z0-9+/=\s]+$/i.test(data)) return false;
  }
  if (annotation.type === 'image') {
    if (!number(annotation.originalWidth, 1, 1_000_000) || !number(annotation.originalHeight, 1, 1_000_000)
      || !number(annotation.borderWidth, 0, 1000) || !number(annotation.borderRadius, 0, 14_400) || !color(annotation.borderColor)
      || !enumeration(annotation.borderStyle, ['solid', 'dashed', 'dotted', 'none'])) return false;
    if (annotation.cropBounds && (!['top', 'right', 'bottom', 'left'].every(key => number(annotation.cropBounds![key as keyof typeof annotation.cropBounds], 0, 100))
      || annotation.cropBounds.top + annotation.cropBounds.bottom >= 100 || annotation.cropBounds.left + annotation.cropBounds.right >= 100)) return false;
  }
  return true;
}
