import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import type { ImageEditOperation, PDFImage } from './types';
import { identityMatrix, inverseMatrix, matrixBounds, multiplyMatrix, type ImageMatrix } from './imageMatrix';
import { imageAppearance, imageAppearanceMatrix, imageCropUV, validImageCrop, type ImageAppearance } from './imageAppearance';
import { imageCropFromTag, imageCropTag } from './ImageCropMarker';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface Token { start: number; end: number; value: string; kind: 'name' | 'number' | 'object' | 'word' }
interface Command { start: number; end: number; operator: string; operands: Token[] }
interface Draw { command: Command; name: string; object: PDFObject; matrix: ImageMatrix; contextMatrix?: ImageMatrix; occurrence?: number; form?: ContentNode }
interface ContentNode { text: string; resources: PDFObject; object?: PDFObject; draws: Draw[]; inheritsResources: boolean }
interface Pending { image: PDFImage; deleted: boolean; replacement?: ArrayBuffer; rect?: PDFImage['rect']; appearance: ImageAppearance; transformed?: boolean }

const isWhite = (c: string) => ['\0', '\t', '\n', '\f', '\r', ' '].includes(c);
const delimiter = (c: string) => !c || isWhite(c) || /[()[\]<>/%]/.test(c);
/** Lexical scanning preserves all bytes outside the selected Do command. */
function commands(text: string): Command[] {
  let offset = 0;
  function skipSpace() {
    while (offset < text.length) {
      if (isWhite(text[offset])) { offset++; continue; }
      if (text[offset] === '%') { while (offset < text.length && !/[\r\n]/.test(text[offset])) offset++; continue; }
      break;
    }
  }
  function token(): Token | null {
    skipSpace();
    if (offset === text.length) return null;
    const start = offset;
    const c = text[offset++];
    let kind: Token['kind'] = 'object';
    if (c === '(') {
      let depth = 1;
      while (offset < text.length && depth) {
        const next = text[offset++];
        if (next === '\\') offset++;
        else if (next === '(') depth++;
        else if (next === ')') depth--;
      }
      if (depth) throw new Error('Unterminated PDF string');
    } else if (c === '[' || (c === '<' && text[offset] === '<')) {
      const end = c === '[' ? ']' : '>>';
      if (c === '<') offset++;
      while (true) {
        skipSpace();
        if (text.startsWith(end, offset)) { offset += end.length; break; }
        if (!token()) throw new Error('Unterminated PDF array or dictionary');
      }
    } else if (c === '<') {
      const end = text.indexOf('>', offset);
      if (end < 0) throw new Error('Unterminated PDF hexadecimal string');
      offset = end + 1;
    } else if (c === '/') {
      while (!delimiter(text[offset])) offset++;
      kind = 'name';
    } else {
      if (c === ']' || c === '>') throw new Error('Unexpected PDF delimiter');
      while (!delimiter(text[offset])) offset++;
      const value = text.slice(start, offset);
      kind = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : ['true', 'false', 'null'].includes(value) ? 'object' : 'word';
    }
    const value = text.slice(start, offset);
    return { start, end: offset, value: kind === 'name' ? value.slice(1).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) : value, kind };
  }
  const result: Command[] = [];
  let operands: Token[] = [];
  for (let item = token(); item; item = token()) {
    if (item.kind !== 'word') { operands.push(item); continue; }
    if (item.value === 'BI') throw new Error('Pages containing inline images cannot be edited yet.');
    result.push({ start: operands[0]?.start ?? item.start, end: item.end, operator: item.value, operands });
    operands = [];
  }
  if (operands.length) throw new Error('Incomplete PDF content command');
  return result;
}
function bytesToText(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return result;
}
function textToBytes(text: string): Uint8Array { return Uint8Array.from(text, c => c.charCodeAt(0)); }
function pdfName(name: string): string { return '/' + name.replace(/[^!-~]|[()<>[\]{}/%#]/g, c => '#' + c.charCodeAt(0).toString(16).padStart(2, '0')); }

class Editor {
  private objects: { destroy(): void }[] = [];
  private nextOccurrence = 0;
  private applied = new Set<number>();
  private pageToTopLeft = identityMatrix();
  private engine: Engine;
  private document: PDFDocument;
  private pending: Map<number, Pending>;
  constructor(engine: Engine, document: PDFDocument, pending: Map<number, Pending>) {
    this.engine = engine;
    this.document = document;
    this.pending = pending;
  }
  own<T extends { destroy(): void }>(object: T): T { this.objects.push(object); return object; }
  dispose() { for (const object of this.objects.reverse()) object.destroy(); }
  get(object: PDFObject, ...path: (number | string)[]) { return this.own(object.get(...path)); }
  copy(source: PDFObject) {
    const result = this.own(this.document.newDictionary());
    if (source.isDictionary()) source.forEach((value, key) => { this.own(value); result.put(key, value); });
    return result;
  }
  read(source: PDFObject): string {
    if (source.isArray()) {
      const parts: string[] = [];
      source.forEach(value => { this.own(value); parts.push(this.read(value)); });
      return parts.join('\n');
    }
    if (source.isNull()) return '';
    if (!source.isStream()) throw new Error('Invalid PDF content stream');
    const buffer = this.own(source.readStream());
    return bytesToText(buffer.asUint8Array());
  }
  scan(text: string, resources: PDFObject, matrix: ImageMatrix, ancestors: Set<number>, object?: PDFObject, inheritsResources = false): ContentNode {
    if (ancestors.size > 32) throw new Error('Nested PDF image forms are too deep');
    const node: ContentNode = { text, resources, object, draws: [], inheritsResources };
    const stack: ImageMatrix[] = [];
    const markers: Array<{ start: number; matrix: ImageMatrix; crop?: PDFImage['rect']; commands: Command[]; draws: Draw[] }> = [];
    for (const command of commands(text)) {
      const args = command.operands;
      const marker = markers.at(-1);
      if (command.operator === 'BMC' || command.operator === 'BDC') {
        markers.push({ start: command.start, matrix: [...matrix], crop: imageCropFromTag(args[0]?.value), commands: [], draws: [] });
      } else if (command.operator === 'EMC') {
        const span = markers.pop();
        if (span?.crop) {
          const uv = imageCropUV(span.crop), clip = span.commands.find(item => item.operator === 're');
          if (span.draws.length !== 1 || span.commands.map(item => item.operator).join(' ') !== 'q cm re W n Do Q'
            || !clip || clip.operands.length !== 4 || clip.operands.some((item, index) => Math.abs(Number(item.value) - [uv.x, uv.y, uv.width, uv.height][index]) > 1e-7)) throw new Error('The cropped image no longer matches its editable source.');
          const draw = span.draws[0]; draw.contextMatrix = span.matrix; draw.command = { ...draw.command, start: span.start, end: command.end };
        }
      } else if (marker?.crop) marker.commands.push(command);
      if (command.operator === 'q') stack.push([...matrix]);
      else if (command.operator === 'Q') {
        const previous = stack.pop();
        if (!previous) throw new Error('Unbalanced PDF graphics state');
        matrix = previous;
      } else if (command.operator === 'cm') {
        if (args.length !== 6 || args.some(arg => arg.kind !== 'number')) throw new Error('Invalid PDF transform');
        matrix = multiplyMatrix(matrix, args.map(arg => Number(arg.value)));
      } else if (command.operator === 'Do') {
        if (args.length !== 1 || args[0].kind !== 'name') throw new Error('Invalid image drawing command');
        const name = args[0].value;
        const target = this.get(resources, 'XObject', name);
        const type = this.get(target, 'Subtype').asName();
        const draw: Draw = { command, name, object: target, matrix: [...matrix] };
        if (type === 'Image' && !this.get(target, 'ImageMask').asBoolean()) {
          draw.occurrence = this.nextOccurrence++;
          if (marker?.crop) marker.draws.push(draw);
        } else if (type === 'Form') {
          const id = target.asIndirect();
          if (ancestors.has(id)) throw new Error('Recursive PDF image forms cannot be edited');
          const formResources = this.get(target, 'Resources');
          const formMatrix = this.get(target, 'Matrix');
          let nextMatrix = matrix;
          if (formMatrix.isArray()) {
            if (formMatrix.length !== 6) throw new Error('Invalid PDF form transform');
            nextMatrix = multiplyMatrix(matrix, Array.from({ length: 6 }, (_, index) => this.get(formMatrix, index).asNumber()));
          }
          draw.form = this.scan(this.read(target), formResources.isNull() ? resources : formResources,
            nextMatrix, new Set([...ancestors, id]), target, formResources.isNull());
        }
        node.draws.push(draw);
      }
    }
    if (stack.length) throw new Error('Unbalanced PDF graphics state');
    return node;
  }
  private validate(draw: Draw, pending: Pending) {
    const source = pending.image.source!;
    if (draw.matrix.some((value, index) => !Number.isFinite(value) || Math.abs(value - source.transform[index]) > 0.001 * Math.max(1, Math.abs(value)))) {
      throw new Error('The selected image no longer matches its source transform. Reopen the document and select it again.');
    }
    for (const [key, expected] of [['Width', source.pixelWidth], ['Height', source.pixelHeight]] as const) {
      if (expected !== undefined && this.get(draw.object, key).asNumber() !== expected) throw new Error('The selected image no longer matches its source dimensions.');
    }
    const actualRect = matrixBounds(multiplyMatrix(this.pageToTopLeft, draw.matrix));
    if (Object.entries(actualRect).some(([key, value]) => Math.abs(value - (source.rawRect ?? pending.image.originalRect)[key as keyof typeof actualRect]) > 0.1)) {
      throw new Error('The selected image no longer matches the page coordinates. Reopen the document and select it again.');
    }
  }
  rewrite(node: ContentNode): { stream: PDFObject; resources: PDFObject } | null {
    const edits: { start: number; end: number; value: string }[] = [];
    const resources = this.copy(node.resources);
    const xObjects = this.copy(this.get(node.resources, 'XObject'));
    resources.put('XObject', xObjects);
    let suffix = 0;
    const add = (object: PDFObject) => {
      let name: string;
      do { name = `PDFEditorImage${++suffix}`; } while (!this.get(xObjects, name).isNull());
      xObjects.put(name, object);
      return name;
    };
    for (const draw of node.draws) {
      if (draw.form) {
        const rewritten = this.rewrite(draw.form);
        if (rewritten) edits.push({ ...draw.command, value: `${pdfName(add(rewritten.stream))} Do` });
      } else if (draw.occurrence !== undefined && this.pending.has(draw.occurrence)) {
        const pending = this.pending.get(draw.occurrence)!;
        this.validate(draw, pending);
        this.applied.add(draw.occurrence);
        let value = '';
        if (!pending.deleted) {
          let name = draw.name;
          if (pending.replacement) {
            const image = this.own(new this.engine.Image(pending.replacement));
            name = add(this.own(this.document.addImage(image)));
          }
          let transform = identityMatrix();
          if (pending.transformed) {
            if (node.object) throw new Error('Moving or resizing images inside Form XObjects is not supported yet. Replace and Delete are supported.');
            const base = multiplyMatrix(this.pageToTopLeft, draw.matrix);
            const final = imageAppearanceMatrix(pending.image, pending.appearance, base);
            transform = multiplyMatrix(inverseMatrix(draw.contextMatrix ?? draw.matrix), multiplyMatrix(inverseMatrix(this.pageToTopLeft), final));
          } else if (pending.rect) {
            if (node.object) throw new Error('Moving or resizing images inside Form XObjects is not supported yet. Replace and Delete are supported.');
            const old = pending.image.originalRect, next = pending.rect;
            if (![next.x, next.y, next.width, next.height].every(Number.isFinite) || next.width <= 0 || next.height <= 0 || old.width <= 0 || old.height <= 0) throw new Error('Invalid image position or dimensions');
            const sx = next.width / old.width, sy = next.height / old.height;
            const viewportDelta: ImageMatrix = [sx, 0, 0, sy, next.x - old.x * sx, next.y - old.y * sy];
            const pdfDelta = multiplyMatrix(inverseMatrix(this.pageToTopLeft), multiplyMatrix(viewportDelta, this.pageToTopLeft));
            transform = multiplyMatrix(inverseMatrix(draw.matrix), multiplyMatrix(pdfDelta, draw.matrix));
          }
          const crop = imageCropUV(pending.appearance.crop);
          const cropped = crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1;
          const clipping = cropped ? `${[crop.x, crop.y, crop.width, crop.height].map(value => Number(value.toFixed(10))).join(' ')} re W n\n` : '';
          value = `q\n${transform.map(value => Number(value.toFixed(10))).join(' ')} cm\n${clipping}${pdfName(name)} Do\nQ`;
          if (cropped) value = `/${imageCropTag(pending.appearance.crop)} BMC\n${value}\nEMC`;
        }
        edits.push({ ...draw.command, value });
      }
    }
    if (!edits.length) return null;
    let text = node.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    // Do not leave an unused original image reachable solely through this local
    // resource dictionary. Shared uses elsewhere retain their own references.
    const used = new Set(commands(text).filter(command => command.operator === 'Do').map(command => command.operands[0].value));
    if (!node.draws.some(draw => draw.form?.inheritsResources)) {
      const unused: (string | number)[] = [];
      xObjects.forEach((value, key) => { this.own(value); if (!used.has(String(key))) unused.push(key); });
      for (const key of unused) xObjects.delete(key);
    }
    const dictionary = node.object ? this.copy(node.object) : this.own(this.document.newDictionary());
    for (const key of ['Length', 'Filter', 'DecodeParms']) dictionary.delete(key);
    if (node.object) dictionary.put('Resources', resources);
    return { stream: this.own(this.document.addStream(textToBytes(text), dictionary)), resources };
  }
  apply(pageIndex: number) {
    const page = this.own(this.document.loadPage(pageIndex));
    const transform = page.getTransform();
    const crop = this.engine.Rect.transform(page.getBounds(), this.engine.Matrix.invert(transform));
    const unit = Math.hypot(transform[0], transform[1]);
    this.pageToTopLeft = [unit, 0, 0, -unit, -crop[0] * unit, crop[3] * unit];
    const object = this.own(page.getObject());
    const resources = this.own(object.getInheritable('Resources'));
    const node = this.scan(this.read(this.get(object, 'Contents')), resources, identityMatrix(), new Set());
    if ([...this.pending.values()].some(pending => pending.image.source!.occurrenceCount !== this.nextOccurrence)) {
      throw new Error('The image count differs from the viewer. This page contains image draws that cannot be matched reliably.');
    }
    const rewritten = this.rewrite(node);
    if (this.applied.size !== this.pending.size) throw new Error('A selected image could not be located in the PDF. Inline, pattern, and soft-mask images are not supported.');
    if (rewritten) { object.put('Contents', rewritten.stream); object.put('Resources', rewritten.resources); }
  }
}

/** Change individual image draws, preserving surrounding content and shared uses. */
export async function applyImageEdits(data: ArrayBuffer, images: Map<number, PDFImage[]>, edits: ImageEditOperation[]): Promise<Uint8Array> {
  if (!edits.length) return new Uint8Array(data.slice(0));
  const known = new Map([...images.values()].flat().map(image => [image.id, image]));
  const pending = new Map<string, Pending>();
  for (const edit of edits) {
    const image = known.get(edit.imageId);
    if (!image?.source || image.unsupportedReason) throw new Error(image?.unsupportedReason ?? 'Image source information is missing. Reopen the document and select the image again.');
    if (!Number.isInteger(image.source.occurrence) || image.source.occurrence < 0 || !Number.isInteger(image.source.occurrenceCount) || image.source.occurrenceCount <= image.source.occurrence || image.source.transform.length !== 6 || !image.source.transform.every(Number.isFinite)) throw new Error('Invalid image source information');
    if (edit.type === 'crop' && (!edit.cropRect || !validImageCrop(edit.cropRect))) throw new Error('The image crop must leave a nonempty area inside the original image.');
    if (edit.rotation !== undefined && (!Number.isFinite(edit.rotation) || Math.abs(edit.rotation) > 1_000_000)) throw new Error('Invalid image rotation.');
    if (edit.cropRect && !validImageCrop(edit.cropRect)) throw new Error('The image crop must leave a nonempty area inside the original image.');
    if (edit.newRect && (!Object.values(edit.newRect).every(Number.isFinite) || edit.newRect.width <= 0 || edit.newRect.height <= 0)) throw new Error('Invalid image position or dimensions');
    const state = pending.get(image.id) ?? { image, deleted: false, appearance: imageAppearance(image, []), transformed: !!image.source.cropRect };
    if (edit.type === 'delete') state.deleted = true;
    else if (edit.type === 'replace') {
      if (!edit.newImageData?.byteLength) throw new Error('Replacement image data is missing');
      state.replacement = edit.newImageData;
      state.deleted = false;
    } else if (edit.type === 'move' || edit.type === 'resize') {
      if (!edit.newRect) throw new Error('New image dimensions are missing');
      state.rect = edit.newRect;
    }
    state.appearance = { ...state.appearance, rect: edit.newRect ?? state.appearance.rect, crop: edit.cropRect ?? state.appearance.crop,
      rotation: edit.rotation ?? state.appearance.rotation, flipX: edit.flipX ?? state.appearance.flipX, flipY: edit.flipY ?? state.appearance.flipY, deleted: state.deleted };
    if (edit.rotation !== undefined || edit.flipX !== undefined || edit.flipY !== undefined || edit.cropRect) state.transformed = true;
    pending.set(image.id, state);
  }
  const engine = await loadMuPDF();
  const document = new engine.PDFDocument(data);
  try {
    if (document.needsPassword()) throw new Error('Password-protected PDFs cannot be edited');
    const pages = new Map<number, Map<number, Pending>>();
    for (const state of pending.values()) {
      const pageNumber = state.image.pageNumber;
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.countPages()) throw new Error('Invalid image page number');
      const page = pages.get(pageNumber) ?? new Map<number, Pending>();
      if (page.has(state.image.source!.occurrence)) throw new Error('Ambiguous image occurrence');
      page.set(state.image.source!.occurrence, state);
      pages.set(pageNumber, page);
    }
    for (const [pageNumber, pageEdits] of pages) {
      const editor = new Editor(engine, document, pageEdits);
      try { editor.apply(pageNumber - 1); } finally { editor.dispose(); }
    }
    const output = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { return new Uint8Array(output.asUint8Array()); } finally { output.destroy(); }
  } finally { document.destroy(); }
}
