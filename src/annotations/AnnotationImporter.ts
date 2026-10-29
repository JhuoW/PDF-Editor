import {
  AnnotationFlags, PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString,
  PDFName, PDFNumber, PDFRef, PDFString,
} from 'pdf-lib';
import type { Annotation, NativeTextMetadata, StickyNoteAnnotation, StickyNoteReply } from './types';

interface Entry {
  dictionary: PDFDict;
  reference?: PDFRef;
  pageNumber: number;
}

const icons: Record<string, StickyNoteAnnotation['iconType']> = {
  Comment: 'comment', Key: 'key', Note: 'note', Help: 'help',
  NewParagraph: 'newparagraph', Paragraph: 'paragraph', Insert: 'insert',
};
const textKeys = new Set([
  'Type', 'Subtype', 'P', 'Rect', 'Contents', 'T', 'NM', 'CreationDate', 'M',
  'Name', 'C', 'CA', 'Open', 'F', 'Popup', 'IRT', 'RT', 'Subj',
]);
const popupKeys = new Set(['Type', 'Subtype', 'P', 'Rect', 'Parent', 'Open', 'F']);
const editableFlags = AnnotationFlags.Print | AnnotationFlags.NoZoom | AnnotationFlags.NoRotate;

function value(dictionary: PDFDict, key: string) {
  return dictionary.lookup(PDFName.of(key));
}

function text(dictionary: PDFDict, key: string): string | undefined {
  const object = value(dictionary, key);
  if (object === undefined) return undefined;
  if (!(object instanceof PDFString || object instanceof PDFHexString)) throw new Error(`Invalid ${key}`);
  return object.decodeText();
}

function number(dictionary: PDFDict, key: string, fallback: number) {
  const object = value(dictionary, key);
  if (object === undefined) return fallback;
  if (!(object instanceof PDFNumber) || !Number.isFinite(object.asNumber())) throw new Error(`Invalid ${key}`);
  return object.asNumber();
}

function boolean(dictionary: PDFDict, key: string, fallback: boolean) {
  const object = value(dictionary, key);
  if (object === undefined) return fallback;
  if (!(object instanceof PDFBool)) throw new Error(`Invalid ${key}`);
  return object.asBoolean();
}

function rectangle(dictionary: PDFDict): [number, number, number, number] {
  const object = value(dictionary, 'Rect');
  if (!(object instanceof PDFArray) || object.size() !== 4) throw new Error('Invalid Rect');
  const coordinates = object.asArray().map(item => {
    const resolved = dictionary.context.lookup(item);
    if (!(resolved instanceof PDFNumber) || !Number.isFinite(resolved.asNumber())) throw new Error('Invalid Rect');
    return resolved.asNumber();
  }) as [number, number, number, number];
  if (coordinates[2] <= coordinates[0] || coordinates[3] <= coordinates[1]) throw new Error('Invalid Rect');
  return coordinates;
}

function date(dictionary: PDFDict, key: string): Date | undefined {
  const dateText = text(dictionary, key);
  if (dateText === undefined) return undefined;
  return PDFString.of(dateText).decodeDate();
}

function flags(dictionary: PDFDict) {
  const result = number(dictionary, 'F', 0);
  if (!Number.isInteger(result) || result < 0 || (result & ~editableFlags) !== 0) throw new Error('Unsupported flags');
  return result;
}

function assertKeys(dictionary: PDFDict, allowed: Set<string>) {
  if (dictionary.keys().some(key => !allowed.has(key.decodeText()))) throw new Error('Unsupported annotation metadata');
}

function parseText(entry: Entry) {
  const dictionary = entry.dictionary;
  assertKeys(dictionary, textKeys);
  if (value(dictionary, 'Subtype') !== PDFName.of('Text')) throw new Error('Unsupported reply type');
  const icon = value(dictionary, 'Name');
  const iconType = icon === undefined ? 'note' : icon instanceof PDFName ? icons[icon.decodeText()] : undefined;
  if (!iconType) throw new Error('Unsupported icon');
  const colorObject = value(dictionary, 'C');
  let color: [number, number, number] | undefined;
  if (colorObject !== undefined) {
    if (!(colorObject instanceof PDFArray) || colorObject.size() !== 3) throw new Error('Unsupported color');
    color = colorObject.asArray().map(item => {
      const resolved = dictionary.context.lookup(item);
      if (!(resolved instanceof PDFNumber) || !Number.isFinite(resolved.asNumber())
        || resolved.asNumber() < 0 || resolved.asNumber() > 1) throw new Error('Invalid color');
      return resolved.asNumber();
    }) as [number, number, number];
  }
  const opacity = number(dictionary, 'CA', 1);
  if (opacity < 0 || opacity > 1) throw new Error('Invalid opacity');
  const createdAt = date(dictionary, 'CreationDate');
  const modifiedAt = date(dictionary, 'M');
  const nativeText: NativeTextMetadata = {
    rectangle: rectangle(dictionary), flags: flags(dictionary),
    subject: text(dictionary, 'Subj'), color,
    hasCreationDate: createdAt !== undefined, hasModifiedDate: modifiedAt !== undefined,
  };
  return {
    id: crypto.randomUUID(), sourceNM: text(dictionary, 'NM'),
    content: text(dictionary, 'Contents') ?? '', author: text(dictionary, 'T'),
    createdAt: createdAt ?? modifiedAt ?? new Date(0), modifiedAt: modifiedAt ?? createdAt ?? new Date(0),
    color: color ? `#${color.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}` : '#ffff00',
    opacity, iconType, isOpen: boolean(dictionary, 'Open', false), nativeText,
  };
}

/**
 * Move completely supported native note threads into the editable workspace.
 * The returned PDF is their annotation-free base, preventing repeat exports
 * from duplicating notes. Unsupported annotations remain in that base intact.
 */
export async function importEditableAnnotations(data: ArrayBuffer): Promise<{
  data: ArrayBuffer;
  annotations: Map<number, Annotation[]>;
}> {
  const document = await PDFDocument.load(data, { updateMetadata: false });
  const entries: Entry[] = [];
  document.getPages().forEach((page, index) => {
    for (const object of page.node.Annots()?.asArray() ?? []) {
      const dictionary = document.context.lookup(object);
      if (dictionary instanceof PDFDict) entries.push({
        dictionary, reference: object instanceof PDFRef ? object : undefined, pageNumber: index + 1,
      });
    }
  });
  const children = new Map<PDFDict, Entry[]>();
  const occurrences = new Map<PDFDict, number>();
  const popupParents = new Map<PDFDict, Entry[]>();
  const popupReferences = new Map<PDFDict, Entry[]>();
  for (const entry of entries) {
    occurrences.set(entry.dictionary, (occurrences.get(entry.dictionary) ?? 0) + 1);
    const parent = value(entry.dictionary, 'IRT');
    if (parent instanceof PDFDict) children.set(parent, [...(children.get(parent) ?? []), entry]);
    if (value(entry.dictionary, 'Subtype') === PDFName.of('Popup')) {
      const popupParent = value(entry.dictionary, 'Parent');
      if (popupParent instanceof PDFDict) popupParents.set(popupParent, [...(popupParents.get(popupParent) ?? []), entry]);
    }
    const popup = value(entry.dictionary, 'Popup');
    if (popup instanceof PDFDict) popupReferences.set(popup, [...(popupReferences.get(popup) ?? []), entry]);
  }
  const annotations = new Map<number, Annotation[]>();
  const removed = new Set<PDFDict>();

  for (const root of entries) {
    if (value(root.dictionary, 'Subtype') !== PDFName.of('Text') || root.dictionary.has(PDFName.of('IRT'))) continue;
    try {
      // A dictionary shared by several page Annots arrays cannot be moved
      // safely: its one P/Rect would describe multiple distinct placements.
      const thread = [root, ...(children.get(root.dictionary) ?? [])];
      const popups: Entry[] = [];
      const parsed = thread.map((entry, index) => {
        if (entry.pageNumber !== root.pageNumber || occurrences.get(entry.dictionary) !== 1)
          throw new Error('Shared or cross-page note');
        if (index > 0 && children.has(entry.dictionary)) throw new Error('Nested replies');
        const replyType = value(entry.dictionary, 'RT');
        if (replyType !== undefined && replyType !== PDFName.of('R')) throw new Error('Unsupported reply relation');
        const note = parseText(entry);
        const popupObject = value(entry.dictionary, 'Popup');
        const relatedPopups = popupParents.get(entry.dictionary) ?? [];
        if (relatedPopups.length > 1 || (popupObject !== undefined
          && (relatedPopups.length !== 1 || relatedPopups[0].dictionary !== popupObject))) throw new Error('Unsupported popup');
        if (relatedPopups.length === 1) {
          const popup = relatedPopups[0];
          assertKeys(popup.dictionary, popupKeys);
          if (popup.pageNumber !== root.pageNumber || occurrences.get(popup.dictionary) !== 1
            || (popupReferences.get(popup.dictionary) ?? []).some(other => other !== entry))
            throw new Error('Unrelated popup');
          note.nativeText.popup = {
            rectangle: rectangle(popup.dictionary), flags: flags(popup.dictionary),
            isOpen: boolean(popup.dictionary, 'Open', false),
          };
          popups.push(popup);
        }
        return note;
      });
      const note: StickyNoteAnnotation = {
        ...parsed[0], type: 'sticky-note', pageNumber: root.pageNumber,
        position: { x: parsed[0].nativeText.rectangle[0], y: parsed[0].nativeText.rectangle[3] },
        replies: parsed.slice(1) satisfies StickyNoteReply[],
      };
      annotations.set(root.pageNumber, [...(annotations.get(root.pageNumber) ?? []), note]);
      for (const entry of [...thread, ...popups]) removed.add(entry.dictionary);
    } catch {
      // Leave the entire native thread untouched if any property, popup or
      // reply cannot be round-tripped. This is preservation, not a failed edit.
    }
  }

  if (removed.size === 0) return { data, annotations };
  for (const page of document.getPages()) {
    const array = page.node.Annots();
    if (!array) continue;
    for (let index = array.size() - 1; index >= 0; index--) {
      const dictionary = document.context.lookup(array.get(index));
      if (dictionary instanceof PDFDict && removed.has(dictionary)) array.remove(index);
    }
  }
  for (const entry of entries) if (entry.reference && removed.has(entry.dictionary)) document.context.delete(entry.reference);
  return { data: new Uint8Array(await document.save({ updateFieldAppearances: false })).buffer, annotations };
}
