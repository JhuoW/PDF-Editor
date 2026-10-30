import { PDFDocument, PDFNumber, PDFName } from 'pdf-lib';
import type { Annotation } from '../annotations/types';
import { importEditableAnnotations } from '../annotations/AnnotationImporter';
import { extractFormFields } from '../forms/FormFieldExtractor';
import { applyCurrentWorkspaceFormValues } from '../forms/WorkspaceFormValues';
import { assertTextEditSource } from '../editing/TextEditSource';
import { remapWorkspacePages, type WorkspaceSnapshot } from '../store/workspaceSnapshot';
import { applyWorkspaceContent } from './PDFExport';
import { insertionPageMap } from './pageMapping';
import { assertPageManagementSource, cropPDFPages, duplicatePDFPages, replacePDFPages, resetPageCrop } from './PageManagement';

/** Structural request shared with the dialog, without a runtime UI dependency. */
export interface PageManagementWorkspaceRequest {
  action: 'duplicate' | 'extract' | 'replace' | 'crop';
  pages: number[];
  beforePage?: number;
  source?: { data: ArrayBuffer; pages: number[] };
  margins?: { top: number; right: number; bottom: number; left: number };
  resetCrop?: boolean;
}

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;

function copyAnnotation(annotation: Annotation, pageNumber: number): Annotation {
  const copy = structuredClone(annotation);
  copy.id = crypto.randomUUID();
  copy.pageNumber = pageNumber;
  if (copy.type === 'sticky-note') {
    // A copied thread must acquire independent PDF /NM identities on export.
    delete copy.sourceNM;
    copy.replies?.forEach(reply => { reply.id = crypto.randomUUID(); delete reply.sourceNM; });
  }
  return copy;
}

function visibleOrigin(page: ReturnType<PDFDocument['getPage']>) {
  const media = page.getMediaBox(), crop = page.getCropBox();
  const left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width), top = Math.min(media.y + media.height, crop.y + crop.height);
  const rawUnit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber();
  return {
    left: right > left && top > bottom ? left : media.x,
    top: right > left && top > bottom ? top : media.y + media.height,
    unit: rawUnit !== undefined && Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : 1,
  };
}

/** Prepare and transform native pages while retaining editable working annotations. */
export async function performPageManagement(
  data: ArrayBuffer,
  workspace: WorkspaceSnapshot,
  request: PageManagementWorkspaceRequest,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array; workspace: WorkspaceSnapshot; pageMap: Map<number, number> }> {
  signal?.throwIfAborted();
  if (request.action === 'extract') throw new Error('Extract pages through the PDF export workflow.');
  await assertPageManagementSource(data); signal?.throwIfAborted();
  const initial = await PDFDocument.load(data, { updateMetadata: false }); signal?.throwIfAborted();
  const total = initial.getPageCount(), selected = new Set(request.pages);
  if (!selected.size || selected.size !== request.pages.length || request.pages.some(page => !Number.isInteger(page) || page < 1 || page > total)) {
    throw new Error('Invalid page selection');
  }
  if (request.action === 'crop' && workspace.editing.redactions.some(area => !area.applied && selected.has(area.pageNumber))) {
    throw new Error('Apply or discard content removal marks on the selected pages before cropping.');
  }
  if (workspace.editing.textEdits.length) { await assertTextEditSource(data, signal); signal?.throwIfAborted(); }
  let prepared = await applyWorkspaceContent(data.slice(0), workspace); signal?.throwIfAborted();
  prepared = await applyCurrentWorkspaceFormValues(buffer(prepared), workspace, signal);
  const identity = new Map(Array.from({ length: total }, (_, index) => [index + 1, index + 1]));
  let pageMap = identity, next = structuredClone(workspace), result: Uint8Array;
  if (request.action === 'duplicate') {
    const destination = request.beforePage ?? 0;
    result = await duplicatePDFPages(buffer(prepared), request.pages, destination); signal?.throwIfAborted();
    pageMap = insertionPageMap(total, destination, request.pages.length);
    next = remapWorkspacePages(next, pageMap);
    const first = destination === 0 ? total + 1 : destination;
    request.pages.forEach((sourcePage, index) => {
      const pageNumber = first + index;
      const annotations = workspace.annotations.get(sourcePage);
      if (annotations?.length) next.annotations.set(pageNumber, annotations.map(annotation => copyAnnotation(annotation, pageNumber)));
      next.editing.redactions.push(...workspace.editing.redactions.filter(area => area.pageNumber === sourcePage)
        .map(area => ({ ...structuredClone(area), id: crypto.randomUUID(), pageNumber })));
    });
  } else if (request.action === 'replace') {
    if (!request.source) throw new Error('Choose a replacement PDF.');
    await assertPageManagementSource(request.source.data); signal?.throwIfAborted();
    const imported = await importEditableAnnotations(request.source.data.slice(0)); signal?.throwIfAborted();
    result = await replacePDFPages(buffer(prepared), request.pages, imported.data, request.source.pages); signal?.throwIfAborted();
    next.annotations = new Map([...next.annotations].filter(([page]) => !selected.has(page)));
    next.editing.redactions = next.editing.redactions.filter(area => !selected.has(area.pageNumber));
    request.pages.forEach((pageNumber, index) => {
      const notes = imported.annotations.get(request.source!.pages[index]);
      if (notes?.length) next.annotations.set(pageNumber, notes.map(note => copyAnnotation(note, pageNumber)));
    });
  } else {
    if (!request.resetCrop && !request.margins) throw new Error('Enter crop margins.');
    result = request.resetCrop ? await resetPageCrop(buffer(prepared), request.pages)
      : await cropPDFPages(buffer(prepared), request.pages, request.margins!);
    signal?.throwIfAborted();
    // Working annotations use absolute PDF coordinates and need no translation.
    // Removal areas use the unrotated CropBox-relative, scale-1 viewport instead.
    const cropped = await PDFDocument.load(result, { updateMetadata: false }); signal?.throwIfAborted();
    next.editing.redactions = next.editing.redactions.map(area => {
      if (!selected.has(area.pageNumber)) return area;
      const before = visibleOrigin(initial.getPage(area.pageNumber - 1)), after = visibleOrigin(cropped.getPage(area.pageNumber - 1));
      return { ...area, rect: { ...area.rect,
        x: area.rect.x + (before.left - after.left) * before.unit,
        y: area.rect.y + (after.top - before.top) * before.unit,
      } };
    });
  }
  const fields = await extractFormFields(buffer(result)); signal?.throwIfAborted();
  const previous = new Map(workspace.form.fields.map(field => [field.id, field]));
  const originalValues = new Map(fields.map(field => {
    const old = previous.get(field.id);
    const survives = old && !(request.action === 'replace' && selected.has(old.pageNumber));
    return [field.id, structuredClone(survives && workspace.form.originalValues.has(field.id)
      ? workspace.form.originalValues.get(field.id)! : field.value)] as const;
  }));
  // Read values from the result; never restore old target fields onto replacements.
  next.form = { fields, originalValues, isDirty: fields.some(field => JSON.stringify(field.value) !== JSON.stringify(originalValues.get(field.id))) };
  next.editing.textBlocks.clear(); next.editing.images.clear();
  next.editing.textEdits = []; next.editing.imageEdits = [];
  next.editing.isDirty = next.editing.redactions.some(area => !area.applied);
  next.annotationHistory = { past: [], future: [] };
  signal?.throwIfAborted();
  return { data: result, workspace: next, pageMap };
}
