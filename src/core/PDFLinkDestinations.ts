import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString, type PDFObject } from 'pdf-lib';

export interface ResolvedPDFLinkDestination { pageNumber: number; destination: PDFArray }
type Resolver = (value: PDFObject | undefined) => ResolvedPDFLinkDestination | null;
const name = PDFName.of;
function text(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
}

/** Resolve against the real page tree; an orphan Page object is never page one. */
export function createPDFLinkDestinationResolver(pdf: PDFDocument): Resolver {
  // pdf-lib's getPages cache can still contain a page removed in memory.
  const pageRefs = new Map<string, number>();
  pdf.catalog.Pages().traverse((node, ref) => {
    if (node.lookup(name('Type')) === name('Page')) pageRefs.set(ref.toString(), pageRefs.size + 1);
  });
  const destinations = new Map<string, PDFObject[]>();
  let validNames = true, visitedNodes = 0;
  const add = (key: string, value: PDFObject) => {
    const values = destinations.get(key);
    if (!values) destinations.set(key, [value]);
    else if (values.length === 1) values.push(value); // Two entries already prove ambiguity.
  };
  const old = pdf.catalog.lookup(name('Dests'));
  if (old instanceof PDFDict) for (const [key, value] of old.entries()) add(key.decodeText(), value);
  else if (old !== undefined) validNames = false;
  const visited = new Set<PDFDict>();
  const walk = (value: PDFObject | undefined, depth: number) => {
    const node = pdf.context.lookup(value);
    if (!(node instanceof PDFDict) || visited.has(node) || depth > 64 || ++visitedNodes > 100_000) { validNames = false; return; }
    visited.add(node);
    const entries = node.lookup(name('Names')), kids = node.lookup(name('Kids'));
    if (entries !== undefined) {
      if (!(entries instanceof PDFArray) || entries.size() % 2) { validNames = false; return; }
      for (let index = 0; index < entries.size(); index += 2) {
        const key = text(entries.lookup(index));
        if (key === undefined) { validNames = false; return; }
        add(key, entries.get(index + 1));
      }
    }
    if (kids !== undefined) {
      if (!(kids instanceof PDFArray)) { validNames = false; return; }
      for (let index = 0; index < kids.size(); index++) walk(kids.get(index), depth + 1);
    }
  };
  const names = pdf.catalog.lookup(name('Names'));
  if (names instanceof PDFDict && names.has(name('Dests'))) walk(names.get(name('Dests')), 0);
  const resolve: Resolver = value => {
    const seen = new Set<PDFObject>();
    let current = value;
    for (let depth = 0; current && depth < 128; depth++) {
      current = pdf.context.lookup(current);
      if (!current || seen.has(current)) return null;
      seen.add(current);
      if (current instanceof PDFArray) {
        const target = current.get(0);
        // Integer destinations are accepted for existing local PDFs only when
        // they are valid zero-based indices. New links always use page refs.
        const pageNumber = target instanceof PDFRef ? pageRefs.get(target.toString())
          : target instanceof PDFNumber && Number.isInteger(target.asNumber()) ? target.asNumber() + 1 : undefined;
        return pageNumber !== undefined && pageNumber >= 1 && pageNumber <= pageRefs.size ? { pageNumber, destination: current } : null;
      }
      if (current instanceof PDFDict) { current = current.get(name('D')); continue; }
      const key = text(current), matches = key !== undefined && validNames ? destinations.get(key) : undefined;
      if (!matches || matches.length !== 1) return null;
      current = matches[0];
    }
    return null;
  };
  return resolve;
}

export function resolvePDFLinkDestination(pdf: PDFDocument, value: PDFObject | undefined): ResolvedPDFLinkDestination | null {
  return createPDFLinkDestinationResolver(pdf)(value);
}

/** Pin legacy numeric local destinations before changing page order or count. */
export function stabilizePDFLinkPageReferences(pdf: PDFDocument): void {
  const resolve = createPDFLinkDestinationResolver(pdf), pages = pdf.getPages();
  const pin = (value: PDFObject | undefined) => {
    const result = resolve(value);
    if (result?.destination.get(0) instanceof PDFNumber) result.destination.set(0, pages[result.pageNumber - 1].ref);
  };
  const seen = new Set<PDFObject>();
  const actions = (raw: PDFObject | undefined, depth = 0) => {
    const object = pdf.context.lookup(raw);
    if (!object || seen.has(object) || depth > 64) return;
    seen.add(object);
    if (object instanceof PDFArray) { object.asArray().forEach(value => actions(value, depth + 1)); return; }
    if (!(object instanceof PDFDict)) return;
    if (object.lookup(name('S')) === name('GoTo')) pin(object.get(name('D')));
    actions(object.get(name('Next')), depth + 1);
  };
  for (const page of pages) for (const raw of page.node.Annots()?.asArray() ?? []) {
    const annotation = pdf.context.lookup(raw);
    if (!(annotation instanceof PDFDict) || annotation.lookup(name('Subtype')) !== name('Link')) continue;
    pin(annotation.get(name('Dest'))); actions(annotation.get(name('A')));
    const additional = annotation.lookup(name('AA'));
    if (additional instanceof PDFDict) additional.entries().forEach(([, value]) => actions(value));
  }
  const old = pdf.catalog.lookup(name('Dests'));
  if (old instanceof PDFDict) old.entries().forEach(([, value]) => pin(value));
  const visitNames = (raw: PDFObject | undefined, depth = 0) => {
    const node = pdf.context.lookup(raw);
    if (!(node instanceof PDFDict) || seen.has(node) || depth > 64) return;
    seen.add(node);
    const entries = node.lookup(name('Names')), kids = node.lookup(name('Kids'));
    if (entries instanceof PDFArray) for (let index = 1; index < entries.size(); index += 2) pin(entries.get(index));
    if (kids instanceof PDFArray) kids.asArray().forEach(value => visitNames(value, depth + 1));
  };
  const names = pdf.catalog.lookup(name('Names'));
  if (names instanceof PDFDict) visitNames(names.get(name('Dests')));
}

export interface PDFLinkDestinationSlot { dictionary: PDFDict; key: PDFName; resolved: ResolvedPDFLinkDestination }
export interface ClonedPDFPageLink { annotation: PDFDict; destinations: PDFLinkDestinationSlot[] }

/** Clone the annotation/action containers before rewriting occurrence-local targets. */
export function clonePDFPageLink(pdf: PDFDocument, annotation: PDFDict, resolve: Resolver): ClonedPDFPageLink {
  const cloned = annotation.clone(), destinations: PDFLinkDestinationSlot[] = [];
  const uriSettings = pdf.catalog.lookup(name('URI'));
  const uriBase = uriSettings instanceof PDFDict ? text(uriSettings.lookup(name('Base'))) : undefined;
  cloned.delete(name('P'));
  const destination = (dictionary: PDFDict, key: PDFName) => {
    if (!dictionary.has(key)) return;
    const resolved = resolve(dictionary.get(key));
    if (!resolved) throw new Error('An internal link has an invalid, ambiguous, or unavailable destination.');
    const items = resolved.destination.asArray(), mode = items[1];
    const lengths: Record<string, number> = { XYZ: 5, Fit: 2, FitB: 2, FitH: 3, FitBH: 3, FitV: 3, FitBV: 3, FitR: 6 };
    if (!(mode instanceof PDFName) || lengths[mode.decodeText()] !== items.length
      || items.slice(2).some(value => value !== PDFNull && !(value instanceof PDFNumber && Number.isFinite(value.asNumber())))) {
      throw new Error('An internal link has an unsupported destination format.');
    }
    destinations.push({ dictionary, key, resolved });
    // Do not let a generic object copier traverse a destination's source Page.
    dictionary.set(key, pdf.context.obj([null, ...resolved.destination.asArray().slice(1)]));
  };
  let count = 0;
  const seen = new Set<PDFObject>();
  const cloneAction = (raw: PDFObject, depth: number): PDFObject => {
    const object = pdf.context.lookup(raw);
    if (!object || depth > 64 || ++count > 100_000 || seen.has(object)) throw new Error('A link has an invalid or circular action chain.');
    seen.add(object);
    try {
      if (object instanceof PDFArray) return pdf.context.obj(object.asArray().map(value => cloneAction(value, depth + 1)));
      if (!(object instanceof PDFDict)) throw new Error('A link has an invalid action dictionary.');
      const action = object.clone();
      if (action.lookup(name('S')) === name('URI')) {
        const uri = action.lookup(name('URI')), value = text(uri);
        // Absolute actions retain their bytes. Relative URI actions depend on a
        // catalog entry that does not travel with copied pages; pin that basis.
        if (value !== undefined && !/^[a-z][a-z\d+.-]*:/i.test(value)) {
          let absolute: URL;
          try { absolute = new URL(value, uriBase); } catch { throw new Error('A relative link URI has no usable source document base.'); }
          if (!['https:', 'http:', 'mailto:', 'ftp:', 'tel:'].includes(absolute.protocol)) throw new Error('A relative link URI uses an unsupported source document base.');
          action.set(name('URI'), PDFString.of(absolute.href));
        }
      }
      if (action.lookup(name('S')) === name('GoTo')) {
        if (!action.has(name('D'))) throw new Error('An internal link has no destination.');
        destination(action, name('D'));
      }
      const next = action.get(name('Next'));
      if (next) action.set(name('Next'), cloneAction(next, depth + 1));
      return action;
    } finally { seen.delete(object); }
  };
  destination(cloned, name('Dest'));
  const action = cloned.get(name('A'));
  if (action) cloned.set(name('A'), cloneAction(action, 0));
  const additional = cloned.lookup(name('AA'));
  if (additional instanceof PDFDict) {
    const copy = additional.clone();
    for (const [key, value] of additional.entries()) copy.set(key, cloneAction(value, 0));
    cloned.set(name('AA'), copy);
  }
  return { annotation: cloned, destinations };
}

/** Drop only links/named destinations whose real target is being deleted. */
export function removePDFLinksToPages(pdf: PDFDocument, deletedPageNumbers: Set<number>): void {
  if (!deletedPageNumbers.size) return;
  const resolve = createPDFLinkDestinationResolver(pdf);
  const deleted = (value: PDFObject | undefined) => {
    const destination = resolve(value);
    return !!destination && deletedPageNumbers.has(destination.pageNumber);
  };
  const actionTargetsDeletedPage = (value: PDFObject | undefined, seen = new Set<PDFObject>(), depth = 0): boolean => {
    const object = pdf.context.lookup(value);
    if (!object || seen.has(object) || depth > 64) return false;
    seen.add(object);
    if (object instanceof PDFArray) return object.asArray().some(item => actionTargetsDeletedPage(item, seen, depth + 1));
    if (!(object instanceof PDFDict)) return false;
    return (object.lookup(name('S')) === name('GoTo') && deleted(object.get(name('D'))))
      || actionTargetsDeletedPage(object.get(name('Next')), seen, depth + 1);
  };
  for (const [index, page] of pdf.getPages().entries()) {
    if (deletedPageNumbers.has(index + 1)) continue;
    const annots = page.node.Annots();
    if (!annots) continue;
    const retained = annots.asArray().filter(raw => {
      const annotation = pdf.context.lookup(raw);
      if (!(annotation instanceof PDFDict) || annotation.lookup(name('Subtype')) !== name('Link')) return true;
      const additional = annotation.lookup(name('AA'));
      return !deleted(annotation.get(name('Dest'))) && !actionTargetsDeletedPage(annotation.get(name('A')))
        && !(additional instanceof PDFDict && additional.entries().some(([, action]) => actionTargetsDeletedPage(action)));
    });
    if (retained.length !== annots.size()) page.node.set(name('Annots'), pdf.context.obj(retained));
  }
  const old = pdf.catalog.lookup(name('Dests'));
  if (old instanceof PDFDict) {
    const retained = old.clone();
    for (const [key, value] of old.entries()) if (deleted(value)) retained.delete(key);
    pdf.catalog.set(name('Dests'), retained);
  }
  const names = pdf.catalog.lookup(name('Names'));
  if (!(names instanceof PDFDict) || !names.has(name('Dests'))) return;
  const seen = new Set<PDFDict>();
  const prune = (raw: PDFObject, depth: number): PDFObject | undefined => {
    const node = pdf.context.lookup(raw);
    if (!(node instanceof PDFDict) || seen.has(node) || depth > 64) return raw;
    seen.add(node);
    const clone = node.clone(), entries = node.lookup(name('Names')), kids = node.lookup(name('Kids'));
    if (entries instanceof PDFArray && entries.size() % 2 === 0) {
      const retained: PDFObject[] = [];
      for (let index = 0; index < entries.size(); index += 2) if (!deleted(entries.get(index + 1))) retained.push(entries.get(index), entries.get(index + 1));
      clone.set(name('Names'), pdf.context.obj(retained));
    }
    if (kids instanceof PDFArray) {
      const retained = kids.asArray().map(child => prune(child, depth + 1)).filter((child): child is PDFObject => child !== undefined);
      clone.set(name('Kids'), pdf.context.obj(retained));
    }
    const leftEntries = clone.lookup(name('Names')), leftKids = clone.lookup(name('Kids'));
    if ((leftEntries === undefined || leftEntries instanceof PDFArray && !leftEntries.size())
      && (leftKids === undefined || leftKids instanceof PDFArray && !leftKids.size())) return undefined;
    // Non-root name-tree children need accurate Limits for reader binary search.
    if (leftEntries instanceof PDFArray && leftEntries.size()) {
      clone.set(name('Limits'), pdf.context.obj([leftEntries.get(0), leftEntries.get(leftEntries.size() - 2)]));
    } else if (leftKids instanceof PDFArray && leftKids.size()) {
      const first = leftKids.lookup(0), last = leftKids.lookup(leftKids.size() - 1);
      const low = first instanceof PDFDict ? first.lookup(name('Limits')) : undefined;
      const high = last instanceof PDFDict ? last.lookup(name('Limits')) : undefined;
      if (low instanceof PDFArray && high instanceof PDFArray && low.size() === 2 && high.size() === 2) {
        clone.set(name('Limits'), pdf.context.obj([low.get(0), high.get(1)]));
      }
    }
    return clone;
  };
  const retained = prune(names.get(name('Dests'))!, 0), copy = names.clone();
  if (retained) copy.set(name('Dests'), retained); else copy.delete(name('Dests'));
  pdf.catalog.set(name('Names'), copy);
}
