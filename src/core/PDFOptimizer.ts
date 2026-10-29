import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import type { PDFDocument as NativeDocument } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { applyImageOptimization, planImageOptimization } from './PDFOptimizerImages';
import { decodeOptimizerStream } from './PDFOptimizerStreams';
import { DEFAULT_OPTIMIZER_SETTINGS, PDF_OPTIMIZER_LIMITS as LIMIT } from './PDFOptimizerTypes';
import type { OptimizerControl, OptimizerInspection, OptimizerResult, OptimizerSettings } from './PDFOptimizerTypes';
export * from './PDFOptimizerTypes';

const key = PDFName.of;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function cancelled(control: OptimizerControl) { if (control.signal?.aborted) throw new DOMException('PDF optimization cancelled.', 'AbortError'); }
function inputLimit(data: { byteLength: number }) {
  if (!data.byteLength || data.byteLength > LIMIT.inputBytes) throw new Error('Choose a PDF between 1 byte and 200 MB.');
}
function dictionaryName(dictionary: PDFDict, property: string) { const value = dictionary.lookup(key(property)); return value instanceof PDFName ? value.decodeText() : undefined; }
function isImage(object: PDFObject): object is PDFRawStream { return object instanceof PDFRawStream && dictionaryName(object.dict, 'Subtype') === 'Image'; }
function lookup(document: PDFDocument, value: PDFObject | undefined) {
  const result = document.context.lookup(value);
  if (value instanceof PDFRef && result === undefined) throw new Error('The PDF has a dangling object reference and cannot be optimized safely.');
  return result;
}
function graph(document: PDFDocument) {
  const reachable = new Map<number, PDFObject>(), seen = new Set<PDFObject>();
  const queue: Array<PDFObject | undefined> = [document.context.trailerInfo.Root, document.context.trailerInfo.Info, document.context.trailerInfo.ID];
  for (let index = 0; index < queue.length; index++) {
    const raw = queue[index], object = lookup(document, raw); if (!object) continue;
    // Names and nulls can be interned with an unrelated indirect object. Only an
    // actual traversed reference makes that object reachable, never its value.
    if (raw instanceof PDFRef) reachable.set(raw.objectNumber, object);
    if (seen.has(object)) continue; seen.add(object);
    if (seen.size > LIMIT.objects * 5 || reachable.size > LIMIT.objects) throw new Error('This PDF exceeds the optimizer’s object-count limit.');
    if (object instanceof PDFRawStream) queue.push(object.dict);
    else if (object instanceof PDFArray) queue.push(...object.asArray());
    else if (object instanceof PDFDict) queue.push(...object.values());
  }
  return { reachable, seen };
}
function restriction(document: PDFDocument, objects: Set<PDFObject>): string | undefined {
  const acro = document.catalog.lookup(key('AcroForm'));
  if (acro instanceof PDFDict && acro.has(key('XFA'))) return 'XFA documents cannot be optimized safely.';
  const permissions = document.catalog.lookup(key('Perms'));
  if (permissions instanceof PDFDict && ['DocMDP', 'UR', 'UR3'].some(property => permissions.has(key(property)))) return 'Signed or certified PDFs cannot be optimized. Use an unsigned source document.';
  for (const object of objects) if (object instanceof PDFDict) {
    const type = dictionaryName(object, 'Type'), fieldType = dictionaryName(object, 'FT'), value = object.lookup(key('V'));
    const contents = object.lookup(key('Contents')), byteRange = object.lookup(key('ByteRange'));
    // Arbitrary resource names such as /ByteRange are not signature properties.
    if (type === 'Sig' || type === 'DocTimeStamp' || (fieldType === 'Sig' && value !== undefined && value !== PDFNull)
      || (byteRange instanceof PDFArray && (contents instanceof PDFString || contents instanceof PDFHexString))) return 'Signed or certified PDFs cannot be optimized. Use an unsigned source document.';
  }
  return undefined;
}

function filterNames(stream: PDFRawStream): string[] {
  const filter = stream.dict.lookup(key('Filter'));
  if (filter === undefined || filter === PDFNull) return [];
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray && filter.size() <= 16) return filter.asArray().map((_, index) => {
    const value = filter.lookup(index); if (!(value instanceof PDFName)) throw new Error('A PDF stream has an invalid compression filter.'); return value.decodeText();
  });
  throw new Error('A PDF stream has an invalid compression filter.');
}
const decoded = decodeOptimizerStream;
async function preflightStreams(reachable: Map<number, PDFObject>, control: OptimizerControl) {
  let total = 0, rawImagePixels = 0;
  for (const object of reachable.values()) if (object instanceof PDFRawStream) {
    if (isImage(object)) {
      // Native compress-images may encode unfiltered bilevel samples as CCITT.
      // Bound its geometry before calling save, not only during output verification.
      if (!filterNames(object).length) {
        rawImagePixels += imageGeometry(object).pixels;
        if (rawImagePixels > LIMIT.totalDecodedPixels) throw new Error('Raw images exceed the optimizer’s cumulative resource limit.');
      }
    } else {
      const data = await decoded(object, Math.min(LIMIT.streamBytes, LIMIT.totalStreamBytes - total), control); total += data.length;
    }
    cancelled(control);
  }
}
function nativeCall<T>(engine: Awaited<ReturnType<typeof loadMuPDF>>, action: () => T, dispose?: (value: T) => void): T {
  const diagnostics: string[] = []; engine.setLog(message => { if (diagnostics.length < 8) diagnostics.push(message); });
  try { const result = action(); if (diagnostics.length) { dispose?.(result); throw new Error(`MuPDF reported a document error: ${[...new Set(diagnostics)].join('; ')}`); } return result; }
  finally { engine.setLog(null); }
}
interface Opened {
  source: PDFDocument; native: NativeDocument; engine: Awaited<ReturnType<typeof loadMuPDF>>;
  reachable: Map<number, PDFObject>; report: OptimizerInspection; plan: ReturnType<typeof planImageOptimization>;
}
async function open(data: ArrayBuffer, control: OptimizerControl): Promise<Opened> {
  inputLimit(data); cancelled(control); const engine = await loadMuPDF(); cancelled(control);
  let native: NativeDocument | undefined;
  try {
    native = nativeCall(engine, () => new engine.PDFDocument(new Uint8Array(data)), value => value.destroy()); native.disableJS();
    const trailer = native.getTrailer(), encryption = trailer.get('Encrypt');
    try { if (native.needsPassword() || !encryption.isNull()) throw new Error('Unlock this PDF before optimizing it.'); }
    finally { encryption.destroy(); trailer.destroy(); }
    const pageCount = native.countPages();
    if (pageCount < 1 || pageCount > LIMIT.pages) throw new Error('PDF optimization supports between 1 and 2,000 pages.');
    if (native.countObjects() > LIMIT.objects) throw new Error('This PDF exceeds the optimizer’s object-count limit.');
    if (native.wasRepaired()) throw new Error('The PDF required repair and cannot be optimized safely.');
    const source = await PDFDocument.load(data, { updateMetadata: false }); cancelled(control);
    const { reachable, seen } = graph(source), reason = restriction(source, seen), plan = planImageOptimization(source, reachable);
    if (source.getPageCount() !== pageCount) throw new Error('The PDF page tree could not be verified independently.');
    if (!reason) await preflightStreams(reachable, control);
    return { source, native, engine, reachable, plan, report: { inputBytes: data.byteLength, pageCount, imageCount: plan.imageCount, eligibleImageCount: plan.eligibleImageCount, canOptimize: !reason, unsupportedReason: reason, warnings: [...plan.warnings] } };
  } catch (error) { native?.destroy(); throw error; }
}

function canonical(value: PDFObject | undefined, aliases: Map<number, number>, omit = new Set<string>(), depth = 0): string {
  if (depth > 200) throw new Error('The PDF contains a direct-object structure too deep to verify.');
  if (value === undefined) return 'undefined';
  if (value instanceof PDFRef) return `ref:${aliases.get(value.objectNumber) ?? value.objectNumber}:${value.generationNumber}`;
  if (value instanceof PDFString || value instanceof PDFHexString) return `string:${Array.from(value.asBytes(), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (value instanceof PDFNumber) return `number:${Number.isInteger(value.asNumber()) ? value.asNumber() : Math.fround(value.asNumber())}`;
  if (value instanceof PDFName) return `name:${value.decodeText()}`;
  if (value instanceof PDFArray) return `[${value.asArray().map(item => canonical(item, aliases, new Set(), depth + 1)).join(',')}]`;
  if (value instanceof PDFDict) return `{${value.entries().filter(([property]) => !omit.has(property.decodeText())).sort(([a], [b]) => a.decodeText().localeCompare(b.decodeText())).map(([property, item]) => `${JSON.stringify(property.decodeText())}:${canonical(item, aliases, new Set(), depth + 1)}`).join(',')}}`;
  return value.toString();
}
const sameBytes = (left: Uint8Array | Uint8ClampedArray, right: Uint8Array | Uint8ClampedArray) => left.length === right.length && left.every((value, index) => value === right[index]);
const genericFilters = new Set(['ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL']);
function imageGeometry(stream: PDFRawStream) {
  const width = stream.dict.lookup(key('Width')), height = stream.dict.lookup(key('Height'));
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)
    || ![width.asNumber(), height.asNumber()].every(value => Number.isInteger(value) && value > 0 && value <= LIMIT.imageDimension)
    || width.asNumber() * height.asNumber() > LIMIT.imagePixels) throw new Error('A preserved image exceeds the optimizer’s verification resource limit.');
  return { width: width.asNumber(), height: height.asNumber(), pixels: width.asNumber() * height.asNumber() };
}
function verifyRewrittenImage(engine: Opened['engine'], document: NativeDocument, number: number, stream: PDFRawStream) {
  const geometry = imageGeometry(stream), components = dictionaryName(stream.dict, 'ColorSpace') === 'DeviceRGB' ? 3 : 1;
  if (dictionaryName(stream.dict, 'Filter') !== 'DCTDecode') throw new Error('An optimized image has an unexpected encoding.');
  const handles: Array<{ destroy(): void }> = [];
  try {
    const ref = document.newIndirect(number); handles.push(ref);
    const image = nativeCall(engine, () => document.loadImage(ref), value => value.destroy()); handles.push(image);
    if (image.getWidth() !== geometry.width || image.getHeight() !== geometry.height || image.getNumberOfComponents() !== components || image.getBitsPerComponent() !== 8) throw new Error('An optimized JPEG has inconsistent dimensions or colors.');
    const pixmap = nativeCall(engine, () => image.toPixmap(), value => value.destroy()); handles.push(pixmap);
    if (pixmap.getWidth() !== geometry.width || pixmap.getHeight() !== geometry.height || pixmap.getNumberOfComponents() !== components || pixmap.getAlpha()) throw new Error('An optimized JPEG did not decode completely.');
  } finally { for (const handle of handles.reverse()) handle.destroy(); }
}
/** Native save can losslessly encode a raw bilevel scan as CCITT. Its bytes are
 * incomparable to the source samples; verify the bounded decoded pixels instead.
 * Complex unchanged encodings are never decoded just to rewrite their container. */
async function verifyNativeImage(engine: Opened['engine'], originalDoc: NativeDocument, outputDoc: NativeDocument, number: number,
  original: PDFRawStream, saved: PDFRawStream, control: OptimizerControl) {
  const geometry = imageGeometry(original), savedGeometry = imageGeometry(saved);
  if (geometry.width !== savedGeometry.width || geometry.height !== savedGeometry.height) throw new Error('Lossless optimization changed image dimensions.');
  const color = dictionaryName(original.dict, 'ColorSpace'), bpc = original.dict.lookup(key('BitsPerComponent'));
  if (!['DeviceGray', 'DeviceRGB'].includes(color ?? '') || !(bpc instanceof PDFNumber) || ![1, 8].includes(bpc.asNumber())
    || ['Mask', 'SMask', 'ImageMask', 'Alternates'].some(property => original.dict.has(key(property)))) throw new Error('This image encoding cannot be verified safely after rewriting. The original PDF was preserved.');
  const components = color === 'DeviceRGB' ? 3 : 1;
  for (const stream of [original, saved]) {
    const filters = filterNames(stream);
    if (filters.every(filter => genericFilters.has(filter))) {
      const expected = Math.ceil(geometry.width * components * bpc.asNumber() / 8) * geometry.height;
      const samples = await decoded(stream, expected, control);
      if (samples.length !== expected) throw new Error('A preserved image contains inconsistent pixel data.');
    } else {
      // Keep this native fallback narrow: CCITT dimensions are controlled by the
      // PDF dictionary; arbitrary embedded JPEG/JPX headers need separate limits.
      if (color !== 'DeviceGray' || bpc.asNumber() !== 1 || filters.length !== 1 || !['CCITTFaxDecode', 'CCF'].includes(filters[0])) throw new Error('This image encoding cannot be verified safely after rewriting. The original PDF was preserved.');
      let params = stream.dict.lookup(key('DecodeParms')); if (params instanceof PDFArray && params.size() === 1) params = params.lookup(0);
      if (params !== undefined && params !== PDFNull && !(params instanceof PDFDict)) throw new Error('A preserved CCITT image has invalid decoder settings.');
      const columns = params instanceof PDFDict ? params.lookup(key('Columns')) : undefined, rows = params instanceof PDFDict ? params.lookup(key('Rows')) : undefined;
      if ((columns === undefined ? 1728 : columns instanceof PDFNumber ? columns.asNumber() : NaN) !== geometry.width
        || (rows !== undefined && (!(rows instanceof PDFNumber) || ![0, geometry.height].includes(rows.asNumber())))) throw new Error('A preserved CCITT image has inconsistent decoder dimensions.');
    }
  }
  cancelled(control);
  const handles: Array<{ destroy(): void }> = [];
  try {
    const pixmaps = [originalDoc, outputDoc].map(document => {
      const ref = document.newIndirect(number); handles.push(ref);
      const image = nativeCall(engine, () => document.loadImage(ref), value => value.destroy()); handles.push(image);
      if (image.getWidth() !== geometry.width || image.getHeight() !== geometry.height || image.getNumberOfComponents() !== components) throw new Error('A preserved image has inconsistent native dimensions or colors.');
      const mask = image.getMask(); if (mask) { mask.destroy(); throw new Error('An unexpected image mask prevents lossless verification.'); }
      const pixmap = nativeCall(engine, () => image.toPixmap(), value => value.destroy()); handles.push(pixmap);
      if (pixmap.getWidth() !== geometry.width || pixmap.getHeight() !== geometry.height || pixmap.getNumberOfComponents() !== components || pixmap.getAlpha()) throw new Error('A preserved image changed pixel geometry.');
      return pixmap;
    });
    // Obtain views after both allocations: growing the WASM heap invalidates old views.
    if (!sameBytes(pixmaps[0].getPixels(), pixmaps[1].getPixels())) throw new Error('Lossless optimization changed preserved image pixels.');
  } finally { for (const handle of handles.reverse()) handle.destroy(); }
}
async function verify(source: PDFDocument, before: Map<number, PDFObject>, input: ArrayBuffer, output: Uint8Array, aliases: Map<number, number>, rewritten: Set<number>, decodedPixels: number, engine: Opened['engine'], control: OptimizerControl) {
  const afterDoc = await PDFDocument.load(output, { updateMetadata: false }), after = graph(afterDoc).reachable;
  if (source.getPageCount() !== afterDoc.getPageCount()) throw new Error('Optimization changed the number of pages.');
  const empty = new Map<number, number>(); let decodedTotal = 0;
  let originalNative: NativeDocument | undefined, outputNative: NativeDocument | undefined;
  try {
  for (const [number, original] of before) {
    cancelled(control); if (aliases.has(number)) continue;
    const saved = after.get(number); if (!saved) throw new Error('Optimization removed an object still used by the document.');
    if (original instanceof PDFRawStream) {
      if (!(saved instanceof PDFRawStream)) throw new Error('Optimization changed a stream into a different PDF object.');
      const omissions = new Set(['Length', 'Filter', 'DecodeParms']); if (rewritten.has(number)) { omissions.add('Width'); omissions.add('Height'); }
      if (canonical(original.dict, aliases, omissions) !== canonical(saved.dict, empty, omissions)) throw new Error('Optimization changed stream properties outside the selected image settings.');
      if (rewritten.has(number)) {
        const geometry = imageGeometry(saved), originalGeometry = imageGeometry(original);
        if (geometry.width > originalGeometry.width || geometry.height > originalGeometry.height) throw new Error('Optimization unexpectedly enlarged an image.');
        decodedPixels += geometry.pixels;
        if (decodedPixels > LIMIT.totalDecodedPixels) throw new Error('Optimized images exceed the optimizer’s cumulative verification resource limit.');
        outputNative ??= nativeCall(engine, () => new engine.PDFDocument(output), value => value.destroy());
        verifyRewrittenImage(engine, outputNative, number, saved);
        continue;
      }
      const encoding = (stream: PDFRawStream) => canonical(stream.dict.get(key('Filter')), empty) + canonical(stream.dict.get(key('DecodeParms')), empty);
      if (encoding(original) === encoding(saved) && sameBytes(original.getContents(), saved.getContents())) continue;
      if (isImage(original)) {
        decodedPixels += imageGeometry(original).pixels * 2;
        if (decodedPixels > LIMIT.totalDecodedPixels) throw new Error('Preserved images exceed the optimizer’s cumulative verification resource limit.');
        if ([...filterNames(original), ...filterNames(saved)].some(filter => !genericFilters.has(filter))) {
          originalNative ??= nativeCall(engine, () => new engine.PDFDocument(new Uint8Array(input)), value => value.destroy());
          outputNative ??= nativeCall(engine, () => new engine.PDFDocument(output), value => value.destroy());
          await verifyNativeImage(engine, originalNative, outputNative, number, original, saved, control);
          continue;
        }
      }
      const perStream = isImage(original) ? LIMIT.imagePixels * 4 : LIMIT.streamBytes;
      const maximum = Math.min(perStream, LIMIT.totalStreamBytes + LIMIT.totalDecodedPixels * 4 - decodedTotal);
      const a = await decoded(original, maximum, control), b = await decoded(saved, maximum, control); decodedTotal += Math.max(a.length, b.length);
      if (!sameBytes(a, b)) throw new Error('Optimization changed preserved stream content.');
    } else if (canonical(original, aliases) !== canonical(saved, empty)) throw new Error('Optimization changed document data outside the selected images.');
  }
  for (const property of ['Info', 'ID'] as const) if (canonical(source.context.trailerInfo[property], aliases) !== canonical(afterDoc.context.trailerInfo[property], empty)) throw new Error('Optimization changed document metadata or identifiers.');
  } finally { originalNative?.destroy(); outputNative?.destroy(); }
}

export async function inspectPDFOptimization(input: ArrayBuffer | Uint8Array, control: OptimizerControl = {}): Promise<OptimizerInspection> {
  inputLimit(input); cancelled(control);
  const data = input instanceof Uint8Array ? new Uint8Array(input).buffer : input;
  control.onProgress?.({ phase: 'inspect', completed: 0, total: 1 });
  const opened = await open(data, control);
  try { cancelled(control); control.onProgress?.({ phase: 'inspect', completed: 1, total: 1 }); cancelled(control); return opened.report; }
  finally { opened.native.destroy(); }
}

/** Structural rewriting never cleans/rebuilds content, synthesizes appearances,
 * subsets fonts, or merges identity-bearing fields. Images are handled separately. */
export async function optimizePDF(input: ArrayBuffer | Uint8Array, settings: OptimizerSettings = DEFAULT_OPTIMIZER_SETTINGS, control: OptimizerControl = {}): Promise<OptimizerResult> {
  inputLimit(input); cancelled(control);
  const data = input instanceof Uint8Array ? new Uint8Array(input).buffer : input;
  if (!settings || !['lossless', 'images'].includes(settings.mode) || ![150, 200, 300].includes(settings.dpi) || !Number.isInteger(settings.quality) || settings.quality < 1 || settings.quality > 100) throw new Error('Choose lossless or image optimization, a supported DPI, and JPEG quality from 1 to 100.');
  control.onProgress?.({ phase: 'inspect', completed: 0, total: 1 }); const opened = await open(data, control);
  try {
    if (!opened.report.canOptimize) throw new Error(opened.report.unsupportedReason);
    control.onProgress?.({ phase: 'inspect', completed: 1, total: 1 }); await tick(); cancelled(control);
    const changedImages = await applyImageOptimization(opened.engine, opened.native, opened.plan, settings, control); cancelled(control);
    control.onProgress?.({ phase: 'save', completed: 0, total: 1 }); await tick(); cancelled(control);
    // First create safe GC1 bytes. Packing sparse xrefs can fail in MuPDF 1.28.1;
    // PDFDocument(existingDocument) is only a shared handle, not an isolated copy.
    const saved = nativeCall(opened.engine, () => opened.native.saveToBuffer('incremental=no,garbage=1,compress=yes,compress-images=yes,compress-fonts=yes,regenerate-id=no'), value => value.destroy());
    let output: Uint8Array; try { output = new Uint8Array(saved.asUint8Array()); } finally { saved.destroy(); }
    const packingWarnings: string[] = [];
    let packingDocument: NativeDocument | undefined;
    await tick(); cancelled(control);
    try {
      // A fresh byte-backed document isolates an optional packing failure from
      // the verified plain rewrite and from the original document's state.
      packingDocument = nativeCall(opened.engine, () => new opened.engine.PDFDocument(output), value => value.destroy());
      const packed = nativeCall(opened.engine, () => packingDocument!.saveToBuffer('incremental=no,garbage=1,compress=yes,compress-images=yes,compress-fonts=yes,objstms=yes,regenerate-id=no'), value => value.destroy());
      try { if (packed.asUint8Array().byteLength < output.byteLength) output = new Uint8Array(packed.asUint8Array()); }
      finally { packed.destroy(); }
    } catch {
      packingWarnings.push('Some optional object packing was skipped. The remaining verified optimizations were retained.');
    } finally { packingDocument?.destroy(); }
    cancelled(control);
    control.onProgress?.({ phase: 'save', completed: 1, total: 1 }); await tick(); cancelled(control);
    control.onProgress?.({ phase: 'verify', completed: 0, total: 1 });
    const check = nativeCall(opened.engine, () => new opened.engine.PDFDocument(output), value => value.destroy());
    try { if (check.wasRepaired() || check.countPages() !== opened.report.pageCount) throw new Error('The optimized PDF did not pass validation.'); } finally { check.destroy(); }
    await verify(opened.source, opened.reachable, data, output, changedImages.aliases, changedImages.rewritten, changedImages.decodedPixels, opened.engine, control); cancelled(control);
    control.onProgress?.({ phase: 'verify', completed: 1, total: 1 });
    cancelled(control);
    const changed = output.byteLength < data.byteLength;
    return { data: changed ? output : new Uint8Array(data.slice(0)), inputBytes: data.byteLength, outputBytes: changed ? output.byteLength : data.byteLength,
      candidateBytes: output.byteLength, pageCount: opened.report.pageCount, changed,
      imagesOptimized: changed ? changedImages.imagesOptimized : 0, imagesDeduplicated: changed ? changedImages.imagesDeduplicated : 0,
      imagesSkipped: changed ? changedImages.imagesSkipped : opened.report.imageCount,
      warnings: [...new Set([...opened.report.warnings, ...changedImages.warnings, ...packingWarnings, ...(!changed ? ['No smaller verified PDF was produced. The original bytes were retained.'] : [])])] };
  } finally { opened.native.destroy(); }
}
