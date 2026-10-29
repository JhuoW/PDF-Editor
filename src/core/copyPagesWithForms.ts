import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier,
  PDFPage, PDFString, PDFWidgetAnnotation,
  type PDFObject,
} from 'pdf-lib';
import { clonePDFPageLink, createPDFLinkDestinationResolver } from './PDFLinkDestinations';

import { preparePDFBookmarkCopy } from './PDFBookmarkPageOperations';

const Parent = PDFName.of('Parent');
const Kids = PDFName.of('Kids');
const P = PDFName.of('P');
const T = PDFName.of('T');
const FT = PDFName.of('FT');
const DA = PDFName.of('DA');
const DR = PDFName.of('DR');

function parentOf(dict: PDFDict): PDFDict | undefined {
  const parent = dict.lookup(Parent);
  if (parent === undefined) return undefined;
  if (!(parent instanceof PDFDict)) throw new Error('Invalid form widget parent');
  return parent;
}

function inherited(dict: PDFDict, key: PDFName): PDFObject | undefined {
  const visited = new Set<PDFDict>();
  let current: PDFDict | undefined = dict;
  while (current) {
    if (visited.has(current)) throw new Error('Circular form field hierarchy');
    visited.add(current);
    const value = current.get(key);
    if (value !== undefined) return value;
    current = parentOf(current);
  }
  return undefined;
}

function partialName(dict: PDFDict): string {
  const name = dict.lookup(T);
  if (name instanceof PDFString || name instanceof PDFHexString) return name.decodeText();
  throw new Error('Cannot import a form field without a name');
}

/**
 * Copy pages and register their native AcroForm fields in the destination.
 * Indices are zero-based, as in PDFDocument.copyPages. Conflicting root names
 * receive a deterministic _2, _3, ... suffix; shared widgets stay one field.
 */
export async function copyPagesWithForms(
  target: PDFDocument,
  source: PDFDocument,
  pageIndices: number[],
): Promise<PDFPage[]> {
  const sourcePages = source.getPages();
  if (source === target) throw new Error('Copy pages from a separate source document');
  if (pageIndices.some(index => !Number.isInteger(index) || index < 0 || index >= sourcePages.length)) {
    throw new Error('Cannot copy an invalid PDF page index');
  }
  const copyBookmarks = preparePDFBookmarkCopy(target, source, pageIndices);
  const resolve = createPDFLinkDestinationResolver(source), selected = new Set(pageIndices.map(index => index + 1));
  // Validate all links before the destination acquires pages or form fields.
  // Each occurrence gets independent action containers, even for shared Annots.
  const plans = pageIndices.map(pageIndex => {
    const annots = sourcePages[pageIndex].node.Annots();
    return annots?.asArray().map(raw => {
      const annotation = source.context.lookup(raw);
      if (!(annotation instanceof PDFDict) || annotation.lookup(PDFName.of('Subtype')) !== PDFName.of('Link')) return null;
      try {
        const plan = clonePDFPageLink(source, annotation, resolve);
        return plan.destinations.some(slot => !selected.has(slot.resolved.pageNumber)) ? false : plan;
      } catch (error) {
        throw new Error(`Cannot copy page ${pageIndex + 1}: ${error instanceof Error ? error.message : 'its links could not be resolved'}`);
      }
    }) ?? [];
  });
  const pages = await copyPagesWithoutLinksWithForms(target, source, pageIndices);
  const firstCopies = new Map<number, PDFPage>();
  pageIndices.forEach((index, position) => { if (!firstCopies.has(index + 1)) firstCopies.set(index + 1, pages[position]); });
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], existing = page.node.Annots()?.asArray() ?? [];
    let otherIndex = 0;
    const annotations: PDFObject[] = [];
    for (const plan of plans[index]) {
      if (plan === null) { annotations.push(existing[otherIndex++]); continue; }
      if (plan === false) continue;
      const copier = PDFObjectCopier.for(source.context, target.context);
      const copied = copier.copy(plan.annotation);
      copied.set(P, page.ref);
      for (const slot of plan.destinations) {
        // A self-link follows this duplicate; other links use the first selected
        // occurrence of their destination page in this copy batch.
        const destination = slot.resolved.pageNumber === pageIndices[index] + 1 ? page : firstCopies.get(slot.resolved.pageNumber)!;
        copier.copy(slot.dictionary).set(slot.key, target.context.obj([
          destination.ref, ...slot.resolved.destination.asArray().slice(1).map(value => copier.copy(value)),
        ]));
      }
      annotations.push(target.context.register(copied));
    }
    if (plans[index].length) page.node.set(PDFName.of('Annots'), target.context.obj(annotations));
  }
  copyBookmarks(pages);
  return pages;
}

async function copyPagesWithoutLinksWithForms(
  target: PDFDocument,
  source: PDFDocument,
  pageIndices: number[],
): Promise<PDFPage[]> {
  const sourcePages = source.getPages();
  if (pageIndices.some(index => !Number.isInteger(index) || index < 0 || index >= sourcePages.length)) {
    throw new Error('Cannot copy an invalid PDF page index');
  }
  if (pageIndices.length === 0) return [];
  if (source === target) throw new Error('Copy pages from a separate source document');

  // Repeated pages need separate widgets and field names, not aliases pointing
  // to one annotation dictionary on several destination pages.
  const uniqueIndices = [...new Set(pageIndices)];
  if (uniqueIndices.length !== pageIndices.length) {
    const firstCopies = await copyPagesWithoutLinksWithForms(target, source, uniqueIndices);
    const available = new Map(uniqueIndices.map((index, i) => [index, firstCopies[i]]));
    const pages: PDFPage[] = [];
    for (const index of pageIndices) {
      const firstCopy = available.get(index);
      if (firstCopy) {
        available.delete(index);
        pages.push(firstCopy);
      } else {
        pages.push(...await copyPagesWithoutLinksWithForms(target, source, [index]));
      }
    }
    return pages;
  }

  await source.flush();
  const selectedNodes = new Set<PDFDict>();
  const annotations = new Set<PDFDict>();
  const roots = new Set<PDFDict>();
  const terminals = new Set<PDFDict>();
  const sourceRefs = new Map(source.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref]));

  for (const index of pageIndices) {
    const pageAnnotations = sourcePages[index].node.Annots();
    if (!pageAnnotations) continue;
    for (let i = 0; i < pageAnnotations.size(); i++) {
      const annotation = pageAnnotations.lookup(i);
      if (!(annotation instanceof PDFDict)) throw new Error('Invalid page annotation while copying PDF');
      if (annotation.lookup(PDFName.of('Subtype')) === PDFName.of('Link')) continue;
      annotations.add(annotation);
      if (annotation.lookup(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;

      const chain: PDFDict[] = [];
      let current: PDFDict | undefined = annotation;
      while (current) {
        if (chain.includes(current)) throw new Error('Circular form widget parent hierarchy');
        chain.push(current);
        selectedNodes.add(current);
        current = parentOf(current);
      }
      const terminal = chain.find(node => node.has(T) || node.has(FT));
      if (!terminal) throw new Error('Cannot import a widget without a form field');
      const type = source.context.lookup(inherited(terminal, FT));
      if (!(type instanceof PDFName) || !['Tx', 'Btn', 'Ch', 'Sig'].includes(type.decodeText())) {
        throw new Error(`Unsupported form field type while importing "${partialName(terminal)}"`);
      }
      terminals.add(terminal);
      const root = chain[chain.length - 1];
      partialName(root); // Validate names before copying anything into the destination.
      roots.add(root);
    }
  }

  const changes: Array<{ dict: PDFDict; key: PDFName; original: PDFObject | undefined }> = [];
  const setTemporary = (dict: PDFDict, key: PDFName, value?: PDFObject) => {
    changes.push({ dict, key, original: dict.get(key) });
    if (value === undefined) dict.delete(key);
    else dict.set(key, value);
  };
  const copier = PDFObjectCopier.for(source.context, target.context);

  try {
    for (const index of pageIndices) {
      const page = sourcePages[index], annots = page.node.Annots();
      if (annots) setTemporary(page.node, PDFName.of('Annots'), source.context.obj(annots.asArray().filter(ref => {
        const annotation = source.context.lookup(ref);
        return !(annotation instanceof PDFDict) || annotation.lookup(PDFName.of('Subtype')) !== PDFName.of('Link');
      })));
    }
    // All changes and copies below are synchronous, with the donor restored in
    // finally. Pruning BEFORE traversal prevents /Kids -> widget -> /P from
    // copying every unselected page of a shared form into the target context.
    for (const annotation of annotations) setTemporary(annotation, P);
    for (const node of selectedNodes) {
      const kids = node.lookup(Kids);
      if (!(kids instanceof PDFArray)) continue;
      const retainedIndices: number[] = [];
      const retained: PDFObject[] = [];
      for (let i = 0; i < kids.size(); i++) {
        const child = kids.lookup(i);
        if (child instanceof PDFDict && selectedNodes.has(child)) {
          retainedIndices.push(i);
          retained.push(kids.get(i));
        }
      }
      setTemporary(node, Kids, source.context.obj(retained));

      if (terminals.has(node) && source.context.lookup(inherited(node, FT)) === PDFName.of('Btn')) {
        const options = node.lookup(PDFName.of('Opt'));
        if (options instanceof PDFArray) {
          setTemporary(node, PDFName.of('Opt'), source.context.obj(retainedIndices.map(i => options.get(i))));
        }
        const value = source.context.lookup(inherited(node, PDFName.of('V')));
        const survivingOnValues = retained.map(ref => source.context.lookup(ref, PDFDict))
          .map(dict => PDFWidgetAnnotation.fromDict(dict).getOnValue());
        if (value instanceof PDFName && !survivingOnValues.includes(value)) {
          setTemporary(node, PDFName.of('V'), PDFName.of('Off'));
        }
      }
    }

    const pages = pageIndices.map(index => {
      const node = copier.copy(sourcePages[index].node);
      const ref = target.context.register(node);
      const page = PDFPage.of(node, ref, target);
      const annots = page.node.Annots();
      if (annots) {
        for (let i = 0; i < annots.size(); i++) {
          const annotation = annots.lookup(i);
          if (annotation instanceof PDFDict) annotation.set(P, ref);
        }
      }
      return page;
    });

    if (roots.size > 0) {
      const destinationForm = target.catalog.getOrCreateAcroForm();
      const existingNames = new Set(destinationForm.getFields().map(([field]) => field.getPartialName()));
      const resourceNames = copyDefaultResources(target, source, copier);
      const sourceForm = source.catalog.getAcroForm();

      for (const node of selectedNodes) {
        const copied = copier.copy(node);
        const appearance = source.context.lookup(inherited(node, DA) ?? sourceForm?.dict.get(DA));
        if (appearance instanceof PDFString || appearance instanceof PDFHexString) {
          copied.set(DA, PDFString.of(renameResources(appearance.decodeText(), resourceNames)));
        }
        const alignment = inherited(node, PDFName.of('Q')) ?? sourceForm?.dict.get(PDFName.of('Q'));
        if (alignment) copied.set(PDFName.of('Q'), copier.copy(alignment));
      }

      for (const root of roots) {
        const originalRef = sourceRefs.get(root);
        const copiedRef = originalRef ? copier.copy(originalRef) : target.context.register(copier.copy(root));
        const copiedRoot = target.context.lookup(copiedRef, PDFDict);
        const originalName = partialName(root);
        let name = originalName;
        for (let suffix = 2; existingNames.has(name); suffix++) name = `${originalName}_${suffix}`;
        existingNames.add(name);
        copiedRoot.set(T, PDFHexString.fromText(name));
        copiedRoot.delete(Parent);
        destinationForm.addField(copiedRef);
      }

      const calculationOrder = sourceForm?.dict.lookup(PDFName.of('CO'));
      if (calculationOrder !== undefined && !(calculationOrder instanceof PDFArray)) {
        throw new Error('Invalid form calculation order in source PDF');
      }
      if (calculationOrder instanceof PDFArray) {
        const existingOrder = destinationForm.dict.lookup(PDFName.of('CO'));
        if (existingOrder !== undefined && !(existingOrder instanceof PDFArray)) {
          throw new Error('Invalid form calculation order in destination PDF');
        }
        const importedOrder = existingOrder instanceof PDFArray ? existingOrder : target.context.obj([]);
        const seen = new Set(importedOrder.asArray().map(ref => ref.toString()));
        for (const entry of calculationOrder.asArray()) {
          const field = source.context.lookup(entry);
          // Do not traverse references to calculated fields on excluded pages.
          if (!(field instanceof PDFDict) || !terminals.has(field)) continue;
          const originalRef = sourceRefs.get(field);
          const copiedField = copier.copy(field);
          const ref = originalRef ? copier.copy(originalRef)
            : target.context.getObjectRef(copiedField) ?? target.context.register(copiedField);
          if (!seen.has(ref.toString())) {
            importedOrder.push(ref);
            seen.add(ref.toString());
          }
        }
        if (importedOrder.size() > 0) destinationForm.dict.set(PDFName.of('CO'), importedOrder);
      }
    }
    return pages;
  } finally {
    for (const { dict, key, original } of changes.reverse()) {
      if (original === undefined) dict.delete(key);
      else dict.set(key, original);
    }
  }
}

/** Merge default resources without replacing the destination's existing fonts. */
function copyDefaultResources(
  target: PDFDocument,
  source: PDFDocument,
  copier: PDFObjectCopier,
): Map<string, string> {
  const renames = new Map<string, string>();
  const sourceResources = source.catalog.getAcroForm()?.dict.lookup(DR);
  if (!(sourceResources instanceof PDFDict)) return renames;
  const form = target.catalog.getOrCreateAcroForm();
  const existingResources = form.dict.lookup(DR);
  const destinationResources = existingResources instanceof PDFDict ? existingResources : target.context.obj({});
  if (!(existingResources instanceof PDFDict)) {
    form.dict.set(DR, destinationResources);
  }
  for (const [kind, resource] of sourceResources.entries()) {
    const sourceEntries = source.context.lookup(resource);
    if (!(sourceEntries instanceof PDFDict)) {
      if (!destinationResources.has(kind)) destinationResources.set(kind, copier.copy(resource));
      continue;
    }
    const existingEntries = destinationResources.lookup(kind);
    const destinationEntries = existingEntries instanceof PDFDict ? existingEntries : target.context.obj({});
    if (!(existingEntries instanceof PDFDict)) {
      destinationResources.set(kind, destinationEntries);
    }
    for (const [key, value] of sourceEntries.entries()) {
      let renamed = key;
      for (let suffix = 2; destinationEntries.has(renamed); suffix++) {
        renamed = PDFName.of(`${key.decodeText()}_${suffix}`);
      }
      destinationEntries.set(renamed, copier.copy(value));
      if (kind === PDFName.of('Font')) renames.set(key.toString(), renamed.toString());
    }
  }
  return renames;
}

function renameResources(appearance: string, renames: Map<string, string>): string {
  return appearance.replace(/\/[^\s/<>(){}%[\]]+/g, name => renames.get(name) ?? name);
}
