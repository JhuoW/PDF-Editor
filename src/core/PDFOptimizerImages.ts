import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFDocument, type PDFObject } from 'pdf-lib';
import type { Image, PDFDocument as NativeDocument, PDFObject as NativeObject } from 'mupdf';
import { PDF_OPTIMIZER_LIMITS, type OptimizerControl, type OptimizerSettings } from './PDFOptimizerTypes';

type Engine = typeof import('mupdf');
interface Candidate { ref: number; width: number; height: number; components: number; stream: PDFRawStream; dictionary: string }
export interface ImageOptimizationPlan {
  imageCount: number;
  eligibleImageCount: number;
  warnings: string[];
  candidates: Candidate[];
  references: number[];
  optionalContent: boolean;
}
const key = PDFName.of;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function check(control: OptimizerControl) { control.signal?.throwIfAborted(); }
function resolved(source: PDFDocument, value: PDFObject | undefined) { return source.context.lookup(value); }
function name(dict: PDFDict, property: string) { const value = dict.lookup(key(property)); return value instanceof PDFName ? value.decodeText() : undefined; }
function integer(dict: PDFDict, property: string) { const value = dict.lookup(key(property)); return value instanceof PDFNumber ? value.asNumber() : NaN; }

/** No reference identity or unknown image semantics may be lost through deduplication. */
function canonicalDirect(value: PDFObject, depth = 0): string | undefined {
  if (depth > 12 || value instanceof PDFRef) return undefined;
  if (value instanceof PDFName) return `name:${JSON.stringify(value.decodeText())}`;
  if (value instanceof PDFNumber) return Number.isFinite(value.asNumber()) ? `number:${value.asNumber()}` : undefined;
  if (value instanceof PDFBool || value === PDFNull) return value.toString();
  if (value instanceof PDFString || value instanceof PDFHexString) return `bytes:${Array.from(value.asBytes()).join(',')}`;
  if (value instanceof PDFArray) {
    const parts = value.asArray().map(child => canonicalDirect(child, depth + 1));
    return parts.some(part => part === undefined) ? undefined : `array:[${parts.join('|')}]`;
  }
  if (value instanceof PDFDict) {
    const parts: string[] = [];
    for (const [property, child] of [...value.entries()].sort(([a], [b]) => a.decodeText().localeCompare(b.decodeText()))) {
      const encoded = canonicalDirect(child, depth + 1); if (encoded === undefined) return undefined;
      parts.push(`${JSON.stringify(property.decodeText())}:${encoded}`);
    }
    return `dict:{${parts.join('|')}}`;
  }
  return undefined;
}

export function planImageOptimization(source: PDFDocument, reachable: Map<number, PDFObject>): ImageOptimizationPlan {
  const objects = new Set<PDFObject>(), queue: PDFObject[] = [...reachable.values()];
  for (let index = 0; index < queue.length; index++) {
    const object = resolved(source, queue[index]); if (!object || objects.has(object)) continue;
    objects.add(object);
    if (object instanceof PDFRawStream) queue.push(object.dict);
    else if (object instanceof PDFArray) queue.push(...object.asArray());
    else if (object instanceof PDFDict) queue.push(...object.values());
  }
  const protectedObjects = new Map<PDFObject, string>();
  const protect = (initial: PDFObject | undefined, reason: string) => {
    const pending = initial ? [initial] : [];
    for (let index = 0; index < pending.length; index++) {
      const object = resolved(source, pending[index]); if (!object || protectedObjects.has(object)) continue;
      protectedObjects.set(object, reason);
      if (object instanceof PDFRawStream) pending.push(object.dict);
      else if (object instanceof PDFArray) pending.push(...object.asArray());
      else if (object instanceof PDFDict) pending.push(...object.values());
    }
  };
  let optionalContent = source.catalog.has(key('OCProperties'));
  for (const object of objects) if (object instanceof PDFDict) {
    if (['OCG', 'OCMD'].includes(name(object, 'Type') ?? '')) optionalContent = true;
    // Following the complete protected subtree also catches images shared with body content.
    for (const [property, reason] of [['AP', 'form or annotation appearances'], ['MK', 'widget icons'], ['Mask', 'image masks'], ['SMask', 'transparency masks'], ['EF', 'attachments'], ['Alternates', 'alternate images'], ['Thumb', 'page thumbnails']] as const) {
      protect(object.get(key(property)), reason);
    }
    if (name(object, 'Subtype') === 'Type3') protect(object, 'Type 3 font artwork');
    if (name(object, 'Type') === 'Pattern' || object.has(key('PatternType'))) protect(object, 'pattern artwork');
    if (object.keys().some(property => property.decodeText().startsWith('PDFEditorDecoration'))) protect(object, 'editable page decorations');
  }
  const candidates: Candidate[] = [], skipped = new Map<string, number>();
  let imageCount = 0;
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const allowed = new Set(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Length', 'Interpolate', 'Intent']);
  for (const [ref, object] of reachable) {
    if (!(object instanceof PDFRawStream) || name(object.dict, 'Subtype') !== 'Image') continue;
    imageCount++;
    const dict = object.dict, protectedReason = protectedObjects.get(object) ?? protectedObjects.get(dict);
    if (protectedReason) { skip(protectedReason); continue; }
    const width = integer(dict, 'Width'), height = integer(dict, 'Height');
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= PDF_OPTIMIZER_LIMITS.imageDimension)
      || width * height > PDF_OPTIMIZER_LIMITS.imagePixels) { skip('image size limits'); continue; }
    const colorspace = name(dict, 'ColorSpace'), filter = name(dict, 'Filter');
    if (!['DeviceRGB', 'DeviceGray'].includes(colorspace ?? '') || integer(dict, 'BitsPerComponent') !== 8) { skip('color spaces or bit depths requiring preservation'); continue; }
    if (dict.keys().some(property => !allowed.has(property.decodeText()))) { skip('masks, decoding instructions, or other specialized image properties'); continue; }
    if (dict.has(key('Filter')) && !['FlateDecode', 'DCTDecode'].includes(filter ?? '')) { skip('specialized image encodings'); continue; }
    const components = colorspace === 'DeviceRGB' ? 3 : 1;
    const params = dict.lookup(key('DecodeParms'));
    if (params && params !== PDFNull) {
      const bounded = params instanceof PDFDict && filter === 'FlateDecode'
        && params.entries().every(([property, value]) => value instanceof PDFNumber && Number.isInteger(value.asNumber())
          && (property.decodeText() === 'Predictor' ? [1, 2, 10, 11, 12, 13, 14, 15].includes(value.asNumber())
            : property.decodeText() === 'Colors' ? value.asNumber() === components
              : property.decodeText() === 'BitsPerComponent' ? value.asNumber() === 8
                : property.decodeText() === 'Columns' && value.asNumber() === width));
      // Omitted entries use PDF defaults (1 color/column, 8 bits, predictor 1).
      // Explicit predictor geometry must match the bounded image, even when a
      // particular predictor could ignore it; never let decoder metadata allocate unchecked rows.
      if (!bounded) { skip('specialized or inconsistent image decoder settings'); continue; }
    }
    const dictionary = canonicalDirect(dict);
    if (dictionary === undefined) { skip('indirect or specialized image properties'); continue; }
    candidates.push({ ref, width, height, components, stream: object, dictionary });
  }
  const warnings = [...skipped].map(([reason, count]) => `${count} image resource${count === 1 ? '' : 's'} kept unchanged to preserve ${reason}.`);
  if (optionalContent) warnings.push('This PDF contains optional-content layers. Image recompression is disabled so hidden layer appearances remain unchanged.');
  return { imageCount, eligibleImageCount: optionalContent ? 0 : candidates.length, warnings, candidates, references: [...reachable.keys()], optionalContent };
}

function strict<T>(engine: Engine, operation: () => T, dispose?: (value: T) => void): T {
  const diagnostics: string[] = [];
  engine.setLog(message => { if (diagnostics.length < 3) diagnostics.push(message); });
  let result: T;
  try { result = operation(); } finally { engine.setLog(null); }
  if (diagnostics.length) { dispose?.(result); throw new Error(`PDF image processing reported a problem: ${diagnostics.join('; ').slice(0, 600)}. The original PDF was preserved.`); }
  return result;
}
function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, index) => value === b[index]); }

/** Only replace references; image names and all containing dictionaries remain intact. */
function applyAliases(native: NativeDocument, references: number[], aliases: Map<number, number>) {
  if (!aliases.size) return;
  const visit = (object: NativeObject, depth = 0) => {
    if (depth > 100) throw new Error('PDF image references are nested too deeply to compress safely.');
    if (!object.isArray() && !object.isDictionary()) return;
    const changes: Array<{ property: string | number; ref: number }> = [];
    object.forEach((child, property) => {
      try {
        if (child.isIndirect()) { const replacement = aliases.get(child.asIndirect()); if (replacement !== undefined) changes.push({ property, ref: replacement }); }
        else visit(child, depth + 1);
      } finally { child.destroy(); }
    });
    for (const change of changes) { const target = native.newIndirect(change.ref); try { object.put(change.property, target); } finally { target.destroy(); } }
  };
  for (const number of references) { const object = native.newIndirect(number); try { visit(object); } finally { object.destroy(); } }
  const trailer = native.getTrailer(); try { visit(trailer); } finally { trailer.destroy(); }
}

export async function applyImageOptimization(engine: Engine, native: NativeDocument, plan: ImageOptimizationPlan, settings: OptimizerSettings, control: OptimizerControl) {
  const aliases = new Map<number, number>(), rewritten = new Set<number>(), warnings = [...plan.warnings];
  let decodedPixels = 0;
  const buckets = new Map<string, Candidate[]>();
  check(control);
  for (const candidate of plan.candidates) {
    const raw = candidate.stream.getContents();
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(raw)); check(control);
    const hash = `${candidate.dictionary}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const bucket = buckets.get(hash) ?? [], previous = bucket.find(item => sameBytes(item.stream.getContents(), raw));
    if (previous) aliases.set(candidate.ref, previous.ref);
    else { bucket.push(candidate); buckets.set(hash, bucket); }
  }
  applyAliases(native, plan.references, aliases);
  const result = () => ({ imagesOptimized: rewritten.size, imagesSkipped: plan.imageCount - rewritten.size - aliases.size, imagesDeduplicated: aliases.size, aliases, rewritten, warnings, decodedPixels });
  if (settings.mode !== 'images' || plan.optionalContent) return result();
  const candidates = plan.candidates.filter(candidate => !aliases.has(candidate.ref));
  if (!candidates.length) return result();
  const images: Array<{ candidate: Candidate; image: Image; width: number; height: number; invalid: boolean }> = [];
  const pointers = new Map<number, typeof images>();
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  try {
    // Keep image handles alive until all pages are scanned: native pointers must not be recycled.
    for (const candidate of candidates) {
      check(control);
      const ref = native.newIndirect(candidate.ref);
      try {
        const image = strict(engine, () => native.loadImage(ref), value => value.destroy());
        const entry = { candidate, image, width: 0, height: 0, invalid: false };
        images.push(entry); const entries = pointers.get(image.pointer) ?? []; entries.push(entry); pointers.set(image.pointer, entries);
      } finally { ref.destroy(); }
    }
    for (let index = 0; index < native.countPages(); index++) {
      check(control);
      strict(engine, () => {
        const page = native.loadPage(index), device = new engine.Device({ fillImage(image, matrix) {
          try {
            for (const entry of pointers.get(image.pointer) ?? []) {
              const width = Math.hypot(matrix[0], matrix[1]), height = Math.hypot(matrix[2], matrix[3]);
              if (!Number.isFinite(width) || !Number.isFinite(height)) entry.invalid = true;
              else { entry.width = Math.max(entry.width, width); entry.height = Math.max(entry.height, height); }
            }
          } finally { image.destroy(); }
        } });
        try { page.runPageContents(device, engine.Matrix.identity); device.close(); }
        finally { device.destroy(); page.destroy(); }
      });
      await pause(); check(control);
    }
    for (let index = 0; index < images.length; index++) {
      check(control);
      const { candidate, image, width, height, invalid } = images[index];
      control.onProgress?.({ phase: 'images', completed: index, total: images.length });
      check(control);
      if (invalid || width <= 0 || height <= 0) { skip('images whose complete page placement could not be established'); continue; }
      if (decodedPixels + candidate.width * candidate.height > PDF_OPTIMIZER_LIMITS.totalDecodedPixels) { skip('the browser image-decoding budget'); continue; }
      const mask = image.getMask();
      try {
        if (mask || image.getImageMask() || image.getNumberOfComponents() !== candidate.components || image.getBitsPerComponent() !== 8) { skip('unexpected image color or transparency information'); continue; }
      } finally { mask?.destroy(); }
      decodedPixels += candidate.width * candidate.height;
      strict(engine, () => {
        const original = image.toPixmap();
        let resized: ReturnType<Image['toPixmap']> | undefined;
        try {
          if (original.getAlpha() || original.getNumberOfComponents() !== candidate.components || original.getWidth() !== candidate.width || original.getHeight() !== candidate.height) {
            skip('unexpected decoded image dimensions or transparency'); return;
          }
          const ratio = Math.min(1, Math.max(width * settings.dpi / 72 / candidate.width, height * settings.dpi / 72 / candidate.height));
          const targetWidth = Math.max(1, Math.ceil(candidate.width * ratio - 1e-8)), targetHeight = Math.max(1, Math.ceil(candidate.height * ratio - 1e-8));
          if (targetWidth < candidate.width || targetHeight < candidate.height) {
            const [x0, y0, x1, y1] = original.getBounds();
            // Clockwise corners, not the crossed bottom-left/bottom-right order.
            resized = original.warp([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], targetWidth, targetHeight);
          }
          const encoded = (resized ?? original).asJPEG(settings.quality);
          if (encoded.byteLength >= candidate.stream.getContents().byteLength) { skip('images already smaller than the recompressed candidate'); return; }
          const ref = native.newIndirect(candidate.ref);
          try {
            // Preserve ColorSpace, Intent, Interpolate and every non-encoding property.
            ref.put('Width', targetWidth); ref.put('Height', targetHeight); ref.put('Filter', 'DCTDecode');
            ref.delete('DecodeParms'); ref.writeRawStream(encoded); rewritten.add(candidate.ref);
          } finally { ref.destroy(); }
        } finally { resized?.destroy(); original.destroy(); }
      });
      // Keep the image-identity cache intact through the usage scan above, then
      // release decoded tiles after each completed image instead of retaining all pixels.
      engine.emptyStore();
      await pause(); check(control);
    }
    control.onProgress?.({ phase: 'images', completed: images.length, total: images.length }); check(control);
    for (const [reason, count] of skipped) warnings.push(`${count} image resource${count === 1 ? '' : 's'} kept unchanged to preserve ${reason}.`);
    return result();
  } finally { for (const { image } of images) image.destroy(); }
}
