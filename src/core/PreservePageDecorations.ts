import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { PAGE_DECORATION_MARKERS as marks } from './PageDecorationMarkers';
import { inspectDecorationDocument, type DecorationManifest } from './PageDecorationManifest';
import type { PDFImage } from '../editing/types';

interface StoredMark {
  manifest: DecorationManifest;
  wrapper: PDFObject;
  forms: Array<{ name: string; object: PDFObject }>;
  state: PDFObject;
}
interface StoredPage { number: number; transform: number[]; bounds: number[]; marks: StoredMark[] }

/** Retain native image draw indices when managed marks are temporarily detached. */
export function imagesWithoutDetachedDecorations(images: Map<number, PDFImage[]>, instances: Set<string>): Map<number, PDFImage[]> {
  if (!instances.size) return images;
  return new Map([...images].map(([page, values]) => {
    const removed = values.filter(image => image.source?.decorationInstance && instances.has(image.source.decorationInstance))
      .map(image => image.source!.occurrence).sort((a, b) => a - b);
    if (!removed.length) return [page, values];
    return [page, values.filter(image => !removed.includes(image.source?.occurrence ?? -1)).map(image => ({
      ...image,
      source: image.source ? { ...image.source,
        occurrence: image.source.occurrence - removed.filter(index => index < image.source!.occurrence).length,
        occurrenceCount: image.source.occurrenceCount - removed.length,
      } : undefined,
    }))];
  }));
}

/**
 * Original-body edits must not rewrite batch marks or destroy their templates.
 * Keep validated mark objects in a private donor, edit only the body, then graft
 * the exact objects back. This is never used for intentional content redaction.
 */
export async function preservePageDecorations(
  data: ArrayBuffer,
  editedPages: Set<number>,
  transform: (body: ArrayBuffer, detachedInstances: Set<string>) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!editedPages.size) return transform(data, new Set());
  const engine = await loadMuPDF();
  let document: PDFDocument | undefined = new engine.PDFDocument(data);
  const donor = new engine.PDFDocument();
  const donorMap = donor.newGraftMap();
  const owned: PDFObject[] = [];
  const own = (object: PDFObject) => { owned.push(object); return object; };
  const copy = (doc: PDFDocument, source: PDFObject) => {
    const result = own(doc.newDictionary());
    if (source.isDictionary()) source.forEach((value, key) => { try { result.put(key, value); } finally { value.destroy(); } });
    return result;
  };
  const save = (doc: PDFDocument) => {
    const output = doc.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { return new Uint8Array(output.asUint8Array()); } finally { output.destroy(); }
  };
  const stored: StoredPage[] = [];
  const instances = new Set<string>();
  let result: PDFDocument | undefined;
  let graft: ReturnType<PDFDocument['newGraftMap']> | undefined;
  try {
    const { inspection, records } = await inspectDecorationDocument(document);
    const unsafe = inspection.decorations.find(item => !item.managed && item.pages.some(page => editedPages.has(page)));
    if (unsafe) {
      throw new Error(`Original content cannot be edited because a page decoration has missing or changed editing metadata (${unsafe.definition.name}). Its appearance cannot be preserved safely. No changes were saved.`);
    }
    const managed = new Set(inspection.decorations.filter(item => item.managed && item.pages.some(page => editedPages.has(page))).map(item => item.id));
    if (!managed.size) return transform(data, new Set());
    const validRecords = new Map(records.filter(record => !record.reason && managed.has(record.manifest.id))
      .map(record => [`${record.pageNumber}:${record.streamRef}`, record.manifest]));
    const count = document.countPages();
    for (const number of editedPages) {
      if (!Number.isInteger(number) || number < 1 || number > count) throw new Error('The content edit references an invalid page.');
      const page = document.loadPage(number - 1);
      try {
        const object = own(page.getObject()), contents = own(object.get('Contents'));
        const streams: PDFObject[] = [];
        if (contents.isArray()) contents.forEach(value => streams.push(own(value)));
        else if (contents.isStream()) streams.push(contents);
        const resources = copy(document, own(object.getInheritable('Resources')));
        const forms = copy(document, own(resources.get('XObject')));
        const states = copy(document, own(resources.get('ExtGState')));
        const retained = own(document.newArray());
        const saved: StoredPage = { number, transform: [...page.getTransform()], bounds: [...page.getBounds()], marks: [] };
        for (const stream of streams) {
          const manifest = validRecords.get(`${number}:${stream.asIndirect()}`);
          if (!manifest) { retained.push(stream); continue; }
          const entry: StoredMark = { manifest, wrapper: own(donorMap.graftObject(stream)), forms: [], state: own(donorMap.graftObject(own(states.get(manifest.gsName)))) };
          for (const { name } of manifest.resources) {
            entry.forms.push({ name, object: own(donorMap.graftObject(own(forms.get(name)))) });
            forms.delete(name);
          }
          states.delete(manifest.gsName);
          saved.marks.push(entry); instances.add(manifest.instanceId);
        }
        if (saved.marks.length) {
          resources.put('XObject', forms); resources.put('ExtGState', states);
          object.put('Resources', resources); object.put('Contents', retained);
          stored.push(saved);
        }
      } finally { page.destroy(); }
    }
    if (!instances.size) return transform(data, instances);
    const body = save(document);
    // The donor owns only marks/fonts/images, not an old copy of page content.
    document.destroy(); document = undefined;
    const changed = await transform(new Uint8Array(body).buffer, instances);
    result = new engine.PDFDocument(changed); graft = result.newGraftMap();
    if (result.countPages() !== count) throw new Error('The page count changed while editing body content.');
    for (const saved of stored) {
      const page = result.loadPage(saved.number - 1);
      try {
        if (JSON.stringify(page.getTransform()) !== JSON.stringify(saved.transform) || JSON.stringify(page.getBounds()) !== JSON.stringify(saved.bounds)) {
          throw new Error('The page geometry changed while editing body content.');
        }
        const object = own(page.getObject());
        const resources = copy(result, own(object.getInheritable('Resources')));
        const forms = copy(result, own(resources.get('XObject'))), states = copy(result, own(resources.get('ExtGState')));
        const background: PDFObject[] = [], foreground: PDFObject[] = [];
        for (const entry of saved.marks) {
          for (const resource of entry.forms) {
            if (!own(forms.get(resource.name)).isNull()) throw new Error('A page decoration resource collided with edited content. No changes were saved.');
            forms.put(resource.name, own(graft.graftObject(resource.object)));
          }
          if (!own(states.get(entry.manifest.gsName)).isNull()) throw new Error('A page decoration style collided with edited content. No changes were saved.');
          states.put(entry.manifest.gsName, own(graft.graftObject(entry.state)));
          const wrapper = own(graft.graftObject(entry.wrapper));
          const behind = entry.manifest.layer === 'background';
          (behind ? background : foreground).push(wrapper);
        }
        resources.put('XObject', forms); resources.put('ExtGState', states); object.put('Resources', resources);
        const contents = own(result.newArray());
        for (const wrapper of background) contents.push(wrapper);
        const previous = own(object.get('Contents'));
        const previousStreams: PDFObject[] = [];
        if (previous.isArray()) previous.forEach(value => previousStreams.push(own(value)));
        else if (!previous.isNull()) previousStreams.push(previous);
        const guards: Array<{ pair: string; side: string }> = [];
        for (const stream of previousStreams) {
          const marker = own(stream.get(marks.guard));
          if (!marker.isNull()) {
            const value = marker.isString() ? JSON.parse(marker.asString()) : null;
            if (!value || value.version !== 1 || typeof value.pair !== 'string') throw new Error('The page decoration boundary changed while editing.');
            const bytes = stream.readStream();
            try { if (bytes.asString() !== (value.side === 'start' ? 'q\n' : 'Q\n')) throw new Error('The page decoration boundary changed while editing.'); }
            finally { bytes.destroy(); }
            guards.push(value);
          }
        }
        if (guards.length && (guards.length !== 2 || guards[0].side !== 'start' || guards[1].side !== 'end' || guards[0].pair !== guards[1].pair)) {
          throw new Error('The page decoration boundary changed while editing.');
        }
        const pair = crypto.randomUUID();
        const guard = (side: 'start' | 'end') => own(result!.addStream(side === 'start' ? 'q\n' : 'Q\n', {
          [marks.guard]: own(result!.newString(JSON.stringify({ version: 1, pair, side }))),
        }));
        if (!guards.length) contents.push(guard('start'));
        for (const stream of previousStreams) contents.push(stream);
        if (!guards.length) contents.push(guard('end'));
        for (const wrapper of foreground) contents.push(wrapper);
        object.put('Contents', contents);
      } finally { page.destroy(); }
    }
    const output = save(result);
    const verified = (await inspectDecorationDocument(result)).inspection;
    if ([...managed].some(id => !verified.decorations.some(item => item.id === id && item.managed))) {
      throw new Error('Page decoration integrity could not be preserved. No content changes were saved.');
    }
    return output;
  } finally {
    for (const object of owned.reverse()) object.destroy();
    graft?.destroy(); donorMap.destroy(); donor.destroy(); result?.destroy(); document?.destroy();
  }
}
