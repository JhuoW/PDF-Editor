import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { IMAGE_LIMITS } from './ImagePDF';
import { PAGE_DECORATION_MARKERS as MARK, decorationInstanceFromTag } from './PageDecorationMarkers';
import type { DecorationLayer, ManagedPageDecoration, PageDecorationDefinition, PageDecorationInspection } from './PageDecorationTypes';

export interface DecorationManifest {
  version: 1;
  id: string;
  instanceId: string;
  ordinal: number;
  sourcePage: number;
  totalPages: number;
  width: number;
  height: number;
  pageTransform?: number[];
  pageBounds?: number[];
  definition: PageDecorationDefinition;
  layer: DecorationLayer;
  visualBounds: { x: number; y: number; width: number; height: number };
  resources: Array<{ name: string; hash: string; imageResourceName?: string }>;
  gsName: string;
  bodyHash: string;
}
export interface DecorationNativeRecord {
  pageNumber: number;
  streamRef: number;
  manifest: DecorationManifest;
  reason?: string;
  /** Native image content identity, independent of wrapper placement and object IDs. */
  imageHash?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resourceName = /^PDE_[a-zA-Z0-9_]+$/;
export const validDecorationId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export const readString = (object: PDFObject, name: string): string | undefined => {
  const value = object.get(name);
  try { return value.isString() ? value.asString() : undefined; }
  finally { value.destroy(); }
};
export const streamBytes = (stream: PDFObject) => {
  const buffer = stream.readStream();
  try { return new Uint8Array(buffer.asUint8Array()); }
  finally { buffer.destroy(); }
};
export async function decorationHash(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Hash decoded streams/resources independently of PDF object renumbering. */
export function resourceHasher() {
  const cache = new Map<number, Promise<string>>();
  const hash = async (object: PDFObject, ancestors = new Set<number>()): Promise<string> => {
    const ref = object.isIndirect() ? object.asIndirect() : 0;
    if (ref && ancestors.has(ref)) throw new Error('Circular decoration resources cannot be managed safely.');
    if (ref && cache.has(ref)) return cache.get(ref)!;
    const next = new Set(ancestors); if (ref) next.add(ref);
    const pending = (async () => {
      if (object.isArray()) {
        const parts: string[] = [];
        for (let index = 0; index < object.length; index++) {
          const child = object.get(index); try { parts.push(await hash(child, next)); } finally { child.destroy(); }
        }
        return decorationHash(`array:${parts.join(':')}`);
      }
      if (object.isDictionary()) {
        const names: string[] = [];
        object.forEach((value, name) => { value.destroy(); if (typeof name === 'string' && !['Length', 'Filter', 'DecodeParms'].includes(name) && !name.startsWith('PDFEditorDecoration')) names.push(name); });
        const parts: string[] = [];
        for (const name of names.sort()) {
          const child = object.get(name); try { parts.push(`${JSON.stringify(name)}:${await hash(child, next)}`); } finally { child.destroy(); }
        }
        const content = object.isStream() ? await decorationHash(streamBytes(object)) : '';
        return decorationHash(`dict:${parts.join('|')}:stream:${content}`);
      }
      // Canonical primitive values, not literal-vs-hex PDF serialization.
      return decorationHash(object.isString() ? `string:${object.asString()}` : object.isName() ? `name:${object.asName()}` : object.isNumber() ? `number:${object.asNumber()}` : object.toString());
    })();
    if (ref) cache.set(ref, pending);
    return pending;
  };
  return hash;
}

export function serializeDefinition(definition: PageDecorationDefinition) {
  return JSON.stringify(definition, (name, value) => name === 'data' ? undefined : value);
}
function validDefinition(value: PageDecorationDefinition): boolean {
  const numeric = (number: unknown, low: number, high: number, integer = false) => typeof number === 'number' && Number.isFinite(number) && number >= low && number <= high && (!integer || Number.isInteger(number));
  const color = (color: unknown) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
  const text = (text: unknown, single = false) => typeof text === 'string' && Array.from(text).length <= 4096 && text.split(/\r\n?|\n/).length <= (single ? 1 : 50);
  const font = (family: unknown, size: unknown) => ['Helvetica', 'Times', 'Courier'].includes(String(family)) && numeric(size, 1, 500);
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || value.name.length > 200 || !Array.isArray(value.pages) || !value.pages.length || value.pages.some(page => !numeric(page, 1, Number.MAX_SAFE_INTEGER, true)) || new Set(value.pages).size !== value.pages.length || !numeric(value.opacity, 0, 1)) return false;
  if (value.kind !== 'background' && !['foreground', 'background'].includes(value.layer)) return false;
  if (value.kind === 'watermark') {
    if (!numeric(value.angle, -360, 360) || !value.position || !['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(value.position.anchor) || !numeric(value.position.offsetX, -14400, 14400) || !numeric(value.position.offsetY, -14400, 14400) || !value.content) return false;
    return value.content.type === 'text' ? text(value.content.text) && !!value.content.text.trim() && font(value.content.fontFamily, value.content.fontSize) && color(value.content.color)
      : value.content.type === 'image' && typeof value.content.name === 'string' && !Object.hasOwn(value.content, 'data') && numeric(value.content.width, 1, 14400) && numeric(value.content.height, 1, 14400);
  }
  if (value.kind === 'background') return !!value.fill && (value.fill.type === 'color' ? color(value.fill.color) : value.fill.type === 'image' && typeof value.fill.name === 'string' && !Object.hasOwn(value.fill, 'data') && ['contain', 'cover', 'stretch'].includes(value.fill.fit));
  if (value.kind !== 'header-footer' || !value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots) || !value.bates || !font(value.fontFamily, value.fontSize) || !color(value.color)) return false;
  return Object.entries(value.slots).every(([slot, content]) => ['headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight'].includes(slot) && text(content, true))
    && Object.values(value.slots).some(content => content?.trim()) && numeric(value.marginX, 0, 14400) && numeric(value.marginTop, 0, 14400) && numeric(value.marginBottom, 0, 14400)
    && numeric(value.pageNumberStart, 0, 999999999, true) && numeric(value.bates.start, 0, 999999999, true) && numeric(value.bates.digits, 1, 16, true) && text(value.bates.prefix, true) && text(value.bates.suffix, true);
}
function manifestFrom(value: string): DecorationManifest {
  if (value.length > 200_000) throw new Error('Decoration metadata is too large.');
  const parsed = JSON.parse(value) as DecorationManifest;
  if (parsed.version !== 1 || !validDecorationId(parsed.id) || !validDecorationId(parsed.instanceId)
    || !Number.isInteger(parsed.ordinal) || parsed.ordinal < 0 || !Number.isInteger(parsed.sourcePage) || parsed.sourcePage < 1 || !Number.isInteger(parsed.totalPages) || parsed.totalPages < 1
    || ![parsed.width, parsed.height].every(value => Number.isFinite(value) && value > 0)
    || !validDefinition(parsed.definition)
    || (parsed.pageTransform !== undefined && (!Array.isArray(parsed.pageTransform) || parsed.pageTransform.length !== 6 || !parsed.pageTransform.every(Number.isFinite) || Math.abs(parsed.pageTransform[0] * parsed.pageTransform[3] - parsed.pageTransform[1] * parsed.pageTransform[2]) < 1e-12))
    || (parsed.pageBounds !== undefined && (!Array.isArray(parsed.pageBounds) || parsed.pageBounds.length !== 4 || !parsed.pageBounds.every(Number.isFinite)))
    || !parsed.visualBounds || ![parsed.visualBounds.x, parsed.visualBounds.y, parsed.visualBounds.width, parsed.visualBounds.height].every(Number.isFinite) || parsed.visualBounds.width <= 0 || parsed.visualBounds.height <= 0
    || !['foreground', 'background'].includes(parsed.layer) || !Array.isArray(parsed.resources) || parsed.resources.length < 1 || parsed.resources.length > 6
    || parsed.resources.some(resource => !resourceName.test(resource.name) || !/^[0-9a-f]{64}$/.test(resource.hash) || (resource.imageResourceName !== undefined && !/^[a-zA-Z0-9_]+$/.test(resource.imageResourceName)))
    || !resourceName.test(parsed.gsName) || !/^[0-9a-f]{64}$/.test(parsed.bodyHash)) throw new Error('Decoration metadata is invalid or from an unsupported version.');
  return parsed;
}

/** PDF names can contain #xx escapes. Skip strings/comments, then decode name tokens.
 * Inline-image bytes are scanned conservatively: ambiguity can only make a mark
 * unavailable, never permit deletion of another stream's referenced resource. */
function contentNames(body: string): Set<string> {
  const result = new Set<string>(), delimiter = new Set('\0\t\n\f\r ()<>[]{}/%');
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '%') { while (index < body.length && !/[\r\n]/.test(body[index])) index++; }
    else if (body[index] === '(') {
      let depth = 1;
      while (depth && ++index < body.length) { if (body[index] === '\\') index++; else if (body[index] === '(') depth++; else if (body[index] === ')') depth--; }
    } else if (body[index] === '<' && body[index + 1] !== '<') { while (++index < body.length && body[index] !== '>') { /* hexadecimal string */ } }
    else if (body[index] === '<' && body[index + 1] === '<') index++;
    else if (body[index] === '/') {
      const start = ++index; while (index < body.length && !delimiter.has(body[index])) index++;
      result.add(body.slice(start, index).replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))); index--;
    }
  }
  return result;
}

/** A Form without Resources can borrow this page's complete resource scope.
 * Scan every such Form in the scope, including otherwise-unused ones: nested
 * calls with inherited resources resolve against this same finite XObject map,
 * so this also covers chains/cycles without executing untrusted PDF content. */
function inheritedFormNames(forms: PDFObject): Set<string> {
  const names = new Set<string>();
  forms.forEach(form => {
    const subtype = form.get('Subtype'), resources = form.get('Resources');
    try {
      if (subtype.asName() !== 'Form') return;
      if (!resources.isNull()) {
        if (!resources.isDictionary()) throw new Error('An external Form has an unsupported resource scope; decoration isolation cannot be verified.');
        return;
      }
      if (!form.isStream()) throw new Error('An external Form content stream is missing; decoration isolation cannot be verified.');
      for (const name of contentNames(new TextDecoder().decode(streamBytes(form)))) names.add(name);
    } finally { resources.destroy(); subtype.destroy(); form.destroy(); }
  });
  return names;
}

export function pageContentObjects(page: PDFObject): PDFObject[] {
  const contents = page.get('Contents');
  if (contents.isArray()) {
    const result = Array.from({ length: contents.length }, (_, index) => contents.get(index)); contents.destroy(); return result;
  }
  if (contents.isNull()) { contents.destroy(); return []; }
  return [contents];
}
function unavailable(id: string, pageNumber: number): ManagedPageDecoration {
  return { id, pages: [pageNumber], managed: false, reason: 'This decoration no longer has an intact, isolated content stream and cannot be changed safely.', needsRefresh: true, placements: [],
    definition: { kind: 'watermark', name: 'Unmanaged decoration', pages: [pageNumber], opacity: 1, layer: 'foreground', angle: 0, position: { anchor: 'center', offsetX: 0, offsetY: 0 }, content: { type: 'text', text: '', fontFamily: 'Helvetica', fontSize: 36, color: '#000000' } } };
}

export function decorationDocumentRestriction(document: PDFDocument): string | undefined {
  if (document.needsPassword()) return 'Unlock this PDF before managing page decorations.';
  if (document.wasRepaired()) return 'This PDF is damaged and cannot be safely updated with page decorations.';
  const trailer = document.getTrailer(), certification = trailer.get('Root', 'Perms', 'DocMDP'), xfa = trailer.get('Root', 'AcroForm', 'XFA');
  try { if (!certification.isNull()) return 'Signed or certified PDFs cannot be changed with page decorations.'; if (!xfa.isNull()) return 'XFA forms cannot be changed with page decorations.'; }
  finally { xfa.destroy(); certification.destroy(); trailer.destroy(); }
  // Full rewrites legitimately leave free xref slots. Walk only reachable objects;
  // resolving every integer up to countObjects emits false damaged-file warnings.
  const seen = new Set<number>();
  const signed = (object: PDFObject, depth = 0): boolean => {
    if (depth > 512) throw new Error('This PDF object graph is too deeply nested to validate safely.');
    if (object.isIndirect()) { const ref = object.asIndirect(); if (seen.has(ref)) return false; seen.add(ref); }
    if (object.isDictionary()) {
      const bytes = object.get('ByteRange'), type = object.get('FT'), value = object.get('V');
      try { if (!bytes.isNull() || (type.asName() === 'Sig' && !value.isNull())) return true; }
      finally { value.destroy(); type.destroy(); bytes.destroy(); }
    }
    let found = false;
    if (object.isDictionary() || object.isArray()) object.forEach(child => { try { if (!found) found = signed(child, depth + 1); } finally { child.destroy(); } });
    return found;
  };
  const root = document.getTrailer();
  try { if (signed(root)) return 'Signed or certified PDFs cannot be changed with page decorations.'; }
  finally { root.destroy(); }
  if (document.wasRepaired()) return 'This PDF is damaged and cannot be safely updated with page decorations.';
  return undefined;
}

/** Only current Contents wrappers are authoritative. Resource tags are hints for unmanaged marks. */
export async function inspectDecorationDocument(document: PDFDocument): Promise<{ inspection: PageDecorationInspection; records: DecorationNativeRecord[] }> {
  const pages: PageDecorationInspection['pages'] = [], records: DecorationNativeRecord[] = [], geometries: Array<{ transform: number[]; bounds: number[] }> = [];
  const unmanaged = new Map<string, ManagedPageDecoration>();
  const hash = resourceHasher(), imageCache = new Map<number, Uint8Array>();
  const engine = await loadMuPDF();
  for (let pageIndex = 0; pageIndex < document.countPages(); pageIndex++) {
    const pageNumber = pageIndex + 1, page = document.loadPage(pageIndex), object = page.getObject();
    const bounds = page.getBounds(), width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
    pages.push({ pageNumber, width, height });
    geometries.push({ transform: [...page.getTransform()], bounds: [...bounds] });
    const contents = pageContentObjects(object), resources = object.getInheritable('Resources'), forms = resources.get('XObject');
    const bodies = contents.map(content => { try { return content.isStream() ? new TextDecoder().decode(streamBytes(content)) : ''; } catch { return ''; } });
    const names = bodies.map(contentNames);
    try {
      const inheritedNames = inheritedFormNames(forms);
      for (const [contentIndex, stream] of contents.entries()) {
        const raw = readString(stream, MARK.manifest);
        if (!raw) continue;
        let manifest: DecorationManifest;
        try { manifest = manifestFrom(raw); }
        catch (error) {
          const id = `unmanaged-${pageNumber}-${stream.asIndirect()}`;
          unmanaged.set(id, { ...unavailable(id, pageNumber), reason: error instanceof Error ? error.message : 'Invalid decoration metadata.' });
          continue;
        }
        const record: DecorationNativeRecord = { pageNumber, streamRef: stream.asIndirect(), manifest };
        records.push(record);
        try {
          if (!stream.isStream() || !stream.isIndirect() || await decorationHash(streamBytes(stream)) !== manifest.bodyHash) throw new Error('The decoration content stream has changed outside the manager.');
          const tag = `/${MARK.contentTagPrefix}${manifest.instanceId} BMC`;
          if (!bodies[contentIndex].includes(tag)) throw new Error('The decoration content marker is missing.');
          const gs = resources.get('ExtGState', manifest.gsName), alpha = gs.get('ca'), strokeAlpha = gs.get('CA');
          try {
            if (!gs.isDictionary() || !alpha.isNumber() || !strokeAlpha.isNumber() || !Number.isFinite(manifest.definition.opacity) || Math.abs(alpha.asNumber() - manifest.definition.opacity) > 1e-6 || Math.abs(strokeAlpha.asNumber() - manifest.definition.opacity) > 1e-6) throw new Error('The decoration opacity resource has changed.');
            if (names.some((tokens, index) => index !== contentIndex && tokens.has(manifest.gsName))) throw new Error('A decoration opacity resource is also used by other page content.');
            if (inheritedNames.has(manifest.gsName)) throw new Error('A decoration opacity resource is also used by an external Form with inherited page resources.');
            const states = resources.get('ExtGState'); let alias = false;
            try { states.forEach((other, name) => { try { if (name !== manifest.gsName && other.isIndirect() && gs.isIndirect() && other.asIndirect() === gs.asIndirect()) alias = true; } finally { other.destroy(); } }); }
            finally { states.destroy(); }
            if (alias) throw new Error('A decoration opacity resource has another resource alias.');
          }
          finally { strokeAlpha.destroy(); alpha.destroy(); gs.destroy(); }
          for (const resource of manifest.resources) {
            const form = forms.get(resource.name);
            try {
              if (!form.isStream() || readString(form, MARK.id) !== manifest.id || readString(form, MARK.instance) !== manifest.instanceId || await hash(form) !== resource.hash) throw new Error('A decoration resource has changed or is missing.');
              if (names.some((tokens, index) => index !== contentIndex && tokens.has(resource.name))) throw new Error('A decoration resource is also used by other page content.');
              if (inheritedNames.has(resource.name)) throw new Error('A decoration resource is also used by an external Form with inherited page resources.');
              let alias = false;
              forms.forEach((other, name) => { try { if (name !== resource.name && other.isIndirect() && other.asIndirect() === form.asIndirect()) alias = true; } finally { other.destroy(); } });
              if (alias) throw new Error('A decoration resource has another page resource alias and cannot be removed safely.');
              if (resource.imageResourceName) {
                const imageRef = form.get('Resources', 'XObject', resource.imageResourceName);
                try {
                  if (!imageRef.isStream()) throw new Error('The decoration image is missing.');
                  record.imageHash = await hash(imageRef);
                  let png = imageCache.get(imageRef.asIndirect());
                  if (!png) {
                    const image = document.loadImage(imageRef);
                    try {
                      if (image.getWidth() > IMAGE_LIMITS.dimension || image.getHeight() > IMAGE_LIMITS.dimension || image.getWidth() * image.getHeight() > IMAGE_LIMITS.pixelsPerFile) throw new Error('The decoration image exceeds supported dimensions.');
                      const pixmap = image.toPixmap();
                      try { const converted = pixmap.convertToColorSpace(engine.ColorSpace.DeviceRGB, true); try { png = new Uint8Array(converted.asPNG()); } finally { converted.destroy(); } }
                      finally { pixmap.destroy(); }
                    } finally { image.destroy(); }
                    imageCache.set(imageRef.asIndirect(), png);
                  }
                  if (manifest.definition.kind === 'watermark' && manifest.definition.content.type === 'image') manifest.definition.content.data = png;
                  if (manifest.definition.kind === 'background' && manifest.definition.fill.type === 'image') manifest.definition.fill.data = png;
                } finally { imageRef.destroy(); }
              }
            } finally { form.destroy(); }
          }
          if ((manifest.definition.kind === 'watermark' && manifest.definition.content.type === 'image' && !manifest.definition.content.data)
            || (manifest.definition.kind === 'background' && manifest.definition.fill.type === 'image' && !manifest.definition.fill.data)) throw new Error('The decoration image cannot be recovered safely.');
        } catch (error) { record.reason = error instanceof Error ? error.message : 'The decoration could not be verified.'; }
      }
      const known = new Set(records.filter(record => record.pageNumber === pageNumber).map(record => record.manifest.instanceId));
      forms.forEach((form, name) => {
        try {
          const id = readString(form, MARK.id), instance = readString(form, MARK.instance);
          if (!id || !instance || known.has(instance) || !names.some(tokens => tokens.has(String(name)))) return;
          known.add(instance);
          const existing = unmanaged.get(id) ?? unavailable(id, pageNumber);
          if (!existing.pages.includes(pageNumber)) existing.pages.push(pageNumber);
          unmanaged.set(id, existing);
        } finally { form.destroy(); }
      });
      // Selective privacy cleanup can remove all saved templates and dictionary
      // hints while leaving the visible BMC/BDC artwork intact. Such artwork is
      // still excluded by the content detectors and must not be silently erased
      // by a body edit merely because its ownership metadata has been removed.
      for (const tokens of names) for (const tag of tokens) {
        const instance = decorationInstanceFromTag(tag);
        if (!instance || known.has(instance)) continue;
        known.add(instance);
        const id = `unmanaged-marker-${instance}`;
        const existing = unmanaged.get(id) ?? unavailable(id, pageNumber);
        if (!existing.pages.includes(pageNumber)) existing.pages.push(pageNumber);
        existing.reason = 'The decoration editing metadata was removed or changed. Its visible content cannot be managed safely.';
        unmanaged.set(id, existing);
      }
    } finally { for (const content of contents) content.destroy(); forms.destroy(); resources.destroy(); object.destroy(); page.destroy(); }
  }
  const grouped = new Map<string, DecorationNativeRecord[]>();
  for (const record of records) grouped.set(record.manifest.id, [...(grouped.get(record.manifest.id) ?? []), record]);
  const decorations: ManagedPageDecoration[] = [];
  for (const [id, entries] of grouped) {
    entries.sort((a, b) => a.manifest.ordinal - b.manifest.ordinal);
    const first = entries[0].manifest;
    const comparable = (definition: PageDecorationDefinition) => serializeDefinition({ ...definition, pages: [] });
    const conflict = entries.some(record => comparable(record.manifest.definition) !== comparable(first.definition))
      || new Set(entries.map(record => record.imageHash)).size > 1
      || new Set(entries.map(record => record.manifest.ordinal)).size !== entries.length
      || new Set(entries.map(record => record.pageNumber)).size !== entries.length;
    const reason = unmanaged.get(id)?.reason ?? entries.find(record => record.reason)?.reason
      ?? (conflict ? 'Copied or merged decorations share an ID with conflicting instances or settings. They cannot be changed safely.' : undefined);
    const actualPages = entries.map(record => record.pageNumber);
    decorations.push({ id, definition: { ...first.definition, pages: actualPages }, pages: actualPages, managed: !reason, reason,
      needsRefresh: entries.some(record => record.pageNumber !== record.manifest.sourcePage || record.manifest.totalPages !== pages.length || record.manifest.width !== pages[record.pageNumber - 1].width || record.manifest.height !== pages[record.pageNumber - 1].height || record.manifest.ordinal !== entries.indexOf(record)
        || JSON.stringify(record.manifest.pageTransform) !== JSON.stringify(geometries[record.pageNumber - 1].transform) || JSON.stringify(record.manifest.pageBounds) !== JSON.stringify(geometries[record.pageNumber - 1].bounds)),
      placements: entries.map(record => {
        const saved = record.manifest, current = geometries[record.pageNumber - 1], old = saved.visualBounds;
        if (!saved.pageTransform || !saved.pageBounds) return { pageNumber: record.pageNumber, bounds: old };
        const changed = engine.Rect.transform([old.x + saved.pageBounds[0], old.y + saved.pageBounds[1], old.x + saved.pageBounds[0] + old.width, old.y + saved.pageBounds[1] + old.height], engine.Matrix.concat(engine.Matrix.invert(saved.pageTransform as import('mupdf').Matrix), current.transform as import('mupdf').Matrix));
        return { pageNumber: record.pageNumber, bounds: { x: changed[0] - current.bounds[0], y: changed[1] - current.bounds[1], width: changed[2] - changed[0], height: changed[3] - changed[1] } };
      }) });
    unmanaged.delete(id);
  }
  decorations.push(...unmanaged.values());
  const reason = decorationDocumentRestriction(document);
  return { inspection: { pages, decorations, canEdit: !reason, unsupportedReason: reason }, records };
}
