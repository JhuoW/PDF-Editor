import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFObject, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';
import type { CleanupCategory, CleanupControl, CleanupFinding, CleanupOptions, CleanupReport, CleanupResult } from './DocumentCleanupTypes';
export type * from './DocumentCleanupTypes';

const key = PDFName.of;
const categories: CleanupCategory[] = ['metadata', 'attachments', 'activeContent', 'comments', 'links', 'forms', 'privateData'];
const counts = (): Record<CleanupCategory, number> => ({ metadata: 0, attachments: 0, activeContent: 0, comments: 0, links: 0, forms: 0, privateData: 0 });
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function cancelled(control: CleanupControl) { if (control.signal?.aborted) throw new DOMException('Document cleanup cancelled.', 'AbortError'); }
const markup = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'Redact', 'Watermark']);
const multimedia = new Set(['Screen', 'Movie', 'Sound', 'RichMedia', '3D']);
const actionKinds = new Set(['GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView']);
// A bare /Private key is not enough to identify application data. The complete
// standardized PieceInfo subtree already includes its application /Private data.
const privateKeys = new Set(['PieceInfo', 'SpiderInfo']);
const limits = [
  'Selective cleanup removes the identified PDF features only. Invisible or covered page text, OCR, layers, image pixels, font data, and unknown custom properties may remain. Export a visible copy to remove arbitrary hidden content.',
  'Removing private data deletes known application records, including this editor’s watermark templates and management identifiers. Existing page artwork remains, but those settings can no longer be managed.',
  'Form removal deletes fields, widgets, current values, and defaults. It does not erase form answers that were previously flattened into page content.',
];

interface Node { object: PDFObject; parents: Set<Node>; path: string; number?: number }
interface Graph { nodes: Map<PDFObject, Node>; pages: Map<PDFObject, number>; streams: Map<PDFDict, PDFRawStream>; nameMaps: Set<PDFDict> }
interface Carrier { dictionary: PDFDict; name: string; category: CleanupCategory }
interface Scan {
  report: CleanupReport; graph: Graph; carriers: Carrier[];
  targets: Record<CleanupCategory, Set<PDFObject>>;
  annotations: Map<PDFDict, CleanupCategory>;
  unsafeActions: Set<PDFDict>; uriActions: Set<PDFDict>; info?: PDFObject;
}

function resolved(document: PDFDocument, value: PDFObject | undefined, path: string): PDFObject | undefined {
  const result = document.context.lookup(value);
  if (value instanceof PDFRef && result === undefined) throw new Error(`The PDF has a dangling object reference at ${path}. The original file was preserved.`);
  return result;
}
function name(dictionary: PDFDict, property: string): string | undefined {
  const value = dictionary.lookup(key(property)); return value instanceof PDFName ? value.decodeText() : undefined;
}
function string(value: PDFObject | undefined): string | undefined { return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined; }
function graphOf(document: PDFDocument): Graph {
  const graph: Graph = { nodes: new Map(), pages: new Map(document.getPages().map((page, index) => [page.node, index + 1])), streams: new Map(), nameMaps: new Set() };
  const refs = new Map(document.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref.objectNumber]));
  const queue: Array<{ value?: PDFObject; path: string; parent?: Node }> = [
    { value: document.catalog, path: 'Root' }, { value: document.context.trailerInfo.Info, path: 'Info' }, { value: document.context.trailerInfo.ID, path: 'ID' },
  ];
  for (let position = 0; position < queue.length; position++) {
    if (queue.length > 1_000_000) throw new Error('This PDF object graph is too large to clean safely in this browser.');
    const item = queue[position], object = resolved(document, item.value, item.path); if (!object) continue;
    let node = graph.nodes.get(object);
    if (node) { if (item.parent) node.parents.add(item.parent); continue; }
    node = { object, parents: new Set(item.parent ? [item.parent] : []), path: item.path, number: refs.get(object) }; graph.nodes.set(object, node);
    if (object instanceof PDFRawStream) { graph.streams.set(object.dict, object); queue.push({ value: object.dict, path: `${item.path}/stream`, parent: node }); }
    else if (object instanceof PDFArray) object.asArray().forEach((value, index) => queue.push({ value, path: `${item.path}/${index}`, parent: node }));
    else if (object instanceof PDFDict) for (const [property, value] of object.entries()) queue.push({ value, path: `${item.path}/${property.decodeText()}`, parent: node });
  }
  identifyNameMaps(document, graph);
  return graph;
}
/** Resource names, appearance states and structure roles are arbitrary PDF names.
 * Mark these maps from their owning structure, never from a map's own key names. */
function identifyNameMaps(document: PDFDocument, graph: Graph) {
  const mark = (object: PDFObject | undefined) => { if (object instanceof PDFDict) graph.nameMaps.add(object); };
  const resources = (object: PDFObject | undefined) => {
    if (!(object instanceof PDFDict)) return; mark(object);
    for (const property of ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties']) mark(object.lookup(key(property)));
  };
  const tree = (root: PDFObject | undefined) => {
    const queue = root ? [root] : [], seen = new Set<PDFObject>();
    for (let index = 0; index < queue.length; index++) {
      const object = queue[index]; if (seen.has(object)) continue; seen.add(object);
      if (!(object instanceof PDFDict)) continue; mark(object);
      const kids = object.lookup(key('Kids')); if (kids instanceof PDFArray) queue.push(...children(document, kids));
    }
  };
  const catalogNames = document.catalog.lookup(key('Names')); mark(catalogNames);
  if (catalogNames instanceof PDFDict) for (const value of catalogNames.values()) tree(resolved(document, value, 'name tree'));
  mark(document.catalog.lookup(key('Dests'))); tree(document.catalog.lookup(key('PageLabels')));
  const acro = document.catalog.lookup(key('AcroForm')); if (acro instanceof PDFDict) resources(acro.lookup(key('DR')));
  for (const { object } of graph.nodes.values()) if (object instanceof PDFDict) {
    const type = name(object, 'Type'), subtype = name(object, 'Subtype');
    if (type === 'Page' || type === 'Pages' || subtype === 'Form' || subtype === 'Type3' || type === 'Pattern' || (graph.streams.has(object) && object.has(key('PatternType')))) resources(object.lookup(key('Resources')));
    if (type === 'Font' && subtype === 'Type3') mark(object.lookup(key('CharProcs')));
    if (type === 'StructTreeRoot') { mark(object.lookup(key('RoleMap'))); mark(object.lookup(key('ClassMap'))); tree(object.lookup(key('ParentTree'))); tree(object.lookup(key('IDTree'))); }
    if (type === 'Namespace') mark(object.lookup(key('RoleMapNS')));
    if (type === 'Annot' || subtype === 'Widget' || (object.has(key('Rect')) && (markup.has(subtype ?? '') || multimedia.has(subtype ?? '')))) {
      const ap = object.lookup(key('AP')); mark(ap);
      if (ap instanceof PDFDict) for (const property of ['N', 'R', 'D']) mark(ap.lookup(key(property)));
      resources(object.lookup(key('DR')));
    }
  }
  // Event names are a map as well. Perform this after resource maps have been
  // identified, so a font named /AA cannot turn the font dictionary into a map.
  for (const { object } of graph.nodes.values()) if (object instanceof PDFDict && !graph.nameMaps.has(object)) mark(object.lookup(key('AA')));
}
function pagesFor(graph: Graph, object: PDFObject): number[] {
  const origin = graph.nodes.get(object); if (!origin) return [];
  const visited = new Set<Node>(), queue = [origin], result = new Set<number>();
  for (let position = 0; position < queue.length; position++) {
    const node = queue[position]; if (visited.has(node)) continue; visited.add(node);
    const page = graph.pages.get(node.object); if (page) { result.add(page); continue; }
    queue.push(...node.parents);
  }
  return [...result].sort((a, b) => a - b);
}
function safeAction(dictionary: PDFDict): boolean {
  const type = name(dictionary, 'S');
  if (type === 'GoTo') return true;
  if (type !== 'URI') return false;
  const uri = string(dictionary.lookup(key('URI')));
  return typeof uri === 'string' && /^(https?:\/\/|mailto:)/i.test(uri) && !/[\r\n\0]/.test(uri);
}
function children(document: PDFDocument, object: PDFObject): PDFObject[] {
  if (object instanceof PDFRawStream) return [object.dict];
  const values = object instanceof PDFArray ? object.asArray() : object instanceof PDFDict ? object.values() : [];
  return values.map(value => resolved(document, value, 'selected payload')).filter((value): value is PDFObject => value !== undefined);
}
/** Whole private/metadata/attachment subtrees are owned payload. Page aliases are
 * deliberately retained by the graph, then cause an atomic failure if shared. */
function collectPayload(document: PDFDocument, target: Set<PDFObject>, start: PDFObject | undefined) {
  if (!start) return;
  const queue = [start], seen = new Set<PDFObject>();
  for (let index = 0; index < queue.length; index++) {
    const object = queue[index]; if (seen.has(object)) continue; seen.add(object);
    if (object instanceof PDFDict && ['Page', 'Pages', 'Catalog', 'Font'].includes(name(object, 'Type') ?? '')) continue;
    if (object instanceof PDFDict || object instanceof PDFArray || object instanceof PDFRawStream || object instanceof PDFString || object instanceof PDFHexString) target.add(object);
    queue.push(...children(document, object));
  }
}
/** Track appearance streams without claiming ownership of shared font programs. */
function collectAppearance(document: PDFDocument, target: Set<PDFObject>, start: PDFObject | undefined) {
  if (!start) return;
  const queue = [start], seen = new Set<PDFObject>();
  for (let index = 0; index < queue.length; index++) {
    const object = queue[index]; if (seen.has(object)) continue; seen.add(object);
    if (object instanceof PDFRawStream) {
      target.add(object);
      const resources = object.dict.lookup(key('Resources'));
      if (resources instanceof PDFDict) { const xobjects = resources.lookup(key('XObject')); if (xobjects) queue.push(xobjects); }
    } else if (object instanceof PDFArray || object instanceof PDFDict) queue.push(...children(document, object));
  }
}

async function digest(data: ArrayBuffer) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join(''); }
async function open(data: ArrayBuffer, control: CleanupControl) {
  cancelled(control); const revision = await digest(data); cancelled(control);
  if (control.expectedRevision !== undefined && control.expectedRevision !== revision) throw new Error('The PDF changed after inspection. Scan and preview the current document again.');
  const engine = await loadMuPDF(), native = new engine.PDFDocument(new Uint8Array(data));
  let repaired: boolean;
  try {
    const trailer = native.getTrailer(), encryption = trailer.get('Encrypt');
    try { if (!encryption.isNull() || native.needsPassword()) throw new Error('Unlock this PDF before using document cleanup.'); }
    finally { encryption.destroy(); trailer.destroy(); }
    if (native.countPages() < 1) throw new Error('The PDF has no readable pages.');
    for (let index = 0; index < native.countPages(); index++) { const page = native.loadPage(index); try { if (!page.getBounds().every(Number.isFinite)) throw new Error('The PDF has invalid page geometry.'); } finally { page.destroy(); } }
    repaired = native.wasRepaired();
  } finally { native.destroy(); }
  const document = await PDFDocument.load(data, { updateMetadata: false }); cancelled(control);
  return { document, revision, repaired };
}

function scan(document: PDFDocument, revision: string, repaired = false): Scan {
  const graph = graphOf(document), findings: CleanupFinding[] = [], totals = counts(), carriers: Carrier[] = [];
  const targets = Object.fromEntries(categories.map(category => [category, new Set<PDFObject>()])) as Scan['targets'];
  const annotations = new Map<PDFDict, CleanupCategory>(), unsafeActions = new Set<PDFDict>(), uriActions = new Set<PDFDict>();
  const findingIds = new Set<string>();
  const add = (category: CleanupCategory, object: PDFObject, label: string, affectsAppearance = false, details?: string, suffix = '') => {
    const node = graph.nodes.get(object), id = `${category}:${node?.number ?? node?.path ?? 'document'}:${suffix}`; if (findingIds.has(id)) return;
    findingIds.add(id); totals[category]++; findings.push({ id, category, label, details, affectsAppearance, pages: pagesFor(graph, object) });
  };
  const carrier = (dictionary: PDFDict, property: string, category: CleanupCategory, label: string) => {
    carriers.push({ dictionary, name: property, category });
    const value = resolved(document, dictionary.get(key(property)), property); collectPayload(document, targets[category], value);
    add(category, value ?? dictionary, label, false, undefined, property);
  };
  const info = resolved(document, document.context.trailerInfo.Info, 'Info');
  if (info) { add('metadata', info, 'Document information dictionary'); collectPayload(document, targets.metadata, info); }
  const identifiers = resolved(document, document.context.trailerInfo.ID, 'ID');
  if (identifiers) { add('metadata', identifiers, 'Original file identifiers'); collectPayload(document, targets.metadata, identifiers); }
  let hasSignatures = false;
  const acro = document.catalog.lookup(key('AcroForm')), hasXfa = acro instanceof PDFDict && acro.has(key('XFA'));
  const permissions = document.catalog.lookup(key('Perms')); if (permissions instanceof PDFDict && permissions.has(key('DocMDP'))) hasSignatures = true;
  const actionCarrierTargets = new Set<PDFObject>();
  for (const { object } of graph.nodes.values()) if (object instanceof PDFDict && !graph.nameMaps.has(object)) {
    for (const property of ['A', 'OpenAction']) { const action = object.lookup(key(property)); if (action instanceof PDFDict) actionCarrierTargets.add(action); }
    const aa = object.lookup(key('AA')); if (aa instanceof PDFDict) for (const value of aa.values()) { const action = resolved(document, value, 'AA'); if (action) actionCarrierTargets.add(action); }
  }
  for (const { object } of graph.nodes.values()) {
    if (!(object instanceof PDFDict) || graph.nameMaps.has(object)) continue;
    const type = name(object, 'Type'), subtype = name(object, 'Subtype'), stream = graph.streams.get(object);
    if (object.has(key('ByteRange')) || (name(object, 'FT') === 'Sig' && object.lookup(key('V')) !== undefined && object.lookup(key('V')) !== PDFNull)) hasSignatures = true;
    if (object.has(key('Metadata'))) carrier(object, 'Metadata', 'metadata', 'Embedded metadata');
    if (stream && (type === 'Metadata' || subtype === 'XML')) { add('metadata', stream, 'Metadata/XML stream'); collectPayload(document, targets.metadata, stream); }
    for (const property of object.keys().map(value => value.decodeText())) if (privateKeys.has(property) || property.startsWith('PDFEditor')) carrier(object, property, 'privateData', `Application data: ${property}`);
    if (graph.pages.has(object) && object.has(key('Thumb'))) carrier(object, 'Thumb', 'privateData', 'Saved page thumbnail');
    if (object.has(key('AF'))) carrier(object, 'AF', 'attachments', 'Associated-file list');
    if (type === 'Filespec' || object.has(key('EF'))) {
      const fileName = string(object.lookup(key('UF'))) ?? string(object.lookup(key('F'))) ?? 'Unnamed file';
      add('attachments', object, `File specification: ${fileName}`); targets.attachments.add(object);
      for (const property of ['F', 'UF', 'DOS', 'Mac', 'Unix', 'Desc', 'EF', 'RF']) collectPayload(document, targets.attachments, object.lookup(key(property)));
    }
    if (stream && type === 'EmbeddedFile') { add('attachments', stream, 'Embedded file payload'); collectPayload(document, targets.attachments, stream); }
    for (const property of ['AA', 'OpenAction']) if (object.has(key(property))) {
      carriers.push({ dictionary: object, name: property, category: 'activeContent' }); add('activeContent', object, property === 'AA' ? 'Additional event actions' : 'Automatic open action', false, undefined, property);
      const action = object.lookup(key(property)); if (action instanceof PDFDict || action instanceof PDFArray) targets.activeContent.add(action);
    }
    const actionType = name(object, 'S');
    const isAction = type === 'Action' || actionCarrierTargets.has(object) || (type !== 'StructElem' && actionKinds.has(actionType ?? ''));
    if (isAction) {
      if (object.has(key('JS'))) carrier(object, 'JS', 'activeContent', 'JavaScript payload');
      if (actionType === 'URI') { uriActions.add(object); targets.links.add(object); collectPayload(document, targets.links, object.lookup(key('URI'))); add('links', object, 'External URI action'); }
      if (!safeAction(object)) { unsafeActions.add(object); targets.activeContent.add(object); add('activeContent', object, `Action: ${actionType ?? 'unknown'}`); }
      if (object.has(key('Next'))) {
        carriers.push({ dictionary: object, name: 'Next', category: 'activeContent' }); add('activeContent', object, 'Chained actions', false, undefined, 'Next');
        const next = object.lookup(key('Next')); if (next instanceof PDFDict || next instanceof PDFArray) targets.activeContent.add(next);
      }
      for (const property of ['JS', 'Win', 'Unix', 'Mac', 'Sound', 'Movie', 'R']) if (!safeAction(object)) collectPayload(document, targets.activeContent, object.lookup(key(property)));
    }
    let annotationCategory: CleanupCategory | undefined;
    if (subtype === 'Widget') annotationCategory = 'forms';
    else if (subtype === 'Link') annotationCategory = 'links';
    else if (subtype === 'FileAttachment') annotationCategory = 'attachments';
    else if (multimedia.has(subtype ?? '')) annotationCategory = 'activeContent';
    else if (markup.has(subtype ?? '')) annotationCategory = 'comments';
    if (annotationCategory && (type === 'Annot' || object.has(key('Rect')))) {
      annotations.set(object, annotationCategory); targets[annotationCategory].add(object);
      add(annotationCategory, object, `${subtype} annotation`, true, subtype === 'Redact' ? 'Removing a redaction annotation does not redact the underlying page content.' : undefined);
      for (const property of ['Contents', 'RC', 'T', 'Subj']) collectPayload(document, targets[annotationCategory], object.lookup(key(property)));
      collectAppearance(document, targets[annotationCategory], object.lookup(key('AP')));
      if (annotationCategory === 'activeContent') for (const property of ['RichMediaContent', 'RichMediaSettings', '3DD', '3DA', 'Movie', 'Sound']) collectPayload(document, targets.activeContent, object.lookup(key(property)));
    }
  }
  const names = document.catalog.lookup(key('Names'));
  if (names !== undefined && !(names instanceof PDFDict)) throw new Error('The PDF name dictionary is invalid.');
  if (names instanceof PDFDict) {
    if (names.has(key('EmbeddedFiles'))) carrier(names, 'EmbeddedFiles', 'attachments', 'Embedded-file name tree');
    if (names.has(key('JavaScript'))) carrier(names, 'JavaScript', 'activeContent', 'Document JavaScript name tree');
    if (names.has(key('Renditions'))) carrier(names, 'Renditions', 'activeContent', 'Multimedia rendition name tree');
  }
  if (document.catalog.has(key('Collection'))) carrier(document.catalog, 'Collection', 'attachments', 'Attachment portfolio');
  if (acro !== undefined) {
    if (!(acro instanceof PDFDict)) throw new Error('The PDF form dictionary is invalid.');
    add('forms', acro, 'AcroForm fields and defaults', true); targets.forms.add(acro);
    const fields = acro.lookup(key('Fields')); if (fields) {
      const seen = new Set<PDFObject>(), queue = [fields];
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index]; if (seen.has(item)) continue; seen.add(item);
        if (item instanceof PDFArray) queue.push(...children(document, item));
        else if (item instanceof PDFDict) {
          targets.forms.add(item);
          for (const property of ['V', 'DV', 'RV']) collectPayload(document, targets.forms, item.lookup(key(property)));
          collectAppearance(document, targets.forms, item.lookup(key('AP')));
          const kids = item.lookup(key('Kids')); if (kids) queue.push(kids);
        }
      }
    }
  }
  const unsupportedReason = hasSignatures ? 'Signed or certified PDFs cannot be cleaned. Use an unsigned source document.' : hasXfa ? 'XFA forms cannot be selectively cleaned safely.' : repaired ? 'The PDF is damaged or required repair. Selective cleanup cannot guarantee its integrity.' : undefined;
  const limitations = [...limits], layers = [...graph.nodes.keys()].filter(object => object instanceof PDFDict && name(object, 'Type') === 'OCG').length;
  if (layers) limitations.push(`${layers} optional-content group${layers === 1 ? '' : 's'} found; layer contents are retained by selective cleanup.`);
  return { report: { revision, pageCount: document.getPageCount(), findings, counts: totals, canClean: !unsupportedReason, unsupportedReason, hasSignatures, hasXfa, limitations }, graph, carriers, targets, annotations, unsafeActions, uriActions, info };
}

export async function inspectPDFCleanup(data: ArrayBuffer, control: CleanupControl = {}): Promise<CleanupReport> {
  control.onProgress?.({ phase: 'inspect', completed: 0, total: 1 }); const { document, revision, repaired } = await open(data, control);
  const report = scan(document, revision, repaired).report; cancelled(control); control.onProgress?.({ phase: 'inspect', completed: 1, total: 1 }); return report;
}

export async function cleanPDF(data: ArrayBuffer, options: CleanupOptions, control: CleanupControl = {}): Promise<CleanupResult> {
  for (const category of categories) if (typeof options?.[category] !== 'boolean') throw new Error(`Choose whether to remove ${category}.`);
  const { document, revision, repaired } = await open(data, control), before = scan(document, revision, repaired);
  if (!before.report.canClean) throw new Error(before.report.unsupportedReason);
  if (!categories.some(category => options[category])) return { data: new Uint8Array(data.slice(0)), report: before.report, removed: counts() };
  await pause(); cancelled(control); control.onProgress?.({ phase: 'clean', completed: 0, total: 1 });
  if (options.metadata) { document.context.trailerInfo.Info = undefined; document.context.trailerInfo.ID = undefined; }
  for (const carrier of before.carriers) if (options[carrier.category]) carrier.dictionary.delete(key(carrier.name));
  if (options.forms) document.catalog.delete(key('AcroForm'));
  const removedAnnotations = new Set([...before.annotations].filter(([, category]) => options[category]).map(([dictionary]) => dictionary));
  // Popup/response relationships must not retain a deleted annotation graph.
  let changed = true;
  while (changed) { changed = false; for (const [annotation] of before.annotations) if (name(annotation, 'Subtype') === 'Popup' && removedAnnotations.has(annotation.lookup(key('Parent')) as PDFDict) && !removedAnnotations.has(annotation)) { removedAnnotations.add(annotation); changed = true; } }
  for (const page of document.getPages()) {
    const annots = page.node.lookup(key('Annots')); if (annots === undefined) continue; if (!(annots instanceof PDFArray)) throw new Error('A page has an invalid annotation list.');
    page.node.set(key('Annots'), document.context.obj(annots.asArray().filter(item => !removedAnnotations.has(resolved(document, item, 'Annots') as PDFDict))));
  }
  const removedActions = new Set<PDFDict>([...(options.activeContent ? before.unsafeActions : []), ...(options.links ? before.uriActions : [])]);
  for (const { object } of before.graph.nodes.values()) if (object instanceof PDFDict && !before.graph.nameMaps.has(object)) {
    for (const property of ['Popup', 'IRT', 'Parent']) if (removedAnnotations.has(object.lookup(key(property)) as PDFDict)) object.delete(key(property));
    for (const property of ['A', 'OpenAction']) if (removedActions.has(object.lookup(key(property)) as PDFDict)) object.delete(key(property));
    if (options.links && !options.activeContent) {
      const next = object.lookup(key('Next'));
      if (next instanceof PDFDict && removedActions.has(next)) object.delete(key('Next'));
      else if (next instanceof PDFArray) object.set(key('Next'), document.context.obj(next.asArray().filter(item => !removedActions.has(resolved(document, item, 'Next') as PDFDict))));
    }
  }
  const live = graphOf(document);
  for (const category of categories) if (options[category]) for (const target of before.targets[category]) if (live.nodes.has(target)) {
    throw new Error(`Cannot completely remove ${category}: selected data is also referenced by content or an unsupported carrier. No changes were saved. Use a visible copy if those additional references should also be removed.`);
  }
  // Link actions are a separate category and their URL payload must not survive an alias.
  if (options.links) for (const action of removedActions) if (live.nodes.has(action)) throw new Error('A link action has additional references that cannot be safely removed.');
  control.onProgress?.({ phase: 'clean', completed: 1, total: 1 }); await pause(); cancelled(control);
  control.onProgress?.({ phase: 'save', completed: 0, total: 1 });
  const intermediate = await document.save({ updateFieldAppearances: false }), engine = await loadMuPDF(), native = new engine.PDFDocument(intermediate);
  let output: Uint8Array;
  try {
    if (native.wasRepaired() || native.countPages() !== before.report.pageCount) throw new Error('The cleaned document could not be rewritten reliably.');
    const saved = native.saveToBuffer('incremental=no,garbage=1,compress=yes'); try { output = new Uint8Array(saved.asUint8Array()); } finally { saved.destroy(); }
  } finally { native.destroy(); }
  cancelled(control); control.onProgress?.({ phase: 'save', completed: 1, total: 1 }); await pause(); cancelled(control);
  control.onProgress?.({ phase: 'verify', completed: 0, total: 1 });
  const verified = await open(new Uint8Array(output).buffer, { signal: control.signal }), report = scan(verified.document, verified.revision, verified.repaired).report;
  if (!report.canClean || report.pageCount !== before.report.pageCount || categories.some(category => options[category] && report.counts[category] !== 0)) throw new Error('The output did not pass an independent cleanup scan. No changes were saved.');
  const removed = counts(); for (const category of categories) removed[category] = Math.max(0, before.report.counts[category] - report.counts[category]);
  control.onProgress?.({ phase: 'verify', completed: 1, total: 1 }); cancelled(control); return { data: output, report, removed };
}
