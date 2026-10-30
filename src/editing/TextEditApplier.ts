import type { Color, PDFDocument, PDFObject, PDFPage } from 'mupdf';
import { loadMuPDF, toMuPDFPageRect } from '../utils/mupdf';
import type { TextBlock, TextEditOperation } from './types';
import { assertTextEditSource } from './TextEditSource';
import { standardTextFont, TextLayoutSession, type TextLayoutControl, type TextLayoutInput, type TextLayoutResult } from './TextLayout';
import { readInlineTextBounds } from './InlineTextBounds';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
export interface PreparedTextEditLayout { input: TextLayoutInput; layout: TextLayoutResult; page: { width: number; height: number }; availableRect?: import('./types').TextRect }
interface PreparedBlock extends PreparedTextEditLayout { block: TextBlock }
function cancelled(control: TextLayoutControl) { if (control.signal?.aborted) throw new DOMException('Text editing cancelled.', 'AbortError'); }

function assertReplaceableTextRendering(engine: Engine, page: PDFPage, pageNumber: number) {
  let hasInvisibleText = false;
  let hasClippingText = false;
  const device = new engine.Device({
    ignoreText(text) {
      try { text.walk({ showGlyph() { hasInvisibleText = true; } }); }
      finally { text.destroy(); }
    },
    clipText(text) {
      try { text.walk({ showGlyph() { hasClippingText = true; } }); }
      finally { text.destroy(); }
    },
    clipStrokeText(text) {
      try { text.walk({ showGlyph() { hasClippingText = true; } }); }
      finally { text.destroy(); }
    },
  });
  try {
    // Interpret content, including nested Form XObjects. A source-stream string
    // search cannot reliably detect inherited text rendering modes or OCR fonts.
    page.runPageContents(device, engine.Matrix.identity);
    device.close();
  } finally { device.destroy(); }
  if (hasInvisibleText) {
    throw new Error(`Page ${pageNumber} contains an invisible OCR text layer. Editing scanned text is not supported because the original image would remain underneath. No PDF was changed.`);
  }
  if (hasClippingText) {
    throw new Error(`Page ${pageNumber} uses text as a clipping path. Replacing clipping text is not supported safely. No PDF was changed.`);
  }
}

function sourceStyle(engine: Engine, page: PDFPage, block: TextBlock, session: TextLayoutSession): { name: string; color: Color; sourceFontKey?: string } {
  let name = block.style.fontName;
  let color: Color = [0, 0, 0];
  const area = toMuPDFPageRect(engine, page, block.rect);
  const text = page.toStructuredText('');
  let found = false;
  let sourceFontKey: string | undefined;
  try {
    text.walk({
      onChar(character, _origin, font, _size, quad, charColor) {
        let retained = false;
        try {
          if (found || !character.trim()) return;
          const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
          if (x < area[0] || x > area[2] || y < area[1] || y > area[3]) return;
          name = `${font.isMono() ? 'Courier' : font.isSerif() ? 'Times' : 'Helvetica'}${font.isBold() ? ' Bold' : ''}${font.isItalic() ? ' Italic' : ''}`;
          color = charColor.length === 3 ? [...charColor] as Color : [0, 0, 0];
          sourceFontKey = `source:${block.id}`;
          session.useSourceFont(sourceFontKey, font, standardTextFont(name));
          retained = true;
          found = true;
        } finally { if (!retained) font.destroy(); }
      },
    });
  } finally {
    text.destroy();
  }
  if (block.style.fontColor && /^#[0-9a-f]{6}$/i.test(block.style.fontColor)) {
    color = [1, 3, 5].map(offset => parseInt(block.style.fontColor!.slice(offset, offset + 2), 16) / 255) as Color;
  }
  return { name: standardTextFont(name), color, sourceFontKey };
}

function pageGeometry(engine: Engine, page: PDFPage) {
  const transform = page.getTransform(), crop = engine.Rect.transform(page.getBounds(), engine.Matrix.invert(transform));
  const unit = Math.hypot(transform[0], transform[1]);
  return { width: (crop[2] - crop[0]) * unit, height: (crop[3] - crop[1]) * unit, crop, unit };
}

function prepareBlock(engine: Engine, page: PDFPage, block: TextBlock, edit: TextEditOperation, session: TextLayoutSession, control: TextLayoutControl): PreparedBlock {
  cancelled(control);
  if (!block.editable) throw new Error(block.unsupportedReason ?? 'This text block is read-only.');
  if (block.lines.some(line => line.items.some(item => Math.abs(item.transform[1]) > 0.001 || Math.abs(item.transform[2]) > 0.001))) throw new Error(`Rotated or vertical text inside page ${block.pageNumber} cannot be replaced yet. Page rotation itself is supported.`);
  const source = sourceStyle(engine, page, block, session), overrides = edit.layout ?? {}, geometry = pageGeometry(engine, page);
  const originalBaseline = overrides.keepBaseline || !Object.values(overrides).some(value => value !== undefined);
  const availableRect = readInlineTextBounds(engine, page, block, geometry.width, geometry.height,
    overrides.translate ? overrides.targetRect : undefined, overrides.fitToContent);
  const rect = { ...(overrides.targetRect ?? (overrides.keepBaseline ? availableRect : block.rect)) };
  if (overrides.translate && overrides.keepBaseline && overrides.autoGrow) {
    rect.width = availableRect.width; rect.height = availableRect.height;
  }
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > geometry.width + 0.01 || rect.y + rect.height > geometry.height + 0.01) throw new Error('The text layout region must be completely inside the visible page.');
  const input: TextLayoutInput = { text: edit.newText, rect, fontName: overrides.fontName ?? source.name, fontSize: overrides.fontSize ?? block.style.fontSize,
    fontColor: overrides.fontColor ?? '#' + source.color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join(''),
    alignment: overrides.alignment ?? block.style.alignment, lineHeight: overrides.lineHeight ?? Math.min(5, Math.max(originalBaseline ? .25 : 1, Number.isFinite(block.style.lineHeight) ? block.style.lineHeight : 1.2)), reflow: overrides.reflow };
  if (!overrides.fontName) input.sourceFontKey = source.sourceFontKey;
  if (originalBaseline) input.legacyBaseline = (block.lines[0]?.baseline ?? block.rect.y + input.fontSize * 0.8)
    + (overrides.translate ? rect.y - block.rect.y : 0);
  if (input.sourceFontKey && input.legacyBaseline !== undefined && input.fontSize === block.style.fontSize) input.sourceRows = block.lines.map(line => ({ text: line.text, width: line.width }));
  let layout = session.layout(input, control);
  if (overrides.fitToContent && originalBaseline && !layout.fits) {
    const natural = session.layout({ ...input, rect: { ...input.rect, width: availableRect.width, height: availableRect.height } }, control);
    if (natural.fits) {
      input.rect.width = Math.max(input.rect.width, Math.min(availableRect.width, Math.ceil(Math.max(0, ...natural.lines.map(line => line.width)) * 1000) / 1000 + .01));
      input.rect.height = Math.max(input.rect.height, natural.requiredHeight);
      layout = session.layout(input, control);
    }
  }
  return { block, input, layout, page: { width: geometry.width, height: geometry.height }, availableRect };
}

/** Resolve original PDF style and measure without changing the document. */
export async function prepareTextEditLayout(data: ArrayBuffer | Uint8Array, block: TextBlock, edit?: TextEditOperation, control: TextLayoutControl = {}): Promise<PreparedTextEditLayout> {
  if (edit && edit.blockId !== block.id) throw new Error('The text edit does not belong to the selected source block.');
  cancelled(control); await assertTextEditSource(data instanceof Uint8Array ? new Uint8Array(data).buffer : data, control.signal);
  const engine = await loadMuPDF(); cancelled(control);
  const document = new engine.PDFDocument(data), session = new TextLayoutSession(engine);
  try {
    if (!Number.isInteger(block.pageNumber) || block.pageNumber < 1 || block.pageNumber > document.countPages()) throw new Error('The text block references an invalid page.');
    const page = document.loadPage(block.pageNumber - 1);
    try {
      assertReplaceableTextRendering(engine, page, block.pageNumber);
      const prepared = prepareBlock(engine, page, block, edit ?? { blockId: block.id, originalText: block.text, newText: block.text, timestamp: 0 }, session, control);
      return { input: prepared.input, layout: prepared.layout, page: prepared.page, availableRect: prepared.availableRect };
    } finally { page.destroy(); }
  } finally { session.destroy(); document.destroy(); }
}

function copyDictionary(document: PDFDocument, source: PDFObject): PDFObject {
  const copy = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => { try { copy.put(key, value); } finally { value.destroy(); } });
  return copy;
}

function addReplacementText(engine: Engine, document: PDFDocument, page: PDFPage, blocks: PreparedBlock[], session: TextLayoutSession) {
  if (blocks.every(block => block.layout.lines.every(line => line.glyphs.length === 0))) return;
  const transform = page.getTransform();
  const crop = engine.Rect.transform(page.getBounds(), engine.Matrix.invert(transform));
  const unit = Math.hypot(transform[0], transform[1]);
  const width = (crop[2] - crop[0]) * unit;
  const height = (crop[3] - crop[1]) * unit;
  const output = new engine.Buffer();
  const writer = new engine.DocumentWriter(output, 'pdf', '');
  let overlay: PDFDocument | undefined;
  const handles: Array<{ destroy(): void }> = [];
  const keep = <T extends { destroy(): void }>(value: T): T => { handles.push(value); return value; };
  try {
    const device = writer.beginPage([0, 0, width, height]);
    try {
      for (const prepared of blocks) session.draw(device, prepared.input, prepared.layout);
      device.close();
    } finally {
      device.destroy();
    }
    writer.endPage();
    writer.close();
    overlay = new engine.PDFDocument(output);
    const overlayPage = keep(overlay.findPage(0));
    const overlayContents = keep(overlayPage.get('Contents'));
    const content = keep(overlayContents.readStream());
    const resources = keep(document.graftObject(keep(overlayPage.get('Resources'))));
    // Detach the input from WASM memory before addStream can grow that memory.
    const form = keep(document.addStream(new Uint8Array(content.asUint8Array()), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources }));
    const pageObject = keep(page.getObject());
    const oldResources = keep(pageObject.getInheritable('Resources'));
    const newResources = keep(copyDictionary(document, oldResources));
    const oldXObjects = oldResources.isDictionary() ? keep(oldResources.get('XObject')) : oldResources;
    const xObjects = keep(copyDictionary(document, oldXObjects));
    let name = 'PDFEditorText';
    let suffix = 0;
    while (true) { const existing = xObjects.get(name); try { if (existing.isNull()) break; name = `PDFEditorText${++suffix}`; } finally { existing.destroy(); } }
    xObjects.put(name, form);
    newResources.put('XObject', xObjects);
    pageObject.put('Resources', newResources);

    // Keep the original page and widgets. Append a vector Form XObject in native
    // PDF space; /Rotate and /UserUnit continue to apply to both old and new text.
    const contents = keep(document.newArray());
    contents.push(keep(document.addStream('q\n', {})));
    const previous = keep(pageObject.get('Contents'));
    if (previous.isArray()) previous.forEach(value => { try { contents.push(value); } finally { value.destroy(); } });
    else if (!previous.isNull()) contents.push(previous);
    contents.push(keep(document.addStream(`Q\nq\n${1 / unit} 0 0 ${1 / unit} ${crop[0]} ${crop[1]} cm\n/${name} Do\nQ\n`, {})));
    pageObject.put('Contents', contents);
  } finally {
    for (const handle of handles.reverse()) handle.destroy();
    overlay?.destroy();
    writer.destroy();
    output.destroy();
  }
}

/** Replace edited text in the PDF content stream while retaining surrounding content. */
export async function applyTextEdits(
  data: ArrayBuffer,
  blocks: Map<number, TextBlock[]>,
  edits: TextEditOperation[],
  control: TextLayoutControl = {},
): Promise<Uint8Array> {
  return writeTextEdits(data, blocks, edits, control, false);
}

/** Visual feedback may show overflowing text; the actual writer still rejects it. */
export async function previewInlineTextEdits(data: ArrayBuffer, blocks: Map<number, TextBlock[]>, edits: TextEditOperation[], rects?: Map<string, import('./types').TextRect>): Promise<Uint8Array> {
  return writeTextEdits(data, blocks, edits, {}, true, rects);
}

async function writeTextEdits(data: ArrayBuffer, blocks: Map<number, TextBlock[]>, edits: TextEditOperation[], control: TextLayoutControl, preview: boolean, rects?: Map<string, import('./types').TextRect>): Promise<Uint8Array> {
  cancelled(control);
  if (edits.length === 0) return new Uint8Array(data.slice(0));
  const latest = new Map<string, TextEditOperation>();
  const original = new Map<string, TextEditOperation>();
  for (const edit of edits) {
    if (!latest.has(edit.blockId) || edit.timestamp >= latest.get(edit.blockId)!.timestamp) latest.set(edit.blockId, edit);
    if (!original.has(edit.blockId) || edit.timestamp < original.get(edit.blockId)!.timestamp) original.set(edit.blockId, edit);
  }
  const indexedBlocks = new Map([...blocks.values()].flat().map(block => [block.id, block]));
  const changed = [...latest.values()].filter(edit => edit.newText !== original.get(edit.blockId)!.originalText || (edit.layout && Object.values(edit.layout).some(value => value !== undefined)));
  if (changed.length === 0) return new Uint8Array(data.slice(0));
  await assertTextEditSource(data, control.signal);
  const engine = await loadMuPDF();
  cancelled(control);
  const document = new engine.PDFDocument(data);
  const session = new TextLayoutSession(engine);
  try {
    const perPage = new Map<number, Array<{ block: TextBlock; edit: TextEditOperation }>>();
    for (const edit of changed) {
      const block = indexedBlocks.get(edit.blockId);
      if (!block) throw new Error(`Cannot export an edit because text block ${edit.blockId} is missing.`);
      if (!Number.isInteger(block.pageNumber) || block.pageNumber < 1 || block.pageNumber > document.countPages()) throw new Error(`Text block ${block.id} references an invalid page.`);
      const entries = perPage.get(block.pageNumber) ?? [];
      entries.push({ block, edit });
      perPage.set(block.pageNumber, entries);
    }
    // Recheck the PDF itself even for cached blocks marked editable. Replacing
    // an OCR layer alone would leave scanned letters underneath the new text.
    // Check every target page before making the first content modification.
    const preparedPages = new Map<number, PreparedBlock[]>();
    for (const [pageNumber, entries] of perPage) {
      cancelled(control);
      const page = document.loadPage(pageNumber - 1);
      try {
        assertReplaceableTextRendering(engine, page, pageNumber);
        const prepared = entries.map(({ block, edit }) => prepareBlock(engine, page, block, edit, session, control));
        for (const item of prepared) rects?.set(item.block.id, { ...item.input.rect });
        const overflow = prepared.find(item => !item.layout.fits);
        if (overflow && !preview) throw new Error(`Page ${pageNumber}: ${overflow.layout.overflow}`);
        preparedPages.set(pageNumber, prepared);
      } finally { page.destroy(); }
    }
    for (const [pageNumber, entries] of perPage) {
      const page = document.loadPage(pageNumber - 1);
      try {
        cancelled(control);
        const prepared = preparedPages.get(pageNumber)!;
        for (const { block } of entries) {
          const annotation = page.createAnnotation('Redact');
          try {
            annotation.setRect(toMuPDFPageRect(engine, page, block.rect));
            annotation.applyRedaction(0, engine.PDFPage.REDACT_IMAGE_NONE, engine.PDFPage.REDACT_LINE_ART_NONE, engine.PDFPage.REDACT_TEXT_REMOVE);
          } finally {
            annotation.destroy();
          }
        }
        addReplacementText(engine, document, page, prepared, session);
      } finally {
        page.destroy();
      }
    }
    // Remove unreachable old content without MuPDF 1.28's aggressive stream
    // deduplication, which can discard newly grafted Forms in AcroForm PDFs.
    cancelled(control);
    const result = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { cancelled(control); return new Uint8Array(result.asUint8Array()); }
    finally { result.destroy(); }
  } finally {
    session.destroy();
    document.destroy();
  }
}
