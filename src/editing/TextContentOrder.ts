import type { PDFDocument, PDFObject, PDFPage } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import { contentBytes, contentCommands, contentText, type ContentCommand } from './ImageEditApplier';
import { identityMatrix, inverseMatrix, multiplyMatrix, type ImageMatrix } from './imageMatrix';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
export interface TextAnchorTarget { id: string; rows: { x: number; width: number; baseline: number; size: number }[] }
/** Operators that set up the next text run without painting or moving it. */
const SETUP = new Set(['Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Tr', 'Ts', 'g', 'G', 'rg', 'RG', 'k', 'K', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'gs', 'ri', 'i', 'd', 'j', 'J', 'M', 'w', 'BMC', 'BDC', 'EMC', 'MP', 'DP']);
const MOVE = new Set(['Td', 'TD', 'Tm', 'T*']);
const SHOW = new Set(['Tj', 'TJ', "'", '"']);
const anchorName = (index: number) => `PDFEditorAnchor_${index}`;
const ANCHOR = /^PDFEditorAnchor_(\d+)$/;

function contentsOf(pageObject: PDFObject): string {
  const read = (source: PDFObject): string => {
    if (source.isArray()) {
      const parts: string[] = [];
      source.forEach(value => { try { parts.push(read(value)); } finally { value.destroy(); } });
      return parts.join('\n');
    }
    if (!source.isStream()) return '';
    const buffer = source.readStream();
    try { return contentText(buffer.asUint8Array()); } finally { buffer.destroy(); }
  };
  const contents = pageObject.get('Contents');
  try { return read(contents); } finally { contents.destroy(); }
}
const numbers = (command: ContentCommand) => command.operands.map(item => Number(item.value));
/** Text state tracking shared by both passes. Widths are unknown, so a position is a run's start. */
class TextCursor {
  matrix = identityMatrix();
  leading = 0;
  apply(command: ContentCommand) {
    const args = numbers(command);
    switch (command.operator) {
      case 'BT': this.matrix = identityMatrix(); break;
      case 'TL': this.leading = args[0] ?? 0; break;
      case 'Tm': if (args.length === 6) this.matrix = args as ImageMatrix; break;
      case 'TD': this.leading = -(args[1] ?? 0); this.move(args[0] ?? 0, args[1] ?? 0); break;
      case 'Td': this.move(args[0] ?? 0, args[1] ?? 0); break;
      case 'T*': case "'": case '"': this.move(0, -this.leading); break;
    }
  }
  private move(x: number, y: number) { this.matrix = multiplyMatrix(this.matrix, [1, 0, 0, 1, x, y]); }
}

/** Mark each row's place before its glyphs are removed: afterwards nothing shows where it was.
 * The removal filter drops empty marked content, but keeps a marked point. */
export function placeTextAnchors(engine: Engine, document: PDFDocument, page: PDFPage, targets: TextAnchorTarget[]): Map<string, number> {
  const found = new Map<string, number>();
  if (!targets.length) return found;
  const pageObject = page.getObject(), resources = pageObject.getInheritable('Resources');
  const transform = page.getTransform(), crop = engine.Rect.transform(page.getBounds(), engine.Matrix.invert(transform)), unit = Math.hypot(transform[0], transform[1]);
  const toTopLeft: ImageMatrix = [unit, 0, 0, -unit, -crop[0] * unit, crop[3] * unit];
  const offsets = new Map<string, number>(), sharedRuns = new Map<string, number>();
  const claim = (ctm: ImageMatrix, cursor: ImageMatrix, offset: number) => {
    const placed = multiplyMatrix(toTopLeft, multiplyMatrix(ctm, cursor)), x = placed[4], y = placed[5];
    for (const target of targets) {
      if (offsets.has(target.id)) continue;
      const onBaseline = target.rows.filter(row => Math.abs(row.baseline - y) < Math.max(1, row.size * .25));
      if (onBaseline.some(row => x >= row.x - 1 && x < row.x + row.width + 1)) offsets.set(target.id, offset);
      // A column gap inside one run has no operator of its own, so the run's start is the nearest place.
      else if (onBaseline.some(row => x < row.x)) sharedRuns.set(target.id, offset);
    }
  };
  const scan = (text: string, scope: PDFObject, start: ImageMatrix, depth: number, atOffset?: number) => {
    const list = contentCommands(text), stack: ImageMatrix[] = [], cursor = new TextCursor();
    let ctm = start, textStart = -1;
    list.forEach((command, index) => {
      if (command.operator === 'q') stack.push(ctm);
      else if (command.operator === 'Q') ctm = stack.pop() ?? ctm;
      else if (command.operator === 'cm') { const args = numbers(command); if (args.length === 6) ctm = multiplyMatrix(ctm, args as ImageMatrix); }
      else if (command.operator === 'BT') textStart = index;
      cursor.apply(command);
      if (SHOW.has(command.operator)) {
        // A row begins with its own positioning. Without one it continues the previous
        // run, and only the whole text object has a safe place in front of it.
        let first = index, moved = false;
        while (first > textStart + 1 && (SETUP.has(list[first - 1].operator) || MOVE.has(list[first - 1].operator))) { first--; moved ||= MOVE.has(list[first].operator); }
        const opensObject = first === textStart + 1 || !moved;
        claim(ctm, cursor.matrix, atOffset ?? (opensObject && textStart >= 0 ? list[textStart].start : list[first].start));
      } else if (command.operator === 'Do' && depth < 16 && command.operands[0]) {
        const xObjects = scope.get('XObject'), form = xObjects.isDictionary() ? xObjects.get(command.operands[0].value) : undefined;
        try {
          if (form && nameOfSubtype(form) === 'Form') {
            const matrix = form.get('Matrix'), nested = form.get('Resources');
            try {
              const local = matrix.isArray() && matrix.length === 6 ? Array.from({ length: 6 }, (_, position) => { const item = matrix.get(position); try { return item.asNumber(); } finally { item.destroy(); } }) as ImageMatrix : identityMatrix();
              const buffer = form.readStream();
              try { scan(contentText(buffer.asUint8Array()), nested.isDictionary() ? nested : scope, multiplyMatrix(ctm, local), depth + 1, atOffset ?? command.start); }
              finally { buffer.destroy(); }
            } finally { matrix.destroy(); nested.destroy(); }
          }
        } finally { form?.destroy(); xObjects.destroy(); }
      }
    });
  };
  try {
    const text = contentsOf(pageObject);
    scan(text, resources, identityMatrix(), 0);
    for (const [id, offset] of sharedRuns) if (!offsets.has(id)) offsets.set(id, offset);
    if (!offsets.size) return found;
    const inserts = targets.flatMap((target, index) => offsets.has(target.id) ? [{ offset: offsets.get(target.id)!, index, id: target.id }] : []).sort((a, b) => b.offset - a.offset);
    let marked = text;
    for (const item of inserts) { marked = `${marked.slice(0, item.offset)}/${anchorName(item.index)} MP\n${marked.slice(item.offset)}`; found.set(item.id, item.index); }
    const stream = document.addStream(contentBytes(marked), {});
    try { pageObject.put('Contents', stream); } finally { stream.destroy(); }
    return found;
  } catch { return new Map(); } // An unreadable stream still gets its text, on top as before.
  finally { resources.destroy(); pageObject.destroy(); }
}
function nameOfSubtype(form: PDFObject) {
  const subtype = form.get('Subtype');
  try { return subtype.isName() ? subtype.asName() : ''; } finally { subtype.destroy(); }
}

/** Replace surviving anchors with their text draws, keeping reading order and stacking.
 * Anything that cannot be drawn safely there is returned, to be appended on top instead. */
export function resolveTextAnchors(pageObject: PDFObject, draws: Map<number, string[]>, base: ImageMatrix) {
  const text = contentsOf(pageObject), edits: { start: number; end: number; value: string }[] = [], placed = new Set<number>();
  const list = contentCommands(text), stack: { ctm: ImageMatrix; clipped: boolean }[] = [], cursor = new TextCursor();
  let ctm = identityMatrix(), clipped = false, inText = false, clipText = false;
  const draw = (index: number) => {
    const local = multiplyMatrix(inverseMatrix(ctm), base).map(value => Number(value.toFixed(10))).join(' ');
    return `q\n${local} cm\n[] 0 d 0 Tc 0 Tw 100 Tz 0 TL 0 Tr 0 Ts /PDFEditorTextState gs\n${draws.get(index)!.join('\n')}\nQ\n`;
  };
  for (let index = 0; index < list.length; index++) {
    const command = list[index], anchor = command.operator === 'MP' ? ANCHOR.exec(command.operands[0]?.value ?? '') : null;
    if (anchor) {
      const id = Number(anchor[1]);
      let value = '';
      if (draws.has(id) && !clipped && !clipText && Number.isFinite(ctm[0])) {
        if (!inText) { value = draw(id); placed.add(id); }
        else {
          // Splitting a text object restores the line matrix only, so the next run must reposition itself.
          let next = index + 1;
          while (next < list.length && SETUP.has(list[next].operator)) next++;
          if (MOVE.has(list[next]?.operator) || list[next]?.operator === 'ET') {
            value = `ET\n${draw(id)}BT\n${cursor.matrix.map(item => Number(item.toFixed(10))).join(' ')} Tm\n`;
            placed.add(id);
          }
        }
      }
      edits.push({ start: command.start, end: command.end, value });
      continue;
    }
    if (command.operator === 'q') stack.push({ ctm, clipped });
    else if (command.operator === 'Q') { const state = stack.pop(); if (state) ({ ctm, clipped } = state); }
    else if (command.operator === 'cm') { const args = numbers(command); if (args.length === 6) ctm = multiplyMatrix(ctm, args as ImageMatrix); }
    else if (command.operator === 'W' || command.operator === 'W*') clipped = true;
    else if (command.operator === 'BT') { inText = true; }
    else if (command.operator === 'ET') { inText = false; }
    else if (command.operator === 'Tr' && Number(command.operands[0]?.value) >= 4) clipText = true;
    else if (command.operator === 'Tr') clipText = false;
    cursor.apply(command);
  }
  if (!edits.length) return { placed, content: undefined };
  let result = text;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return { placed, content: contentBytes(result) };
}
