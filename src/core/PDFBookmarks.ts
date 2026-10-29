import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';
import { createPDFLinkDestinationResolver } from './PDFLinkDestinations';
import { geometry, number, safeURL, validateTarget, destination, writeTarget, type Geometry } from './PDFTargetCodec';
import { PDF_BOOKMARK_LIMITS as LIMIT, type PDFBookmarkControl, type PDFBookmarkDefinition, type PDFBookmarkDraft, type PDFBookmarkInfo, type PDFBookmarkInspection } from './PDFBookmarksTypes';
export * from './PDFBookmarksTypes';
const key = PDFName.of;
type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface Record { ref: PDFRef; dictionary: PDFDict; info: PDFBookmarkInfo; parentId: string | null; index: number }
interface Loaded { data: Uint8Array; pdf: PDFDocument; engine: Engine; geometries: Geometry[]; records: Map<string, Record>; report: PDFBookmarkInspection; root: PDFDict | undefined; rootRef: PDFRef | undefined }
const cancel = (control: PDFBookmarkControl) => control.signal?.throwIfAborted();
const name = (dictionary: PDFDict, property: string) => { const value = dictionary.lookup(key(property)); return value instanceof PDFName ? value.decodeText() : undefined; };
const string = (value: PDFObject | undefined) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
const present = (dictionary: PDFDict, property: string) => { const value = dictionary.lookup(key(property)); return value !== undefined && value !== PDFNull; };
function strict<T>(engine: Engine, operation: () => T, dispose?: (result: T) => void): T {
  const diagnostics: string[] = []; engine.setLog(message => { if (diagnostics.length < 6) diagnostics.push(message); });
  try { const result = operation(); if (diagnostics.length) { dispose?.(result); throw new Error(`The PDF could not be processed safely: ${diagnostics.join('; ')}`); } return result; }
  finally { engine.setLog(null); }
}
function restrictions(pdf: PDFDocument): string | undefined {
  const acro = pdf.catalog.lookup(key('AcroForm')), permissions = pdf.catalog.lookup(key('Perms'));
  if (acro instanceof PDFDict && present(acro, 'XFA')) return 'XFA documents cannot be changed by bookmark management.';
  if (permissions instanceof PDFDict && ['DocMDP', 'UR', 'UR3'].some(property => present(permissions, property))) return 'Signed or certified PDFs cannot be changed by bookmark management.';
  const seen = new Set<PDFObject>(), pending: Array<PDFObject | undefined> = [pdf.context.trailerInfo.Root];
  for (let index = 0; index < pending.length; index++) {
    const raw = pending[index], object = pdf.context.lookup(raw);
    if (raw instanceof PDFRef && object === undefined) throw new Error('The PDF contains a dangling object reference.');
    if (!object || seen.has(object)) continue; seen.add(object);
    if (seen.size > 1_000_000) throw new Error('The PDF structure exceeds the bookmark editor resource limit.');
    if (object instanceof PDFRawStream) pending.push(object.dict);
    else if (object instanceof PDFArray) pending.push(...object.asArray());
    else if (object instanceof PDFDict) {
      const type = name(object, 'Type'), value = object.lookup(key('V')), range = object.lookup(key('ByteRange')), contents = object.lookup(key('Contents'));
      if (['Sig', 'DocTimeStamp'].includes(type ?? '') || (name(object, 'FT') === 'Sig' && value !== undefined && value !== PDFNull)
        || (range instanceof PDFArray && (contents instanceof PDFString || contents instanceof PDFHexString))) return 'Signed or certified PDFs cannot be changed by bookmark management.';
      pending.push(...object.values());
    }
  }
  return undefined;
}

function definition(value: PDFBookmarkDefinition, geometries: Geometry[]): PDFBookmarkDefinition {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > LIMIT.titleCharacters
    || Array.from(value.title).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Bookmark titles need 1 to 4,096 characters without control characters.');
  if (![value.bold, value.italic, value.expanded].every(item => typeof item === 'boolean') || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error('Choose a valid bookmark style and color.');
  return { title: value.title, target: value.target === null ? null : validateTarget(value.target, geometries), bold: value.bold, italic: value.italic, color: value.color.toLowerCase(), expanded: value.expanded };
}
function equivalent(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= .001;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const left = a as { [key: string]: unknown }, right = b as { [key: string]: unknown }, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(property => Object.hasOwn(right, property) && equivalent(left[property], right[property]));
}
function collect(pdf: PDFDocument, geometries: Geometry[], revision: string) {
  const records = new Map<string, Record>(), seen = new Set<PDFDict>(), resolve = createPDFLinkDestinationResolver(pdf);
  const rawRoot = pdf.catalog.get(key('Outlines')), root = pdf.context.lookup(rawRoot);
  if (root === undefined || root === PDFNull) return { records, bookmarks: [], root: undefined, rootRef: undefined };
  if (!(root instanceof PDFDict) || !(rawRoot instanceof PDFRef)) throw new Error('The bookmark root is malformed or not an indirect dictionary.');
  const uri = pdf.catalog.lookup(key('URI')), base = uri instanceof PDFDict ? string(uri.lookup(key('Base'))) : undefined;
  const siblings = (parent: PDFDict, parentRef: PDFRef, parentId: string | null, depth: number): PDFBookmarkInfo[] => {
    if (depth > LIMIT.depth && present(parent, 'First')) throw new Error('Bookmark nesting exceeds 64 levels.');
    const result: PDFBookmarkInfo[] = []; let raw = parent.get(key('First')), previous: PDFRef | undefined;
    while (raw !== undefined && raw !== PDFNull) {
      if (records.size >= LIMIT.bookmarks) throw new Error('This PDF exceeds the 10,000-bookmark limit.');
      const dictionary = pdf.context.lookup(raw);
      if (!(raw instanceof PDFRef) || !(dictionary instanceof PDFDict) || seen.has(dictionary)) throw new Error('The bookmark tree has a cycle, a shared item, or an invalid reference.');
      seen.add(dictionary);
      if (dictionary.get(key('Parent'))?.toString() !== parentRef.toString()
        || (previous ? dictionary.get(key('Prev'))?.toString() !== previous.toString() : present(dictionary, 'Prev'))) throw new Error('The bookmark parent or previous-item relationship is invalid.');
      const title = string(dictionary.lookup(key('Title'))), count = dictionary.lookup(key('Count')), flags = dictionary.lookup(key('F')), color = dictionary.lookup(key('C'));
      const info: PDFBookmarkInfo = { id: `${revision}:${raw.toString()}`, definition: { title: title ?? '(Untitled bookmark)', target: null, bold: false, italic: false, color: '#000000', expanded: !(count instanceof PDFNumber) || count.asNumber() >= 0 }, children: [], editable: false, movable: true, removable: true };
      const record: Record = { ref: raw, dictionary, info, parentId, index: result.length }; records.set(info.id, record);
      try {
        if (title === undefined) throw new Error('This bookmark has an invalid title.');
        if (present(dictionary, 'SE')) { info.removable = false; info.movable = false; throw new Error('This bookmark references the document structure tree and is protected until structure editing is supported.'); }
        if (count !== undefined && count !== PDFNull && (!Number.isInteger(number(count)) || Math.abs(number(count)) > LIMIT.bookmarks)) throw new Error('This bookmark has an invalid expansion count.');
        if (flags !== undefined && flags !== PDFNull) {
          const value = number(flags); if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('This bookmark has unsupported style flags.');
          info.definition.bold = !!(value & 2); info.definition.italic = !!(value & 1);
        }
        if (color !== undefined && color !== PDFNull) {
          if (!(color instanceof PDFArray) || color.size() !== 3) throw new Error('This bookmark has an invalid color.');
          const values = color.asArray().map((_, index) => number(color.lookup(index)));
          if (values.some(value => value < 0 || value > 1)) throw new Error('This bookmark has an invalid color.');
          info.definition.color = '#' + values.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
        }
        const action = dictionary.lookup(key('A')), dest = dictionary.lookup(key('Dest')); let rawDestination: PDFObject | undefined;
        if (action !== undefined && action !== PDFNull) {
          if (!(action instanceof PDFDict) || dest !== undefined && dest !== PDFNull) throw new Error('This bookmark has ambiguous or invalid actions.');
          const type = name(action, 'S');
          if (present(action, 'Next')) throw new Error('Chained bookmark actions are read-only.');
          const allowed = type === 'URI' ? ['Type', 'S', 'URI', 'IsMap'] : ['Type', 'S', 'D'];
          if (action.keys().some(property => !allowed.includes(property.decodeText()))) throw new Error('This bookmark action has unsupported additional behavior.');
          if (type === 'URI') {
            if (present(action, 'IsMap') && action.lookup(key('IsMap')) !== PDFBool.False) throw new Error('Coordinate-dependent URI actions are read-only.');
            const value = string(action.lookup(key('URI'))); if (value === undefined) throw new Error('This bookmark URI is invalid.');
            info.definition.target = { type: 'url', url: safeURL(value, base) };
          } else if (type === 'GoTo') rawDestination = action.lookup(key('D'));
          else throw new Error(`The ${type ?? 'unknown'} bookmark action is not supported for editing.`);
          if (type === 'GoTo' && !rawDestination) throw new Error('This bookmark destination is missing.');
        } else if (dest !== undefined && dest !== PDFNull) rawDestination = dest;
        if (rawDestination) {
          const resolved = resolve(rawDestination); if (!resolved) throw new Error('This bookmark destination is missing, ambiguous, or outside the page tree.');
          info.definition.target = destination(resolved.destination, resolved.pageNumber, geometries);
          info.namedDestination = rawDestination instanceof PDFName ? rawDestination.decodeText() : string(rawDestination);
        }
        info.definition = definition(info.definition, geometries); info.editable = true;
      } catch (error) { info.unsupportedReason = error instanceof Error ? error.message : 'This bookmark cannot be edited safely.'; }
      info.children = siblings(dictionary, raw, info.id, depth + 1);
      result.push(info); previous = raw; raw = dictionary.get(key('Next'));
    }
    if (previous ? parent.get(key('Last'))?.toString() !== previous.toString() : present(parent, 'Last')) throw new Error('The bookmark last-item relationship is invalid.');
    return result;
  };
  return { records, bookmarks: siblings(root, rawRoot, null, 1), root, rootRef: rawRoot };
}

async function load(input: ArrayBuffer | Uint8Array, control: PDFBookmarkControl): Promise<Loaded> {
  cancel(control);
  if (!input.byteLength || input.byteLength > LIMIT.inputBytes) throw new Error('Bookmark management accepts PDFs between 1 byte and 200 MB.');
  const data = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0)), engine = await loadMuPDF(); cancel(control);
  const native = strict(engine, () => new engine.PDFDocument(data), item => item.destroy()); let pages: number;
  try {
    native.disableJS(); const trailer = native.getTrailer(), encryption = trailer.get('Encrypt');
    try { if (native.needsPassword() || !encryption.isNull()) throw new Error('Unlock this PDF before managing bookmarks.'); } finally { encryption.destroy(); trailer.destroy(); }
    pages = native.countPages();
    if (native.wasRepaired()) throw new Error('This PDF required repair and cannot be edited safely.');
    if (pages < 1 || pages > LIMIT.pages || native.countObjects() > 200000) throw new Error('The PDF exceeds the bookmark editor page or object limit.');
  } finally { native.destroy(); }
  const pdf = await PDFDocument.load(data, { updateMetadata: false }); cancel(control);
  if (pdf.getPageCount() !== pages) throw new Error('The PDF page tree could not be verified independently.');
  const unsupportedReason = restrictions(pdf), geometries = pdf.getPages().map(geometry);
  const revision = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))), value => value.toString(16).padStart(2, '0')).join(''); cancel(control);
  if (control.expectedRevision !== undefined && control.expectedRevision !== revision) throw new Error('The PDF changed after bookmark inspection. Reopen bookmark management.');
  const collected = collect(pdf, geometries, revision);
  const report: PDFBookmarkInspection = { revision, pages: geometries.map((page, index) => ({ pageNumber: index + 1, width: page.width, height: page.height, rotation: page.rotation })), bookmarks: collected.bookmarks, canEdit: !unsupportedReason, unsupportedReason };
  return { data, pdf, engine, geometries, ...collected, report };
}
export async function inspectPDFBookmarks(data: ArrayBuffer | Uint8Array, control: PDFBookmarkControl = {}): Promise<PDFBookmarkInspection> {
  control.onProgress?.({ completed: 0, total: 1 }); const opened = await load(data, control); control.onProgress?.({ completed: 1, total: 1 }); cancel(control); return opened.report;
}

/** Rewrite only the outline tree; all surviving items keep their original refs. */
export async function applyPDFBookmarks(data: ArrayBuffer | Uint8Array, tree: PDFBookmarkDraft[], control: PDFBookmarkControl = {}): Promise<Uint8Array> {
  const opened = await load(data, control), { pdf, geometries, records } = opened;
  const seen = new Set<string>(), shapes = new Set<object>();
  interface Planned { id: string; definition: PDFBookmarkDefinition; record?: Record; children: Planned[]; ref?: PDFRef; dictionary?: PDFDict }
  const validate = (items: PDFBookmarkDraft[], parentId: string | null, depth: number): Planned[] => {
    if (!Array.isArray(items) || (items.length > 0 && depth > LIMIT.depth)) throw new Error('Bookmark structure is invalid or exceeds 64 levels.');
    return items.map((item, index) => {
      cancel(control);
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length > 256 || seen.has(item.id) || shapes.has(item) || seen.size >= LIMIT.bookmarks) throw new Error('Bookmark IDs must be unique; cycles and more than 10,000 bookmarks are not supported.');
      seen.add(item.id); shapes.add(item);
      const record = records.get(item.id);
      if (!record && !/^draft-[A-Za-z0-9_-]{1,128}$/.test(item.id)) throw new Error('A bookmark selection is stale or missing. Reopen bookmark management.');
      if (record && !record.info.movable && (parentId !== record.parentId || index !== record.index)) throw new Error(record.info.unsupportedReason ?? 'This bookmark cannot be moved.');
      if (record && !record.info.editable && !equivalent(item.definition, record.info.definition)) throw new Error(record.info.unsupportedReason ?? 'This bookmark is read-only.');
      return { id: item.id, record, definition: record && !record.info.editable ? record.info.definition : definition(item.definition, geometries), children: validate(item.children, item.id, depth + 1) };
    });
  };
  const planned = validate(tree, null, 1);
  for (const record of records.values()) if (!seen.has(record.info.id) && !record.info.removable) throw new Error(record.info.unsupportedReason ?? 'This bookmark cannot be deleted.');
  const same = (items: Planned[], original: PDFBookmarkInfo[]): boolean => items.length === original.length && items.every((item, index) => item.id === original[index].id && equivalent(item.definition, original[index].definition) && same(item.children, original[index].children));
  if (same(planned, opened.report.bookmarks)) return new Uint8Array(opened.data);
  if (!opened.report.canEdit) throw new Error(opened.report.unsupportedReason);
  let completed = 0;
  const prepare = (items: Planned[]) => { for (const item of items) {
    const dictionary = item.record?.dictionary ?? pdf.context.obj({});
    item.ref = item.record?.ref ?? pdf.context.register(dictionary); item.dictionary = dictionary;
    if (!item.record || !equivalent(item.definition, item.record.info.definition)) {
      const value = item.definition, previous = item.record?.info.definition;
      if (value.title !== previous?.title) dictionary.set(key('Title'), PDFHexString.fromText(value.title));
      if (value.bold !== previous?.bold || value.italic !== previous?.italic) dictionary.set(key('F'), PDFNumber.of((value.bold ? 2 : 0) | (value.italic ? 1 : 0)));
      if (value.color !== previous?.color) dictionary.set(key('C'), pdf.context.obj([1, 3, 5].map(index => parseInt(value.color.slice(index, index + 2), 16) / 255)));
      if (!previous || !equivalent(value.target, previous.target)) {
        if (value.target) writeTarget(pdf, dictionary, value.target, geometries); else { dictionary.delete(key('A')); dictionary.delete(key('Dest')); }
      }
    }
    prepare(item.children); control.onProgress?.({ completed: ++completed, total: seen.size }); cancel(control);
  } };
  prepare(planned);
  const root = opened.root ?? pdf.context.obj({ Type: 'Outlines' }), rootRef = opened.rootRef ?? pdf.context.register(root);
  const wire = (items: Planned[], parent: PDFDict, parentRef: PDFRef): number => {
    parent.delete(key('First')); parent.delete(key('Last'));
    if (items.length) { parent.set(key('First'), items[0].ref!); parent.set(key('Last'), items.at(-1)!.ref!); }
    let visible = 0;
    for (const [index, item] of items.entries()) {
      const dictionary = item.dictionary!; dictionary.set(key('Parent'), parentRef);
      dictionary.delete(key('Prev')); dictionary.delete(key('Next'));
      if (index) dictionary.set(key('Prev'), items[index - 1].ref!);
      if (index + 1 < items.length) dictionary.set(key('Next'), items[index + 1].ref!);
      const descendants = wire(item.children, dictionary, item.ref!);
      if (descendants) dictionary.set(key('Count'), PDFNumber.of(item.definition.expanded ? descendants : -descendants)); else dictionary.delete(key('Count'));
      visible += 1 + (item.definition.expanded ? descendants : 0);
    }
    return visible;
  };
  const visible = wire(planned, root, rootRef); root.set(key('Count'), PDFNumber.of(visible));
  if (planned.length) pdf.catalog.set(key('Outlines'), rootRef); else pdf.catalog.delete(key('Outlines'));
  cancel(control); const serialized = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }); cancel(control);
  const native = strict(opened.engine, () => new opened.engine.PDFDocument(serialized), item => item.destroy()); let output: Uint8Array;
  try { native.disableJS(); const buffer = strict(opened.engine, () => native.saveToBuffer('incremental=no,garbage=1,compress=yes,regenerate-id=no'), item => item.destroy()); try { output = new Uint8Array(buffer.asUint8Array()); } finally { buffer.destroy(); } }
  finally { native.destroy(); }
  const checked = await load(output, { signal: control.signal });
  const verify = (items: Planned[], actual: PDFBookmarkInfo[]): boolean => items.length === actual.length && items.every((item, index) => {
    const other = actual[index], record = checked.records.get(other.id);
    // Leaf items have no Count in native PDFs; their expanded state has no effect.
    const expected = { ...item.definition, expanded: item.children.length ? item.definition.expanded : true };
    return record?.ref.toString() === item.ref!.toString() && equivalent(expected, other.definition) && verify(item.children, other.children);
  });
  if (checked.report.pages.length !== opened.report.pages.length || !verify(planned, checked.report.bookmarks)) throw new Error('The saved PDF failed bookmark structure or destination verification.');
  cancel(control); return output;
}
