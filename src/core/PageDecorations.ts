import type { Matrix, PDFDocument, PDFObject, PDFPage } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { inspectPDFImage } from './ImagePDF';
import { PageDecorationRenderer, type RenderedPageDecoration } from './PageDecorationRenderer';
import { PAGE_DECORATION_MARKERS as MARK } from './PageDecorationMarkers';
import { decorationDocumentRestriction, decorationHash, inspectDecorationDocument, pageContentObjects, readString, resourceHasher, serializeDefinition, streamBytes, type DecorationManifest } from './PageDecorationManifest';
import type { PageDecorationControl, PageDecorationDefinition, PageDecorationInspection, PageDecorationOperation } from './PageDecorationTypes';
export * from './PageDecorationTypes';
export { PAGE_DECORATION_MARKERS } from './PageDecorationMarkers';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Page decoration changes cancelled.', 'AbortError'); }
function range(value: number, low: number, high: number, label: string, integer = false) {
  if (!Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) throw new Error(`${label} must be ${integer ? 'an integer ' : ''}between ${low} and ${high}.`);
}
function color(value: string) { if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Choose a six-digit hexadecimal decoration color.'); }
function font(family: string, size: number) {
  if (!['Helvetica', 'Times', 'Courier'].includes(family)) throw new Error('This decoration font is not supported.');
  range(size, 1, 500, 'Font size');
}
function text(value: string, singleLine = false) {
  if (typeof value !== 'string' || Array.from(value).length > 4096 || value.split(/\r\n?|\n/).length > (singleLine ? 1 : 50)) throw new Error('Decoration text supports up to 4,096 characters; headers and footers must be a single line.');
}
function validate(definition: PageDecorationDefinition, pageCount: number) {
  if (!definition || typeof definition.name !== 'string' || definition.name.length > 200) throw new Error('Enter a decoration name of at most 200 characters.');
  if (!Array.isArray(definition.pages) || !definition.pages.length || new Set(definition.pages).size !== definition.pages.length) throw new Error('Choose at least one page without duplicates.');
  definition.pages.forEach(page => range(page, 1, pageCount, 'Page number', true)); range(definition.opacity, 0, 1, 'Opacity');
  if (definition.kind !== 'background' && !['foreground', 'background'].includes(definition.layer)) throw new Error('Choose a valid decoration layer.');
  if (definition.kind === 'watermark') {
    range(definition.angle, -360, 360, 'Angle'); range(definition.position.offsetX, -14400, 14400, 'Horizontal offset'); range(definition.position.offsetY, -14400, 14400, 'Vertical offset');
    if (!['top-left', 'top-center', 'top-right', 'center-left', 'center', 'center-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(definition.position.anchor)) throw new Error('Choose a valid watermark anchor.');
    if (definition.content.type === 'text') { font(definition.content.fontFamily, definition.content.fontSize); color(definition.content.color); text(definition.content.text); if (!definition.content.text.trim()) throw new Error('Enter watermark text.'); }
    else if (definition.content.type === 'image') { inspectPDFImage({ name: definition.content.name, data: definition.content.data }); range(definition.content.width, 1, 14400, 'Image width'); range(definition.content.height, 1, 14400, 'Image height'); }
    else throw new Error('Choose text or an image for this watermark.');
  } else if (definition.kind === 'header-footer') {
    font(definition.fontFamily, definition.fontSize); color(definition.color);
    for (const [key, value] of Object.entries(definition.slots)) {
      if (!['headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight'].includes(key)) throw new Error('Unknown header or footer slot.');
      text(value, true); if (/\{(?!page\}|pages\}|bates\})[^}]*\}/.test(value)) throw new Error('Use only {page}, {pages}, and {bates} template tokens.');
    }
    if (!Object.values(definition.slots).some(value => value?.trim())) throw new Error('Enter at least one header or footer.');
    range(definition.marginX, 0, 14400, 'Horizontal margin'); range(definition.marginTop, 0, 14400, 'Top margin'); range(definition.marginBottom, 0, 14400, 'Bottom margin');
    range(definition.pageNumberStart, 0, 999999999, 'Page number start', true); range(definition.bates.start, 0, 999999999, 'Bates start', true); range(definition.bates.digits, 1, 16, 'Bates digits', true); text(definition.bates.prefix, true); text(definition.bates.suffix, true);
  } else if (definition.kind === 'background') {
    if (definition.fill.type === 'color') color(definition.fill.color);
    else if (definition.fill.type === 'image') { inspectPDFImage({ name: definition.fill.name, data: definition.fill.data }); if (!['contain', 'cover', 'stretch'].includes(definition.fill.fit)) throw new Error('Choose a valid background image fit.'); }
    else throw new Error('Choose a background color or image.');
  } else throw new Error('This page decoration type is not supported.');
}
function copyDictionary(document: PDFDocument, source: PDFObject) {
  const result = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => { try { result.put(key, value); } finally { value.destroy(); } });
  return result;
}
function putString(document: PDFDocument, object: PDFObject, key: string, value: string) {
  const string = document.newString(value); try { object.put(key, string); } finally { string.destroy(); }
}
function writeContents(document: PDFDocument, page: PDFObject, streams: PDFObject[]) {
  const array = document.newArray(); try { streams.forEach(stream => array.push(stream)); page.put('Contents', array); } finally { array.destroy(); }
}
function guard(document: PDFDocument, side: 'start' | 'end', pair: string) {
  const stream = document.addStream(side === 'start' ? 'q\n' : 'Q\n', {});
  putString(document, stream, MARK.guard, JSON.stringify({ version: 1, pair, side })); return stream;
}
function guardInfo(stream: PDFObject): { version: number; pair: string; side: 'start' | 'end' } | undefined {
  const raw = readString(stream, MARK.guard); if (!raw) return;
  try { const value = JSON.parse(raw); if (value.version !== 1 || !['start', 'end'].includes(value.side) || new TextDecoder().decode(streamBytes(stream)) !== (value.side === 'start' ? 'q\n' : 'Q\n')) throw new Error(); return value; }
  catch { throw new Error('The page decoration graphics-state boundary has changed; this page cannot be updated safely.'); }
}
function boundary(streams: PDFObject[]) {
  const guards = streams.map((stream, index) => ({ value: guardInfo(stream), index })).filter(item => item.value);
  if (!guards.length) return undefined;
  if (guards.length !== 2 || guards[0].value!.side !== 'start' || guards[1].value!.side !== 'end' || guards[0].value!.pair !== guards[1].value!.pair) throw new Error('The page decoration graphics-state boundary is incomplete.');
  return { start: guards[0].index, end: guards[1].index };
}
interface Placement { rendered: RenderedPageDecoration; matrix: Matrix; bounds: { x: number; y: number; width: number; height: number } }
function placements(renderer: PageDecorationRenderer, definition: PageDecorationDefinition, pageNumber: number, count: number, ordinal: number, page: PDFPage): Placement[] {
  const box = page.getBounds(), width = box[2] - box[0], height = box[3] - box[1];
  const result: Placement[] = [];
  const add = (rendered: RenderedPageDecoration, x: number, y: number, targetWidth = rendered.width, targetHeight = rendered.height, angle = 0, clip = false) => {
    const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180), centerX = x + targetWidth / 2, centerY = y + targetHeight / 2;
    const extentX = Math.abs(cosine) * targetWidth + Math.abs(sine) * targetHeight, extentY = Math.abs(sine) * targetWidth + Math.abs(cosine) * targetHeight;
    const bounds = { x: centerX - extentX / 2, y: centerY - extentY / 2, width: extentX, height: extentY };
    if (!clip && (bounds.x < -0.01 || bounds.y < -0.01 || bounds.x + bounds.width > width + 0.01 || bounds.y + bounds.height > height + 0.01)) { rendered.form.destroy(); throw new Error(`The decoration does not fit on page ${pageNumber}. Reduce its size, margins, or offset.`); }
    const sx = targetWidth / rendered.width, sy = targetHeight / rendered.height;
    result.push({ rendered, matrix: [cosine * sx, sine * sx, sine * sy, -cosine * sy, box[0] + centerX - cosine * targetWidth / 2 - sine * targetHeight / 2, box[1] + centerY - sine * targetWidth / 2 + cosine * targetHeight / 2], bounds: clip ? { x: 0, y: 0, width, height } : bounds });
  };
  try {
    if (definition.kind === 'watermark') {
      const content = definition.content, rendered = renderer.render(content.type === 'text' ? content : { type: 'image', data: content.data, maxWidth: content.width, maxHeight: content.height });
      const radians = definition.angle * Math.PI / 180, ex = Math.abs(Math.cos(radians)) * rendered.width + Math.abs(Math.sin(radians)) * rendered.height, ey = Math.abs(Math.sin(radians)) * rendered.width + Math.abs(Math.cos(radians)) * rendered.height;
      const anchor = definition.position.anchor, cx = anchor.endsWith('left') ? ex / 2 : anchor.endsWith('right') ? width - ex / 2 : width / 2, cy = anchor.startsWith('top') ? ey / 2 : anchor.startsWith('bottom') ? height - ey / 2 : height / 2;
      add(rendered, cx - rendered.width / 2 + definition.position.offsetX, cy - rendered.height / 2 + definition.position.offsetY, rendered.width, rendered.height, definition.angle);
    } else if (definition.kind === 'header-footer') {
      const bates = definition.bates.prefix + String(definition.bates.start + ordinal).padStart(definition.bates.digits, '0') + definition.bates.suffix;
      for (const [slot, template] of Object.entries(definition.slots)) {
        if (!template?.trim()) continue;
        const resolved = template.replace(/\{(page|pages|bates)\}/g, (_, token: string) => token === 'page' ? String(pageNumber + definition.pageNumberStart - 1) : token === 'pages' ? String(count) : bates);
        const rendered = renderer.render({ type: 'text', text: resolved, fontFamily: definition.fontFamily, fontSize: definition.fontSize, color: definition.color });
        if (rendered.width > (width - 2 * definition.marginX) / 3 + 0.01) { rendered.form.destroy(); throw new Error(`The ${slot} text does not fit its column on page ${pageNumber}. Reduce the font size or text length.`); }
        const x = slot.endsWith('Left') ? definition.marginX : slot.endsWith('Right') ? width - definition.marginX - rendered.width : (width - rendered.width) / 2;
        add(rendered, x, slot.startsWith('header') ? definition.marginTop : height - definition.marginBottom - rendered.height);
      }
    } else if (definition.fill.type === 'color') add(renderer.render({ type: 'solid', width, height, color: definition.fill.color }), 0, 0);
    else {
      const rendered = renderer.render({ type: 'image', data: definition.fill.data, maxWidth: width, maxHeight: height });
      const scale = definition.fill.fit === 'cover' ? Math.max(width / rendered.width, height / rendered.height) : 1;
      const w = definition.fill.fit === 'stretch' ? width : rendered.width * scale, h = definition.fill.fit === 'stretch' ? height : rendered.height * scale;
      add(rendered, (width - w) / 2, (height - h) / 2, w, h, 0, definition.fill.fit === 'cover');
    }
    return result;
  } catch (error) { result.forEach(item => item.rendered.form.destroy()); throw error; }
}

export async function inspectPageDecorations(data: ArrayBuffer): Promise<PageDecorationInspection> {
  const engine = await loadMuPDF(), document = new engine.PDFDocument(new Uint8Array(data));
  try { if (document.needsPassword()) throw new Error('Unlock this PDF before managing page decorations.'); return (await inspectDecorationDocument(document)).inspection; }
  finally { document.destroy(); }
}

/** All mutations occur on a private document. Aborts and errors never publish partial output. */
export async function applyPageDecorations(data: ArrayBuffer, operations: PageDecorationOperation[], control: PageDecorationControl = {}): Promise<Uint8Array> {
  cancelled(control.signal);
  if (!operations.length) return new Uint8Array(data.slice(0));
  const engine = await loadMuPDF(); cancelled(control.signal);
  const document = new engine.PDFDocument(new Uint8Array(data)); let renderer: PageDecorationRenderer | undefined;
  try {
    const restriction = decorationDocumentRestriction(document); if (restriction) throw new Error(restriction);
    const { inspection, records } = await inspectDecorationDocument(document), count = document.countPages();
    if (control.previewPage !== undefined) range(control.previewPage, 1, count, 'Preview page', true);
    const changed = new Set<string>();
    const jobs = operations.map(operation => {
      if (operation.type !== 'create') {
        if (changed.has(operation.id)) throw new Error('A decoration can only be changed once in each batch.'); changed.add(operation.id);
        const existing = inspection.decorations.find(item => item.id === operation.id);
        if (!existing) throw new Error('This decoration no longer exists. Reopen the manager and try again.');
        if (!existing.managed) throw new Error(existing.reason ?? 'This decoration cannot be safely changed.');
      }
      if (operation.type !== 'remove') validate(operation.definition, count);
      return { operation, id: operation.type === 'create' ? crypto.randomUUID() : operation.id };
    });
    renderer = new PageDecorationRenderer(engine, document);
    const hash = resourceHasher(); let completed = 0;
    const affected = new Set(records.filter(record => changed.has(record.manifest.id)).map(record => record.pageNumber));
    jobs.forEach(({ operation }) => { if (operation.type !== 'remove') operation.definition.pages.forEach(page => affected.add(page)); });
    const pages = [...affected].filter(page => control.previewPage === undefined || page === control.previewPage).sort((a, b) => a - b);
    control.onProgress?.({ completed, total: pages.length });
    for (const pageNumber of pages) {
      await tick(); cancelled(control.signal);
      const page = document.loadPage(pageNumber - 1), object = page.getObject(), inherited = object.getInheritable('Resources');
      const resources = copyDictionary(document, inherited), oldForms = resources.get('XObject'), forms = copyDictionary(document, oldForms), oldStates = resources.get('ExtGState'), states = copyDictionary(document, oldStates);
      let streams = pageContentObjects(object);
      try {
        boundary(streams);
        for (const record of records.filter(item => item.pageNumber === pageNumber && changed.has(item.manifest.id))) {
          const update = jobs.find(job => job.id === record.manifest.id)!.operation;
          const keepsSlot = update.type === 'update' && update.definition.pages.includes(pageNumber)
            && (update.definition.kind === 'background' ? 'background' : update.definition.layer) === record.manifest.layer;
          // Keep an old wrapper as a temporary slot until its replacement is ready.
          // Appending every update would reorder overlapping marks in this layer.
          if (!keepsSlot) streams = streams.filter(stream => { if (stream.asIndirect() !== record.streamRef) return true; stream.destroy(); return false; });
          record.manifest.resources.forEach(resource => forms.delete(resource.name)); states.delete(record.manifest.gsName);
        }
        for (const { operation, id } of jobs) {
          if (operation.type === 'remove' || !operation.definition.pages.includes(pageNumber)) continue;
          const definition = operation.definition, ordinal = definition.pages.indexOf(pageNumber), instanceId = crypto.randomUUID(), prefix = `PDE_${instanceId.replaceAll('-', '_')}`;
          const rendered = placements(renderer, definition, pageNumber, count, ordinal, page);
          const manifestResources: DecorationManifest['resources'] = [];
          const gsName = `${prefix}_GS`, layer = definition.kind === 'background' ? 'background' : definition.layer;
          states.put(gsName, { Type: 'ExtGState', ca: definition.opacity, CA: definition.opacity });
          let body = `/Artifact << /Type /Pagination /Subtype /Watermark /${MARK.id} (${id}) /${MARK.instance} (${instanceId}) >> BDC\n/${MARK.contentTagPrefix}${instanceId} BMC\nq\n/${gsName} gs\n`;
          try {
            for (const [index, item] of rendered.entries()) {
              const name = `${prefix}_${index}`;
              putString(document, item.rendered.form, MARK.id, id); putString(document, item.rendered.form, MARK.instance, instanceId); putString(document, item.rendered.form, MARK.kind, definition.kind);
              forms.put(name, item.rendered.form);
              manifestResources.push({ name, hash: await hash(item.rendered.form), imageResourceName: item.rendered.imageResourceName });
              const matrix = engine.Matrix.concat(item.matrix, engine.Matrix.invert(page.getTransform()));
              body += `q\n${matrix.map(number => Math.abs(number) < 1e-10 ? '0' : String(number)).join(' ')} cm\n/${name} Do\nQ\n`;
            }
            body += 'Q\nEMC\nEMC\n';
            const box = page.getBounds(), xs = rendered.map(item => item.bounds.x), ys = rendered.map(item => item.bounds.y), x = Math.min(...xs), y = Math.min(...ys);
            const manifest: DecorationManifest = { version: 1, id, instanceId, ordinal, sourcePage: pageNumber, totalPages: count, width: box[2] - box[0], height: box[3] - box[1], pageTransform: [...page.getTransform()], pageBounds: [...box], definition: JSON.parse(serializeDefinition(definition)), layer,
              visualBounds: { x, y, width: Math.max(...rendered.map(item => item.bounds.x + item.bounds.width)) - x, height: Math.max(...rendered.map(item => item.bounds.y + item.bounds.height)) - y }, resources: manifestResources, gsName, bodyHash: await decorationHash(body) };
            const wrapper = document.addStream(body, {}); putString(document, wrapper, MARK.manifest, JSON.stringify(manifest));
            const previous = records.find(record => record.pageNumber === pageNumber && record.manifest.id === id && record.manifest.layer === layer);
            const slot = previous ? streams.findIndex(stream => stream.asIndirect() === previous.streamRef) : -1;
            if (slot !== -1) { streams[slot].destroy(); streams.splice(slot, 1, wrapper); continue; }
            let edges = boundary(streams);
            if (!edges) { const pair = crypto.randomUUID(); streams = [guard(document, 'start', pair), ...streams, guard(document, 'end', pair)]; edges = boundary(streams)!; }
            if (layer === 'background') streams.splice(edges.start, 0, wrapper); else streams.push(wrapper);
          } finally { rendered.forEach(item => item.rendered.form.destroy()); }
        }
        if (!streams.some(stream => readString(stream, MARK.manifest))) {
          const edges = boundary(streams);
          if (edges) streams = streams.filter((stream, index) => { if (index !== edges.start && index !== edges.end) return true; stream.destroy(); return false; });
        }
        resources.put('XObject', forms); resources.put('ExtGState', states); object.put('Resources', resources); writeContents(document, object, streams);
      } finally { streams.forEach(stream => stream.destroy()); states.destroy(); oldStates.destroy(); forms.destroy(); oldForms.destroy(); resources.destroy(); inherited.destroy(); object.destroy(); page.destroy(); }
      control.onProgress?.({ completed: ++completed, total: pages.length });
    }
    await tick(); cancelled(control.signal);
    const saved = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { const output = new Uint8Array(saved.asUint8Array()); cancelled(control.signal); return output; }
    finally { saved.destroy(); }
  } finally { renderer?.destroy(); document.destroy(); }
}
