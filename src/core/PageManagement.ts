import {
  PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFObjectCopier,
  PDFRadioGroup, PDFRawStream, PDFRef, PDFString, type PDFObject, type PDFPage,
} from 'pdf-lib';
import { copyPagesWithForms } from './copyPagesWithForms';
import { clonePDFPageLink, createPDFLinkDestinationResolver, stabilizePDFLinkPageReferences } from './PDFLinkDestinations';
import { stabilizePDFBookmarkPageReferences } from './PDFBookmarkPageOperations';
import { geometry } from './PDFTargetCodec';

export interface PageCropMargins { top: number; right: number; bottom: number; left: number }
const key = PDFName.of;

function assertEditable(pdf: PDFDocument) {
  if (pdf.isEncrypted) throw new Error('Unlock the PDF before managing pages.');
  const present = (dict: PDFDict, name: string) => dict.has(key(name)) && dict.lookup(key(name)) !== PDFNull;
  const acro = pdf.catalog.lookup(key('AcroForm')), permissions = pdf.catalog.lookup(key('Perms'));
  if (acro instanceof PDFDict && present(acro, 'XFA')) throw new Error('XFA documents cannot be changed by page management.');
  const signed = () => { throw new Error('Signed or certified PDFs cannot be changed by page management.'); };
  if (permissions instanceof PDFDict && ['DocMDP', 'UR', 'UR3'].some(name => present(permissions, name))) signed();
  const seen = new Set<PDFObject>(), pending: Array<PDFObject | undefined> = [pdf.context.trailerInfo.Root];
  for (let index = 0; index < pending.length; index++) {
    const raw = pending[index], object = pdf.context.lookup(raw);
    if (raw instanceof PDFRef && object === undefined) throw new Error('The PDF contains a dangling object reference.');
    if (!object || seen.has(object)) continue; seen.add(object);
    if (seen.size > 1_000_000) throw new Error('The PDF structure exceeds the page management resource limit.');
    if (object instanceof PDFRawStream) pending.push(object.dict);
    else if (object instanceof PDFArray) pending.push(...object.asArray());
    else if (object instanceof PDFDict) {
      const type = object.lookup(key('Type')), fieldType = object.lookup(key('FT'));
      const range = object.lookup(key('ByteRange')), contents = object.lookup(key('Contents'));
      if ((type instanceof PDFName && ['Sig', 'DocTimeStamp'].includes(type.decodeText()))
        || (fieldType === key('Sig') && present(object, 'V'))
        || (range instanceof PDFArray && (contents instanceof PDFString || contents instanceof PDFHexString))) signed();
      pending.push(...object.values());
    }
  }
}

async function loadEditablePDF(source: ArrayBuffer): Promise<PDFDocument> {
  const pdf = await PDFDocument.load(source); assertEditable(pdf); return pdf;
}

/** Inspect untouched source bytes before a workspace writer can normalize unsupported objects. */
export async function assertPageManagementSource(source: ArrayBuffer): Promise<void> { await loadEditablePDF(source); }

function validatePages(pages: number[], total: number): void {
  if (!pages.length || new Set(pages).size !== pages.length
    || pages.some(page => !Number.isInteger(page) || page < 1 || page > total)) {
    throw new Error('Choose valid page numbers without duplicates.');
  }
}

/** Preserve links from copies to original pages outside the selected copy batch. */
function restoreDuplicateLinks(target: PDFDocument, donor: PDFDocument, numbers: number[], copies: PDFPage[]) {
  const resolve = createPDFLinkDestinationResolver(donor), copyByNumber = new Map(numbers.map((number, index) => [number, copies[index]]));
  for (let index = 0; index < copies.length; index++) {
    const page = copies[index], source = donor.getPage(numbers[index] - 1);
    const annotations = (page.node.Annots()?.asArray() ?? []).filter(raw => {
      const annotation = target.context.lookup(raw);
      return !(annotation instanceof PDFDict) || annotation.lookup(key('Subtype')) !== key('Link');
    });
    for (const raw of source.node.Annots()?.asArray() ?? []) {
      const annotation = donor.context.lookup(raw);
      if (!(annotation instanceof PDFDict) || annotation.lookup(key('Subtype')) !== key('Link')) continue;
      const plan = clonePDFPageLink(donor, annotation, resolve), copier = PDFObjectCopier.for(donor.context, target.context);
      const copied = copier.copy(plan.annotation);
      copied.set(key('P'), page.ref);
      for (const slot of plan.destinations) {
        const destination = copyByNumber.get(slot.resolved.pageNumber) ?? target.getPage(slot.resolved.pageNumber - 1);
        copier.copy(slot.dictionary).set(slot.key, target.context.obj([
          destination.ref, ...slot.resolved.destination.asArray().slice(1).map(value => copier.copy(value)),
        ]));
      }
      annotations.push(target.context.register(copied));
    }
    if (annotations.length) page.node.set(key('Annots'), target.context.obj(annotations));
    else page.node.delete(key('Annots'));
  }
}

export async function duplicatePDFPages(source: ArrayBuffer, pageNumbers: number[], beforePage: number): Promise<Uint8Array> {
  const target = await loadEditablePDF(source), total = target.getPageCount();
  validatePages(pageNumbers, total);
  if (!Number.isInteger(beforePage) || beforePage < 0 || beforePage > total + 1) throw new Error('Invalid insertion position');
  stabilizePDFLinkPageReferences(target); stabilizePDFBookmarkPageReferences(target);
  const donor = await PDFDocument.load(source);
  const copies = await copyPagesWithForms(target, donor, pageNumbers.map(page => page - 1));
  restoreDuplicateLinks(target, donor, pageNumbers, copies);
  const insertion = beforePage === 0 ? total : beforePage - 1;
  copies.forEach((page, index) => target.insertPage(insertion + index, page));
  return target.save({ updateFieldAppearances: false });
}

function removeReplacedWidgets(pdf: PDFDocument, pages: PDFPage[]) {
  const refs = new Set(pages.map(page => page.ref)), annotations = new Set<PDFDict>();
  for (const page of pages) for (const raw of page.node.Annots()?.asArray() ?? []) {
    const annotation = pdf.context.lookup(raw); if (annotation instanceof PDFDict) annotations.add(annotation);
  }
  const form = pdf.getForm();
  for (const field of form.getFields()) {
    const selected = field instanceof PDFRadioGroup ? field.getSelected() : undefined;
    const widgets = field.acroField.getWidgets();
    for (let index = widgets.length - 1; index >= 0; index--) {
      if (!refs.has(widgets[index].P()!) && !annotations.has(widgets[index].dict)) continue;
      if (field instanceof PDFRadioGroup || field instanceof PDFCheckBox) field.acroField.removeExportValue(index);
      field.acroField.removeWidget(index);
    }
    if (!field.acroField.getWidgets().length) form.removeField(field);
    else if (field instanceof PDFRadioGroup && selected && !field.getOptions().includes(selected)) field.clear();
  }
}

/** Redirect copied references to the existing page slots, including fields and bookmarks. */
function rebindPageReferences(pdf: PDFDocument, refs: Map<PDFRef, PDFRef>) {
  const seen = new Set<PDFObject>();
  const rewrite = (object: PDFObject) => {
    if (seen.has(object)) return; seen.add(object);
    if (object instanceof PDFDict) {
      for (const [name, value] of object.entries()) {
        if (value instanceof PDFRef && refs.has(value)) object.set(name, refs.get(value)!);
        else if (!(value instanceof PDFRef)) rewrite(value);
      }
    } else if (object instanceof PDFArray) {
      object.asArray().forEach((value, index) => {
        if (value instanceof PDFRef && refs.has(value)) object.set(index, refs.get(value)!);
        else if (!(value instanceof PDFRef)) rewrite(value);
      });
    }
  };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) rewrite(object);
}

/** Replace contents and native objects while retaining incoming page references. */
export async function replacePDFPages(source: ArrayBuffer, targetPages: number[], replacementSource: ArrayBuffer, replacementPages: number[]): Promise<Uint8Array> {
  const target = await loadEditablePDF(source), donor = await loadEditablePDF(replacementSource);
  validatePages(targetPages, target.getPageCount()); validatePages(replacementPages, donor.getPageCount());
  if (targetPages.length !== replacementPages.length) throw new Error('Select the same number of original and replacement pages.');
  stabilizePDFLinkPageReferences(target); stabilizePDFBookmarkPageReferences(target);
  const originals = targetPages.map(number => target.getPage(number - 1));
  removeReplacedWidgets(target, originals);
  const copies = await copyPagesWithForms(target, donor, replacementPages.map(page => page - 1));
  const refs = new Map(copies.map((copy, index) => [copy.ref, originals[index].ref]));
  copies.forEach((copy, index) => {
    const original = originals[index], parent = original.node.get(key('Parent'));
    original.node.keys().forEach(name => original.node.delete(name));
    for (const [name, value] of copy.node.entries()) if (name !== key('Parent')) original.node.set(name, value);
    if (parent) original.node.set(key('Parent'), parent);
  });
  rebindPageReferences(target, refs);
  copies.forEach(copy => target.context.delete(copy.ref));
  return target.save({ updateFieldAppearances: false });
}

/** Margins are physical points at the visible, rotated page edges. */
export async function cropPDFPages(source: ArrayBuffer, pages: number[], margins: PageCropMargins): Promise<Uint8Array> {
  const pdf = await loadEditablePDF(source); validatePages(pages, pdf.getPageCount());
  if (!margins || ![margins.top, margins.right, margins.bottom, margins.left].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Crop margins must be finite, nonnegative numbers.');
  }
  for (const number of pages) {
    const page = pdf.getPage(number - 1), view = geometry(page);
    const sides = view.rotation === 0 ? margins
      : view.rotation === 90 ? { top: margins.right, right: margins.bottom, bottom: margins.left, left: margins.top }
      : view.rotation === 180 ? { top: margins.bottom, right: margins.left, bottom: margins.top, left: margins.right }
      : { top: margins.left, right: margins.top, bottom: margins.right, left: margins.bottom };
    const width = view.width - sides.left - sides.right, height = view.height - sides.top - sides.bottom;
    if (width <= 0 || height <= 0) throw new Error(`Crop margins leave no visible area on page ${number}.`);
    page.setCropBox(view.left + sides.left / view.unit, view.top - (view.height - sides.bottom) / view.unit, width / view.unit, height / view.unit);
  }
  return pdf.save({ updateFieldAppearances: false });
}

/** Crop hides page edges rather than deleting their content; restore shows the MediaBox. */
export async function resetPageCrop(source: ArrayBuffer, pages: number[]): Promise<Uint8Array> {
  const pdf = await loadEditablePDF(source); validatePages(pages, pdf.getPageCount());
  for (const number of pages) {
    const page = pdf.getPage(number - 1), media = page.getMediaBox();
    if (![media.x, media.y, media.width, media.height].every(Number.isFinite) || media.width <= 0 || media.height <= 0) throw new Error('This PDF has ambiguous page geometry and cannot be edited safely.');
    page.setCropBox(media.x, media.y, media.width, media.height);
  }
  return pdf.save({ updateFieldAppearances: false });
}
