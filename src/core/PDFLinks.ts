import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';
import { createPDFLinkDestinationResolver } from './PDFLinkDestinations';
import { PDF_LINK_LIMITS as LIMIT, type PDFLinkBorder, type PDFLinkControl, type PDFLinkDefinition, type PDFLinkInfo, type PDFLinkInspection, type PDFLinkOperation, type PDFLinkTarget } from './PDFLinkTypes';
export * from './PDFLinkTypes';
import { geometry, number, rectValue, validRect, safeURL, validateTarget, destination, nativeRect, writeTarget, type Geometry } from './PDFTargetCodec';

const key = PDFName.of;
type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface LinkRecord { pageIndex: number; index: number; raw: PDFObject; dictionary: PDFDict; info: PDFLinkInfo }
interface Loaded { data: Uint8Array; pdf: PDFDocument; engine: Engine; geometries: Geometry[]; records: LinkRecord[]; report: PDFLinkInspection }
const cancel = (control: PDFLinkControl) => { if (control.signal?.aborted) throw new DOMException('Link editing cancelled.', 'AbortError'); };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const name = (dictionary: PDFDict, property: string) => { const value = dictionary.lookup(key(property)); return value instanceof PDFName ? value.decodeText() : undefined; };
const string = (value: PDFObject | undefined) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
const present = (dictionary: PDFDict, property: string) => { const value = dictionary.lookup(key(property)); return value !== undefined && value !== PDFNull; };
function strict<T>(engine: Engine, operation: () => T, dispose?: (result: T) => void): T {
  const diagnostics: string[] = []; engine.setLog(message => { if (diagnostics.length < 6) diagnostics.push(message); });
  try { const result = operation(); if (diagnostics.length) { dispose?.(result); throw new Error(`The PDF could not be processed safely: ${diagnostics.join('; ')}`); } return result; }
  finally { engine.setLog(null); }
}
function sourceBytes(input: ArrayBuffer | Uint8Array) {
  if (!input.byteLength || input.byteLength > LIMIT.inputBytes) throw new Error('Link management accepts PDFs between 1 byte and 200 MB.');
  return input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0));
}
async function revision(data: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))), byte => byte.toString(16).padStart(2, '0')).join(''); }
function restrictions(pdf: PDFDocument): string | undefined {
  const acro = pdf.catalog.lookup(key('AcroForm')), permissions = pdf.catalog.lookup(key('Perms'));
  if (acro instanceof PDFDict && present(acro, 'XFA')) return 'XFA documents cannot be changed by link management.';
  if (permissions instanceof PDFDict && ['DocMDP', 'UR', 'UR3'].some(property => present(permissions, property))) return 'Signed or certified PDFs cannot be changed by link management.';
  const seen = new Set<PDFObject>(), pending: Array<PDFObject | undefined> = [pdf.context.trailerInfo.Root];
  for (let index = 0; index < pending.length; index++) {
    const raw = pending[index], object = pdf.context.lookup(raw);
    if (raw instanceof PDFRef && object === undefined) throw new Error('The PDF contains a dangling object reference.');
    if (!object || seen.has(object)) continue; seen.add(object);
    if (seen.size > 1_000_000) throw new Error('The PDF structure exceeds the link editor resource limit.');
    if (object instanceof PDFRawStream) pending.push(object.dict);
    else if (object instanceof PDFArray) pending.push(...object.asArray());
    else if (object instanceof PDFDict) {
      const type = name(object, 'Type'), value = object.lookup(key('V')), range = object.lookup(key('ByteRange')), contents = object.lookup(key('Contents'));
      if (['Sig', 'DocTimeStamp'].includes(type ?? '') || (name(object, 'FT') === 'Sig' && value !== undefined && value !== PDFNull)
        || (range instanceof PDFArray && (contents instanceof PDFString || contents instanceof PDFHexString))) return 'Signed or certified PDFs cannot be changed by link management.';
      pending.push(...object.values());
    }
  }
  return undefined;
}
function borderValue(dictionary: PDFDict, page: Geometry): PDFLinkBorder {
  let width = 1, style: PDFLinkBorder['style'] = 'solid';
  const bs = dictionary.lookup(key('BS')), border = dictionary.lookup(key('Border')), c = dictionary.lookup(key('C'));
  if (bs !== undefined && bs !== PDFNull) {
    if (!(bs instanceof PDFDict)) throw new Error('This link has an invalid border style.');
    if (bs.has(key('W'))) width = number(bs.lookup(key('W')));
    const s = name(bs, 'S') ?? 'S'; if (!['S', 'D', 'U'].includes(s)) throw new Error('This link uses an unsupported border effect.'); style = s === 'D' ? 'dashed' : s === 'U' ? 'underline' : 'solid';
  } else if (border !== undefined && border !== PDFNull) {
    if (!(border instanceof PDFArray) || border.size() < 3 || border.size() > 4 || number(border.lookup(0)) !== 0 || number(border.lookup(1)) !== 0) throw new Error('Rounded or malformed link borders are read-only.');
    width = number(border.lookup(2)); if (border.size() === 4) style = 'dashed';
  }
  let components = [0, 0, 0];
  if (c !== undefined && c !== PDFNull) {
    if (!(c instanceof PDFArray) || ![0, 1, 3, 4].includes(c.size())) throw new Error('This link has an unsupported border color.');
    const values = c.asArray().map((_, index) => number(c.lookup(index))); if (values.some(value => value < 0 || value > 1)) throw new Error('This link has an invalid border color.');
    components = values.length === 1 ? [values[0], values[0], values[0]] : values.length === 3 ? values : values.length === 4 ? values.slice(0, 3).map(value => 1 - Math.min(1, value + values[3])) : [0, 0, 0];
  }
  const result = { width: width * page.unit, style, color: '#' + components.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('') };
  if (!Number.isFinite(result.width) || result.width < 0 || result.width > LIMIT.borderWidth) throw new Error('This link border is outside the supported width range.');
  return result;
}
function definition(value: PDFLinkDefinition, geometries: Geometry[]): PDFLinkDefinition {
  if (!value || !Number.isInteger(value.pageNumber) || value.pageNumber < 1 || value.pageNumber > geometries.length) throw new Error('Choose a valid source page for the link.');
  validRect(value.rect, geometries[value.pageNumber - 1], 'The link rectangle');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > LIMIT.descriptionCharacters)) throw new Error('Link descriptions are limited to 4,096 characters.');
  const border = value.border ?? { width: 0, color: '#000000', style: 'solid' };
  if (!Number.isFinite(border.width) || border.width < 0 || border.width > LIMIT.borderWidth || !/^#[0-9a-f]{6}$/i.test(border.color) || !['solid', 'dashed', 'underline'].includes(border.style)) throw new Error('Choose a supported link border style, color, and width between 0 and 100 points.');
  return { pageNumber: value.pageNumber, rect: { ...value.rect }, target: validateTarget(value.target, geometries), description: value.description ?? '', border: { ...border, color: border.color.toLowerCase() } };
}
function collect(pdf: PDFDocument, geometries: Geometry[], revision: string): LinkRecord[] {
  const result: LinkRecord[] = [], resolve = createPDFLinkDestinationResolver(pdf);
  const uri = pdf.catalog.lookup(key('URI')), base = uri instanceof PDFDict ? string(uri.lookup(key('Base'))) : undefined;
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annots = page.node.lookup(key('Annots')); if (annots === undefined || annots === PDFNull) continue;
    if (!(annots instanceof PDFArray)) throw new Error('A page has an invalid annotation array.');
    for (let index = 0; index < annots.size(); index++) {
      const raw = annots.get(index), dictionary = pdf.context.lookup(raw); if (!(dictionary instanceof PDFDict)) throw new Error('The PDF contains an invalid annotation.');
      if (name(dictionary, 'Subtype') !== 'Link') continue;
      if (result.length >= LIMIT.links) throw new Error('The PDF exceeds the 20,000-link management limit.');
      const tagged = present(dictionary, 'StructParent');
      const info: PDFLinkInfo = { id: `${revision}:${pageIndex}:${index}:${raw instanceof PDFRef ? raw.toString() : 'direct'}`, pageNumber: pageIndex + 1, rect: null, editable: false, removable: !tagged, summary: 'Unsupported link' };
      try {
        info.rect = rectValue(dictionary.lookup(key('Rect')), geometries[pageIndex]); validRect(info.rect, geometries[pageIndex], 'The existing link rectangle');
        if (tagged) throw new Error('This link is connected to the document structure tree. Updating or deleting it requires accessibility structure editing, which is not supported yet.');
        if (['AA', 'AP', 'QuadPoints', 'PA'].some(property => present(dictionary, property))) throw new Error('This link has additional actions, custom appearances, or nonrectangular hit areas and is read-only.');
        const flags = dictionary.lookup(key('F')); if (flags !== undefined && flags !== PDFNull && (!Number.isInteger(number(flags)) || number(flags) < 0 || (number(flags) & (64 | 128 | 512)))) throw new Error('This link is locked or read-only.');
        const action = dictionary.lookup(key('A')), dest = dictionary.lookup(key('Dest')); let target: PDFLinkTarget, rawDestination: PDFObject | undefined;
        if (action !== undefined && action !== PDFNull) {
          if (!(action instanceof PDFDict) || dest !== undefined && dest !== PDFNull) throw new Error('This link has ambiguous or invalid actions.');
          const type = name(action, 'S'); info.summary = `Unsupported ${type ?? 'unknown'} action`;
          if (present(action, 'Next')) throw new Error('Chained link actions are read-only.');
          const allowed = type === 'URI' ? ['Type', 'S', 'URI', 'IsMap'] : ['Type', 'S', 'D'];
          if (action.keys().some(property => !allowed.includes(property.decodeText()))) throw new Error('This link action contains additional behavior and is read-only.');
          if (type === 'URI' && present(action, 'IsMap') && action.lookup(key('IsMap')) !== PDFBool.False) throw new Error('Links that append image coordinates to their URI are read-only.');
          if (type === 'URI') { const value = string(action.lookup(key('URI'))); if (value === undefined) throw new Error('The link URI is invalid.'); target = { type: 'url', url: safeURL(value, base) }; }
          else if (type === 'GoTo') { rawDestination = action.lookup(key('D')); const resolved = resolve(rawDestination); if (!resolved) throw new Error('The link destination is missing, ambiguous, or does not belong to the actual page tree.'); target = destination(resolved.destination, resolved.pageNumber, geometries); }
          else throw new Error(`The ${type ?? 'unknown'} link action is not supported for editing.`);
        } else {
          rawDestination = dest; const resolved = resolve(dest); if (!resolved) throw new Error('The link destination is missing, ambiguous, or does not belong to the actual page tree.'); target = destination(resolved.destination, resolved.pageNumber, geometries);
        }
        if (rawDestination instanceof PDFName) info.namedDestination = rawDestination.decodeText(); else if (string(rawDestination) !== undefined) info.namedDestination = string(rawDestination);
        const description = dictionary.lookup(key('Contents')); if (description !== undefined && description !== PDFNull && string(description) === undefined) throw new Error('The link description is malformed.');
        info.definition = definition({ pageNumber: pageIndex + 1, rect: info.rect, target, description: string(description), border: borderValue(dictionary, geometries[pageIndex]) }, geometries);
        info.summary = target.type === 'url' ? target.url : `Page ${target.pageNumber} · ${target.view}`; info.editable = true;
      } catch (error) { info.unsupportedReason = error instanceof Error ? error.message : 'This link cannot be edited safely.'; }
      result.push({ pageIndex, index, raw, dictionary, info });
    }
  }
  return result;
}
async function load(input: ArrayBuffer | Uint8Array, control: PDFLinkControl): Promise<Loaded> {
  cancel(control); const data = sourceBytes(input), engine = await loadMuPDF(); cancel(control);
  const native = strict(engine, () => new engine.PDFDocument(data), value => value.destroy()); let pageCount: number;
  try {
    native.disableJS(); const trailer = native.getTrailer(), encryption = trailer.get('Encrypt');
    try { if (native.needsPassword() || !encryption.isNull()) throw new Error('Unlock this PDF before managing links.'); } finally { encryption.destroy(); trailer.destroy(); }
    pageCount = native.countPages(); if (native.wasRepaired()) throw new Error('This PDF required repair and cannot be edited safely.');
    if (pageCount < 1 || pageCount > LIMIT.pages || native.countObjects() > 200000) throw new Error('The PDF exceeds the link editor page or object limit.');
  } finally { native.destroy(); }
  const pdf = await PDFDocument.load(data, { updateMetadata: false }); cancel(control);
  if (pdf.getPageCount() !== pageCount) throw new Error('The PDF page tree could not be verified independently.');
  const unsupportedReason = restrictions(pdf), geometries = pdf.getPages().map(geometry), hash = await revision(data); cancel(control);
  if (control.expectedRevision !== undefined && control.expectedRevision !== hash) throw new Error('The PDF changed after this link inspection. Reopen link management before applying changes.');
  const records = collect(pdf, geometries, hash), report: PDFLinkInspection = { revision: hash, pages: geometries.map((page, index) => ({ pageNumber: index + 1, width: page.width, height: page.height, rotation: page.rotation })), links: records.map(record => record.info), canEdit: !unsupportedReason, unsupportedReason };
  return { data, pdf, engine, geometries, records, report };
}
export async function inspectPDFLinks(data: ArrayBuffer | Uint8Array, control: PDFLinkControl = {}): Promise<PDFLinkInspection> {
  control.onProgress?.({ completed: 0, total: 1 }); const opened = await load(data, control); control.onProgress?.({ completed: 1, total: 1 }); cancel(control); return opened.report;
}
function writeLink(pdf: PDFDocument, value: PDFLinkDefinition, geometries: Geometry[], previous?: LinkRecord): PDFRef {
  const dictionary = previous ? previous.dictionary.clone(pdf.context) : pdf.context.obj({ Type: 'Annot', Subtype: 'Link', F: 4, H: 'I', NM: PDFString.of(`pdf-editor-link-${crypto.randomUUID()}`) });
  const page = geometries[value.pageNumber - 1], old = previous?.info.definition;
  dictionary.set(key('Rect'), pdf.context.obj(nativeRect(value.rect, page))); dictionary.set(key('P'), pdf.getPage(value.pageNumber - 1).ref);
  if (!previous || value.description !== old?.description) {
    if (value.description) dictionary.set(key('Contents'), PDFHexString.fromText(value.description)); else dictionary.delete(key('Contents'));
  }
  const border = value.border!;
  if (!previous || JSON.stringify(border) !== JSON.stringify(old?.border) || geometries[previous.pageIndex].unit !== page.unit) {
    const sourceBS = dictionary.lookup(key('BS')), bs = sourceBS instanceof PDFDict ? sourceBS.clone(pdf.context) : pdf.context.obj({ Type: 'Border' });
    bs.set(key('W'), PDFNumber.of(border.width / page.unit)); bs.set(key('S'), key(border.style === 'dashed' ? 'D' : border.style === 'underline' ? 'U' : 'S'));
    if (border.style === 'dashed' && !bs.has(key('D'))) {
      const previousBorder = dictionary.lookup(key('Border')), dash = previousBorder instanceof PDFArray && previousBorder.size() === 4 ? previousBorder.lookup(3) : undefined;
      bs.set(key('D'), dash instanceof PDFArray ? dash.clone(pdf.context) : pdf.context.obj([3 / (previous ? geometries[previous.pageIndex].unit : page.unit), 3 / (previous ? geometries[previous.pageIndex].unit : page.unit)]));
    }
    if (border.style === 'dashed' && previous && geometries[previous.pageIndex].unit !== page.unit) {
      const dash = bs.lookup(key('D'));
      if (!(dash instanceof PDFArray)) throw new Error('This dashed border cannot be moved safely.');
      bs.set(key('D'), pdf.context.obj(dash.asArray().map((_, index) => number(dash.lookup(index)) * geometries[previous.pageIndex].unit / page.unit)));
    }
    if (border.style !== 'dashed') bs.delete(key('D'));
    dictionary.set(key('BS'), bs); dictionary.set(key('Border'), pdf.context.obj([0, 0, border.width / page.unit]));
    if (!previous || border.color !== old?.border?.color) dictionary.set(key('C'), pdf.context.obj([1, 3, 5].map(index => parseInt(border.color.slice(index, index + 2), 16) / 255)));
  }
  writeTarget(pdf, dictionary, value.target, geometries);
  return pdf.context.register(dictionary);
}
function equivalent(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.001;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(property => Object.hasOwn(right, property) && equivalent(left[property], right[property]));
}
/** Only the selected annotation occurrence is replaced; shared actions/destinations remain untouched. */
export async function applyPDFLinks(input: ArrayBuffer | Uint8Array, operations: PDFLinkOperation[], control: PDFLinkControl = {}): Promise<Uint8Array> {
  if (!Array.isArray(operations) || operations.length > LIMIT.operations) throw new Error('Too many link operations.');
  const opened = await load(input, control); if (!operations.length) return new Uint8Array(opened.data);
  if (!opened.report.canEdit) throw new Error(opened.report.unsupportedReason);
  const { pdf, geometries, records } = opened, indexed = new Map(records.map(record => [record.info.id, record])), touched = new Set<string>();
  const prepared = operations.map(operation => {
    if (!operation || !['create', 'update', 'remove'].includes(operation.type)) throw new Error('Unknown link operation.');
    if (operation.type === 'create') return { operation, value: definition(operation.definition, geometries) };
    const record = indexed.get(operation.id); if (!record || touched.has(operation.id)) throw new Error('A link selection is stale, missing, or used by more than one operation. Reopen link management.'); touched.add(operation.id);
    if (operation.type === 'remove' && !record.info.removable) throw new Error(record.info.unsupportedReason ?? 'This link cannot be removed safely.');
    if (operation.type === 'update' && !record.info.editable) throw new Error(record.info.unsupportedReason ?? 'This link is read-only.');
    return { operation, record, value: operation.type === 'update' ? definition(operation.definition, geometries) : undefined };
  });
  const arrays = new Map<number, Array<PDFObject | null>>(), expected: Array<{ ref: PDFRef; value: PDFLinkDefinition }> = [];
  const pageArray = (pageIndex: number) => {
    let items = arrays.get(pageIndex); if (!items) { const original = pdf.getPage(pageIndex).node.lookup(key('Annots')); items = original instanceof PDFArray ? [...original.asArray()] : []; arrays.set(pageIndex, items); } return items;
  };
  for (const [index, item] of prepared.entries()) {
    control.onProgress?.({ completed: index, total: prepared.length }); cancel(control);
    if (item.operation.type === 'remove') pageArray(item.record!.pageIndex)[item.record!.index] = null;
    else {
      const value = item.value!, ref = writeLink(pdf, value, geometries, item.record); expected.push({ ref, value });
      if (item.record && item.record.pageIndex === value.pageNumber - 1) pageArray(item.record.pageIndex)[item.record.index] = ref;
      else { if (item.record) pageArray(item.record.pageIndex)[item.record.index] = null; pageArray(value.pageNumber - 1).push(ref); }
    }
    if (index % 25 === 0) await pause();
  }
  for (const [index, items] of arrays) { const kept = items.filter((value): value is PDFObject => value !== null); if (kept.length) pdf.getPage(index).node.set(key('Annots'), pdf.context.obj(kept)); else pdf.getPage(index).node.delete(key('Annots')); }
  cancel(control); const serialized = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }); cancel(control);
  const native = strict(opened.engine, () => new opened.engine.PDFDocument(serialized), value => value.destroy()); let output: Uint8Array;
  try {
    const buffer = strict(opened.engine, () => native.saveToBuffer('incremental=no,garbage=1,compress=yes,regenerate-id=no'), value => value.destroy());
    try { output = new Uint8Array(buffer.asUint8Array()); } finally { buffer.destroy(); }
  } finally { native.destroy(); }
  cancel(control); const checked = await load(output, { signal: control.signal });
  if (checked.report.pages.length !== opened.report.pages.length || checked.records.length !== records.length + operations.filter(operation => operation.type === 'create').length - operations.filter(operation => operation.type === 'remove').length) throw new Error('The saved PDF failed link-count verification.');
  for (const item of expected) {
    const actual = checked.records.find(record => record.raw instanceof PDFRef && record.raw.toString() === item.ref.toString() && record.info.pageNumber === item.value.pageNumber)?.info.definition;
    if (!actual || !equivalent(actual, item.value)) throw new Error('The saved PDF did not preserve the requested link destination or appearance.');
  }
  control.onProgress?.({ completed: operations.length, total: operations.length }); cancel(control); return output;
}
