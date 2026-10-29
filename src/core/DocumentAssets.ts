import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject,
  PDFRawStream, PDFRef, PDFString, PDFNumber, decodePDFRawStream,
} from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';

export interface DocumentMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

export interface AttachmentInfo {
  /** Valid for this PDF revision; inspect again after any document mutation. */
  id: string;
  name: string;
  description: string;
  mimeType: string;
  size: number;
}

export interface DocumentAttachmentInput {
  name: string;
  description?: string;
  mimeType?: string;
  data: Uint8Array;
}

interface Attachment extends AttachmentInfo {
  dictionary: PDFDict;
  stream: PDFRawStream;
  streams: PDFRawStream[];
}
interface NameEntry { key: string; specification: PDFObject }
interface AttachmentAnnotation { dictionary: PDFDict; specification: PDFDict }
interface Assets {
  attachments: Attachment[];
  names: NameEntry[];
  associatedFiles: Array<{ dictionary: PDFDict; array: PDFArray }>;
  annotations: AttachmentAnnotation[];
  reachable: Set<PDFObject>;
}

const key = PDFName.of;
const metadataKeys: Record<keyof DocumentMetadata, string> = {
  title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords',
};

async function openPDF(data: ArrayBuffer) {
  // This module only accepts unlocked working copies. Ignoring encryption
  // would parse ciphertext and could silently destroy embedded files.
  const document = await PDFDocument.load(data, { updateMetadata: false });
  if (document.getPageCount() < 1) throw new Error('The PDF has no readable pages.');
  return document;
}

function stringValue(dictionary: PDFDict, name: string): string | undefined {
  const value = dictionary.lookup(key(name));
  if (value === undefined) return undefined;
  if (!(value instanceof PDFString || value instanceof PDFHexString)) throw new Error(`Invalid PDF text property: ${name}.`);
  return value.decodeText();
}

function metadata(document: PDFDocument): DocumentMetadata {
  const info = document.context.lookup(document.context.trailerInfo.Info);
  if (info !== undefined && !(info instanceof PDFDict)) throw new Error('The document information dictionary is invalid.');
  return Object.fromEntries(Object.entries(metadataKeys)
    .map(([property, name]) => [property, info ? stringValue(info, name) ?? '' : ''])) as unknown as DocumentMetadata;
}

async function revisionKey(data: ArrayBuffer) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
}

function collectAssets(document: PDFDocument, revision = ''): Assets {
  const result: Assets = { attachments: [], names: [], associatedFiles: [], annotations: [], reachable: new Set() };
  const byDictionary = new Map<PDFDict, Attachment>();
  const register = (object: PDFObject | undefined, path: string, fallbackName?: string): PDFDict => {
    const dictionary = document.context.lookup(object);
    if (!(dictionary instanceof PDFDict)) throw new Error(`Invalid attachment file specification at ${path}.`);
    if (byDictionary.has(dictionary)) return dictionary;
    const embedded = dictionary.lookup(key('EF'));
    if (!(embedded instanceof PDFDict)) throw new Error(`Attachment at ${path} has no embedded file data.`);
    const streams: PDFRawStream[] = [];
    for (const [, item] of embedded.entries()) {
      const stream = document.context.lookup(item);
      if (!(stream instanceof PDFRawStream)) throw new Error(`Attachment at ${path} contains an invalid embedded stream.`);
      streams.push(stream);
    }
    const preferred = embedded.lookup(key('UF')) ?? embedded.lookup(key('F')) ?? streams[0];
    if (!(preferred instanceof PDFRawStream)) throw new Error(`Attachment at ${path} has no readable embedded file.`);
    const name = stringValue(dictionary, 'UF') ?? stringValue(dictionary, 'F') ?? fallbackName;
    if (!name) throw new Error(`Attachment at ${path} has no filename.`);
    const mime = preferred.dict.lookup(key('Subtype'));
    if (mime !== undefined && !(mime instanceof PDFName)) throw new Error(`Attachment "${name}" has an invalid MIME type.`);
    let bytes: Uint8Array;
    try { bytes = decodePDFRawStream(preferred).decode(); }
    catch (cause) { throw new Error(`Cannot decode attachment "${name}". Its stream filter may be unsupported.`, { cause }); }
    const parameters = preferred.dict.lookup(key('Params'));
    if (parameters !== undefined && !(parameters instanceof PDFDict)) throw new Error(`Attachment "${name}" has invalid stream parameters.`);
    const declaredSize = parameters?.lookup(key('Size'));
    if (declaredSize !== undefined && (!(declaredSize instanceof PDFNumber) || declaredSize.asNumber() !== bytes.byteLength))
      throw new Error(`Attachment "${name}" has a decoded size that does not match its declared size.`);
    const reference = document.context.getObjectRef(dictionary);
    const attachment: Attachment = {
      id: `${revision}:${reference ? `filespec:${reference.toString()}` : `inline:${path}`}`,
      name, description: stringValue(dictionary, 'Desc') ?? '',
      mimeType: mime instanceof PDFName ? mime.decodeText() : 'application/octet-stream',
      size: bytes.byteLength, dictionary, stream: preferred, streams,
    };
    byDictionary.set(dictionary, attachment);
    result.attachments.push(attachment);
    return dictionary;
  };

  const visitedTree = new Set<PDFDict>();
  const readNameTree = (object: PDFObject, path: string) => {
    const node = document.context.lookup(object);
    if (!(node instanceof PDFDict) || visitedTree.has(node)) throw new Error('The embedded-file name tree is invalid or cyclic.');
    visitedTree.add(node);
    if (node.keys().some(name => !['Names', 'Kids', 'Limits'].includes(name.decodeText())))
      throw new Error('The embedded-file name tree contains an unsupported extension.');
    const names = node.lookup(key('Names'));
    const kids = node.lookup(key('Kids'));
    if (names !== undefined && kids !== undefined) throw new Error('The embedded-file name tree mixes names and child nodes.');
    if (names !== undefined) {
      if (!(names instanceof PDFArray) || names.size() % 2 !== 0) throw new Error('The embedded-file name array is invalid.');
      for (let index = 0; index < names.size(); index += 2) {
        const name = names.lookup(index);
        if (!(name instanceof PDFString || name instanceof PDFHexString)) throw new Error('An embedded-file name is invalid.');
        const specification = names.get(index + 1);
        result.names.push({ key: name.decodeText(), specification });
        register(specification, `${path}/Names/${index + 1}`, name.decodeText());
      }
    } else if (kids !== undefined) {
      if (!(kids instanceof PDFArray)) throw new Error('The embedded-file child array is invalid.');
      for (let index = 0; index < kids.size(); index++) readNameTree(kids.get(index), `${path}/Kids/${index}`);
    }
  };
  const catalogNames = document.catalog.lookup(key('Names'));
  if (catalogNames !== undefined && !(catalogNames instanceof PDFDict)) throw new Error('The catalog name dictionary is invalid.');
  const embeddedFiles = catalogNames?.get(key('EmbeddedFiles'));
  if (embeddedFiles) readNameTree(embeddedFiles, 'Root/Names/EmbeddedFiles');
  if (new Set(result.names.map(entry => entry.key)).size !== result.names.length)
    throw new Error('The embedded-file name tree contains duplicate keys.');

  const visit = (object: PDFObject | undefined, path: string) => {
    const resolved = document.context.lookup(object);
    if (object instanceof PDFRef && resolved === undefined) throw new Error(`The PDF contains a dangling object reference at ${path}.`);
    if (!resolved || result.reachable.has(resolved)) return;
    result.reachable.add(resolved);
    if (resolved instanceof PDFRawStream) { visit(resolved.dict, `${path}/stream`); return; }
    if (resolved instanceof PDFArray) {
      for (let index = 0; index < resolved.size(); index++) visit(resolved.get(index), `${path}/${index}`);
    } else if (resolved instanceof PDFDict) {
      // AF is allowed on the catalog, pages, annotations, structure elements,
      // and other objects. Walking the whole live graph covers every carrier.
      const associated = resolved.lookup(key('AF'));
      if (associated !== undefined) {
        if (!(associated instanceof PDFArray)) throw new Error(`Invalid associated-file array at ${path}.`);
        result.associatedFiles.push({ dictionary: resolved, array: associated });
        for (let index = 0; index < associated.size(); index++) register(associated.get(index), `${path}/AF/${index}`);
      }
      if (resolved.lookup(key('Subtype')) === key('FileAttachment')) {
        const specification = register(resolved.get(key('FS')), `${path}/FS`);
        result.annotations.push({ dictionary: resolved, specification });
      } else if (resolved.lookup(key('Type')) === key('Filespec') && resolved.has(key('EF'))) {
        register(resolved, path);
      }
      for (const [name, value] of resolved.entries()) visit(value, `${path}/${name.decodeText()}`);
    }
  };
  visit(document.catalog, 'Root');
  visit(document.context.trailerInfo.Info, 'Info');
  return result;
}

/** Metadata is document Info only; hasXmp describes the catalog Metadata entry. */
export async function inspectDocumentAssets(data: ArrayBuffer): Promise<{
  metadata: DocumentMetadata; hasXmp: boolean; attachments: AttachmentInfo[];
}> {
  const document = await openPDF(data);
  const assets = collectAssets(document, await revisionKey(data));
  return {
    metadata: metadata(document), hasXmp: document.catalog.has(key('Metadata')),
    attachments: assets.attachments.map(({ id, name, description, mimeType, size }) => ({ id, name, description, mimeType, size })),
  };
}

async function rewrite(document: PDFDocument): Promise<Uint8Array> {
  const intermediate = await document.save({ updateFieldAppearances: false });
  const engine = await loadMuPDF();
  const pdf = new engine.PDFDocument(intermediate);
  try {
    if (pdf.wasRepaired() || pdf.countPages() !== document.getPageCount())
      throw new Error('The PDF could not be rewritten reliably; the original document has been preserved.');
    // A full rewrite with garbage collection removes unreachable old Info,
    // XMP and attachment streams, including bytes in prior PDF revisions.
    // Level 1 removes unreachable objects without compacting object numbers.
    // Form/widget IDs in the editable workspace are based on those references.
    const buffer = pdf.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { return new Uint8Array(buffer.asUint8Array()); }
    finally { buffer.destroy(); }
  } finally { pdf.destroy(); }
}

/** Save four Info fields and remove stale catalog XMP so readers cannot show old values. */
export async function updateDocumentMetadata(data: ArrayBuffer, values: DocumentMetadata): Promise<Uint8Array> {
  for (const property of Object.keys(metadataKeys) as (keyof DocumentMetadata)[]) {
    if (typeof values[property] !== 'string') throw new Error(`Metadata ${property} must be text.`);
  }
  const document = await openPDF(data);
  collectAssets(document);
  const existingInfo = document.context.lookup(document.context.trailerInfo.Info);
  if (existingInfo !== undefined && !(existingInfo instanceof PDFDict)) throw new Error('The document information dictionary is invalid.');
  let info: PDFDict | undefined = existingInfo;
  if (!info) {
    info = document.context.obj({});
    document.context.trailerInfo.Info = document.context.register(info);
  }
  for (const [property, name] of Object.entries(metadataKeys)) {
    const value = values[property as keyof DocumentMetadata];
    if (value === '') info.delete(key(name));
    else info.set(key(name), PDFHexString.fromText(value));
  }
  document.catalog.delete(key('Metadata'));
  return rewrite(document);
}

/** Clear document-level Info and catalog XMP, not page content or all embedded metadata. */
export async function clearDocumentMetadata(data: ArrayBuffer): Promise<Uint8Array> {
  const document = await openPDF(data);
  collectAssets(document);
  document.context.trailerInfo.Info = undefined;
  document.catalog.delete(key('Metadata'));
  return rewrite(document);
}

function writeNameTree(document: PDFDocument, entries: NameEntry[]) {
  const existingNames = document.catalog.lookup(key('Names'));
  if (existingNames !== undefined && !(existingNames instanceof PDFDict)) throw new Error('The catalog name dictionary is invalid.');
  let names: PDFDict | undefined = existingNames;
  if (entries.length === 0) {
    names?.delete(key('EmbeddedFiles'));
    if (names?.keys().length === 0) document.catalog.delete(key('Names'));
    return;
  }
  if (!names) {
    names = document.context.obj({});
    document.catalog.set(key('Names'), names);
  }
  const encoded = entries.map(entry => ({ ...entry, encoded: PDFHexString.fromText(entry.key) }));
  encoded.sort((left, right) => left.encoded.asString() < right.encoded.asString() ? -1
    : left.encoded.asString() > right.encoded.asString() ? 1 : 0);
  const tree = document.context.obj({ Names: encoded.flatMap(entry => [entry.encoded, entry.specification]) });
  names.set(key('EmbeddedFiles'), document.context.register(tree));
}

export async function addDocumentAttachment(data: ArrayBuffer, input: DocumentAttachmentInput): Promise<Uint8Array> {
  if (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name).some(character => character.charCodeAt(0) < 32))
    throw new Error('Attachment filename must be nonempty text without control characters.');
  if (!(input.data instanceof Uint8Array)) throw new Error('Attachment content must be bytes.');
  if (input.description !== undefined && typeof input.description !== 'string') throw new Error('Attachment description must be text.');
  if (input.mimeType !== undefined && (typeof input.mimeType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.mimeType)))
    throw new Error('Attachment MIME type must have the form type/subtype.');
  const document = await openPDF(data);
  const assets = collectAssets(document);
  const stream = document.context.flateStream(new Uint8Array(input.data), {
    Type: 'EmbeddedFile', Subtype: input.mimeType || 'application/octet-stream', Params: { Size: input.data.byteLength },
  });
  const streamRef = document.context.register(stream);
  const specification = document.context.register(document.context.obj({
    Type: 'Filespec', F: PDFHexString.fromText(input.name), UF: PDFHexString.fromText(input.name),
    Desc: input.description ? PDFHexString.fromText(input.description) : undefined,
    EF: { F: streamRef, UF: streamRef }, AFRelationship: 'Unspecified',
  }));
  const existingKeys = new Set(assets.names.map(entry => entry.key));
  let treeKey = input.name;
  for (let suffix = 2; existingKeys.has(treeKey); suffix++) treeKey = `${input.name} (${suffix})`;
  writeNameTree(document, [...assets.names, { key: treeKey, specification }]);
  return rewrite(document);
}

export async function extractDocumentAttachment(data: ArrayBuffer, id: string): Promise<{
  name: string; mimeType: string; data: Uint8Array;
}> {
  const document = await openPDF(data);
  const attachment = collectAssets(document, await revisionKey(data)).attachments.find(item => item.id === id);
  if (!attachment) throw new Error('Attachment no longer exists. Refresh the attachment list.');
  return { name: attachment.name, mimeType: attachment.mimeType,
    data: new Uint8Array(decodePDFRawStream(attachment.stream).decode()) };
}

export async function removeDocumentAttachment(data: ArrayBuffer, id: string): Promise<Uint8Array> {
  const document = await openPDF(data);
  const assets = collectAssets(document, await revisionKey(data));
  const target = assets.attachments.find(item => item.id === id);
  if (!target) throw new Error('Attachment no longer exists. Refresh the attachment list.');
  writeNameTree(document, assets.names.filter(entry => document.context.lookup(entry.specification) !== target.dictionary));
  for (const { dictionary, array } of assets.associatedFiles) {
    const kept = array.asArray().filter(item => document.context.lookup(item) !== target.dictionary);
    // Replace this carrier instead of mutating a shared array. An unknown
    // alias must remain detectable by the reachability check below.
    if (kept.length) dictionary.set(key('AF'), document.context.obj(kept));
    else dictionary.delete(key('AF'));
  }
  const removedAnnotations = new Set(assets.annotations.filter(item => item.specification === target.dictionary).map(item => item.dictionary));
  for (const page of document.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    const kept = annotations.asArray().filter(item => {
      const annotation = document.context.lookup(item);
      if (!(annotation instanceof PDFDict)) return true;
      const isPopup = annotation.lookup(key('Subtype')) === key('Popup')
        && removedAnnotations.has(annotation.lookup(key('Parent')) as PDFDict);
      return !removedAnnotations.has(annotation) && !isPopup;
    });
    page.node.set(key('Annots'), document.context.obj(kept));
  }
  // Do not return a partially removed attachment when an unrecognized carrier
  // (for example an action or rich-media structure) still references it.
  const remaining = collectAssets(document);
  if (remaining.reachable.has(target.dictionary))
    throw new Error(`Attachment "${target.name}" has additional references that cannot be safely removed.`);
  for (const stream of target.streams) {
    const neededByAnotherAttachment = remaining.attachments.some(item => item.streams.includes(stream));
    if (remaining.reachable.has(stream) && !neededByAnotherAttachment)
      throw new Error(`Attachment "${target.name}" has embedded data referenced outside the attachment list.`);
  }
  return rewrite(document);
}
