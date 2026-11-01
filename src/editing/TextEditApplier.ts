import type { PDFDocument, PDFObject, PDFPage } from 'mupdf';
import { loadMuPDF, toMuPDFPageRect } from '../utils/mupdf';
import type { ImageEditOperation, PDFImage, TextBlock, TextEditOperation, TextRect } from './types';
import { assertTextEditSource } from './TextEditSource';
import { standardTextFont, TextLayoutSession, type TextLayoutControl, type TextLayoutInput, type TextLayoutResult } from './TextLayout';
import { readInlineTextBounds, readInlineTextObstacles } from './InlineTextBounds';
import { readTextSourceMetrics, replacementTextStyles } from './TextSourceMetrics';
import { TextCheckError, type TextCheckIssue, type TextCheckReport, type TextFontInfo } from './TextCheckTypes';
import { textRegionTag } from './TextRegionMarkers';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
export interface PreparedTextEditLayout { input: TextLayoutInput; layout: TextLayoutResult; page: { width: number; height: number }; availableRect?: import('./types').TextRect; fonts?: TextFontInfo }
export interface TextLayoutContext {
  blocks: TextBlock[];
  edits: TextEditOperation[];
  images?: PDFImage[];
  imageEdits?: ImageEditOperation[];
}
interface PreparedBlock extends PreparedTextEditLayout { block: TextBlock }
function cancelled(control: TextLayoutControl) { if (control.signal?.aborted) throw new DOMException('Text editing cancelled.', 'AbortError'); }
function textFlow(block: TextBlock, edit: TextEditOperation) {
  const layout = edit.layout;
  // Upgrade pre-mode-separation inline drafts without discarding their text.
  return layout?.flow ?? (layout?.keepBaseline && layout.reflow && layout.autoGrow
    ? block.kind === 'line' || layout.translate ? 'object' : 'paragraph' : undefined);
}

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

function pageGeometry(engine: Engine, page: PDFPage) {
  const transform = page.getTransform(), crop = engine.Rect.transform(page.getBounds(), engine.Matrix.invert(transform));
  const unit = Math.hypot(transform[0], transform[1]);
  return { width: (crop[2] - crop[0]) * unit, height: (crop[3] - crop[1]) * unit, crop, unit };
}

function prepareBlock(engine: Engine, page: PDFPage, block: TextBlock, edit: TextEditOperation, session: TextLayoutSession, control: TextLayoutControl, context?: { shiftY: number; peers: TextRect[] }): PreparedBlock {
  cancelled(control);
  if (!block.editable) throw new Error(block.unsupportedReason ?? 'This text block is read-only.');
  if (block.lines.some(line => line.items.some(item => Math.abs(item.transform[1]) > 0.001 || Math.abs(item.transform[2]) > 0.001))) throw new Error(`Rotated or vertical text inside page ${block.pageNumber} cannot be replaced yet. Page rotation itself is supported.`);
  const source = readTextSourceMetrics(engine, page, block, session), overrides = { ...(block.fontPreference ? { fontName: block.fontPreference.fontName, keepBaseline: true } : {}), ...edit.layout }, geometry = pageGeometry(engine, page);
  const font = edit.font?.id === overrides.fontName ? edit.font : block.fontPreference?.font?.id === overrides.fontName ? block.fontPreference?.font : undefined;
  if (font) session.useImportedFont(font);
  const sourceSize = source?.fontSize ?? block.style.fontSize;
  const originalBaseline = overrides.keepBaseline || !Object.values(overrides).some(value => value !== undefined);
  const availableRect = readInlineTextBounds(engine, page, block, geometry.width, geometry.height,
    overrides.translate ? overrides.targetRect : undefined, overrides.fitToContent);
  const rect = { ...(overrides.targetRect ?? block.rect) };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > geometry.width + 0.01 || rect.y + rect.height > geometry.height + 0.01) throw new Error('The text layout region must be completely inside the visible page.');
  const input: TextLayoutInput = { text: edit.newText, rect, fontName: overrides.fontName ?? source?.fontName ?? standardTextFont(block.style.fontName), fontSize: overrides.fontSize ?? sourceSize,
    fontColor: overrides.fontColor ?? block.style.fontColor ?? source?.fontColor ?? '#000000',
    alignment: overrides.alignment ?? block.style.alignment, lineHeight: overrides.lineHeight ?? Math.min(5, Math.max(originalBaseline ? .25 : 1, Number.isFinite(block.style.lineHeight) ? block.style.lineHeight * block.style.fontSize / sourceSize : 1.2)), reflow: overrides.reflow };
  if (!overrides.fontName) input.sourceFontKey = source?.fontKey;
  if (source) {
    input.sourceFontSize = sourceSize;
    input.sourceStyles = replacementTextStyles(source.source, input.text, !!overrides.reflow).map(style => ({ ...style,
      ...(overrides.fontName ? { fontKey: overrides.fontName, fontName: overrides.fontName } : {}),
      ...(overrides.fontColor || block.style.fontColor ? { fontColor: input.fontColor } : {}),
    }));
  }
  if (originalBaseline) input.legacyBaseline = (block.lines[0]?.baseline ?? block.rect.y + input.fontSize * 0.8)
    + (overrides.translate ? rect.y - block.rect.y : 0);
  if (input.sourceFontKey && input.legacyBaseline !== undefined && input.fontSize === sourceSize) input.sourceRows = block.lines.map(line => ({ text: line.text, width: line.width,
    ...(overrides.alignment === undefined ? { x: line.x + (overrides.translate ? rect.x - block.rect.x : 0) } : {}),
    ...(overrides.lineHeight === undefined ? { baseline: line.baseline + (overrides.translate ? rect.y - block.rect.y : 0) } : {}),
  }));
  const flow = textFlow(block, edit);
  if (flow === 'paragraph' && ['left', 'justify'].includes(input.alignment) && block.lines.length > 1) {
    input.firstLineIndent = Math.max(0, block.lines[0].x - block.rect.x);
  }
  // Automatic typing is resolved here, not by an asynchronous preview mutating
  // the edit. Save, preview, reload and Apply therefore use the same final area.
  const grow = overrides.fitToContent || overrides.autoGrow || (overrides.keepBaseline && overrides.reflow && !overrides.translate);
  if (grow && block.lines.length === 1 && input.alignment === 'left'
    && (overrides.fitToContent || (flow === 'paragraph' && !overrides.targetRect))) {
    const natural = session.layout({ ...input, rect: { ...input.rect, width: availableRect.width } }, control);
    input.rect.width = Math.max(input.rect.width, Math.min(availableRect.width, Math.ceil(Math.max(0, ...natural.lines.map(line => line.width)) * 1000) / 1000 + .01));
  }
  let layout = session.layout(input, control);
  if (grow && flow === 'paragraph' && block.lines.length === 1 && !overrides.targetRect && context) {
    // A one-row paragraph may use clear space to its right, but its new rows
    // must not grow across a neighboring column that starts farther down.
    // Narrowing can add more rows, so repeat against the resulting footprint.
    // Existing source width is always retained; never squeeze original text.
    for (;;) {
      const top = input.rect.y + context.shiftY, bottom = top + layout.requiredHeight;
      const right = Math.min(input.rect.x + input.rect.width, ...context.peers
        .filter(peer => peer.x >= block.rect.x + block.rect.width - .1 && peer.y < bottom && peer.y + peer.height > top)
        .map(peer => peer.x - Math.min(4, input.fontSize * .25)));
      const width = Math.max(block.rect.width, right - input.rect.x);
      if (width >= input.rect.width - .001) break;
      input.rect.width = width;
      layout = session.layout(input, control);
    }
  }
  if (grow && flow) {
    // A paragraph owns its new rows. Following paragraphs are moved by the
    // page planner, rather than being treated as a 14pt-high hard boundary.
    // An object also owns its rows, but never enlists its neighbors in reflow.
    // Object widths and multi-row paragraph wrap columns remain fixed.
    input.rect.height = Math.max(.001, layout.requiredHeight);
    layout = session.layout(input, control);
    if (!context?.shiftY && input.rect.y + input.rect.height > geometry.height + .001) {
      layout.fits = false;
      layout.overflow = 'The edited text extends beyond the bottom of the page. Move the region or split the paragraph before saving; all text has been kept.';
    }
  } else if (grow && originalBaseline && !layout.fits) {
    const natural = session.layout({ ...input, rect: { ...input.rect, width: availableRect.width, height: availableRect.height } }, control);
    if (natural.fits) {
      input.rect.width = Math.max(input.rect.width, Math.min(availableRect.width, Math.ceil(Math.max(0, ...natural.lines.map(line => line.width)) * 1000) / 1000 + .01));
      input.rect.height = Math.max(input.rect.height, natural.requiredHeight);
      layout = session.layout(input, control);
    }
  }
  const fonts: TextFontInfo = { original: source?.fontNames ?? [block.style.fontName], used: session.usedFontNames(layout),
    mode: layout.warnings.length || (!source && !overrides.fontName) ? 'fallback' : overrides.fontName ? 'selected' : 'original' };
  return { block, input, layout, page: { width: geometry.width, height: geometry.height }, availableRect, fonts };
}

const overlaps = (a: TextRect, b: TextRect) => a.x < b.x + b.width - .05 && b.x < a.x + a.width - .05
  && a.y < b.y + b.height - .05 && b.y < a.y + a.height - .05;
const sharesColumn = (a: TextRect, b: TextRect) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > Math.min(a.width, b.width) * .3;

function shiftPrepared(prepared: PreparedBlock, dy: number) {
  prepared.input.rect.y += dy;
  if (prepared.input.legacyBaseline !== undefined) prepared.input.legacyBaseline += dy;
  if (prepared.layout.inkBounds) prepared.layout.inkBounds.y += dy;
  for (const line of prepared.layout.lines) {
    line.baseline += dy;
    for (const glyph of line.glyphs) glyph.baseline += dy;
  }
}

/** One deterministic page plan is used by the live preview, checks and writer. */
function preparePageTextEdits(engine: Engine, page: PDFPage, blocks: TextBlock[], edits: TextEditOperation[], session: TextLayoutSession, control: TextLayoutControl, issues?: TextCheckIssue[]): PreparedBlock[] {
  const changes = new Map(edits.map(edit => [edit.blockId, edit]));
  const prepared = new Map<string, PreparedBlock>();
  const geometry = pageGeometry(engine, page);
  const flow = edits.some(edit => { const block = blocks.find(block => block.id === edit.blockId); return block && textFlow(block, edit) === 'paragraph'; });
  const positioned = blocks.filter(block => {
    const edit = changes.get(block.id);
    return edit?.layout?.targetRect && textFlow(block, edit) === 'object';
  });
  const positionedIds = new Set(positioned.map(block => block.id));
  // Printed page numbers are fixed page furniture, not the end of a body
  // paragraph's flow. Moving them used to manufacture a false page overflow.
  const movable = blocks.filter(block => block.editable && block.kind !== 'line' && !positionedIds.has(block.id)
    && !(block.lines.length === 1 && /^\s*\d{1,6}\s*$/u.test(block.lines[0].text)
      && block.rect.width < geometry.width * .25 && block.rect.y > geometry.height * .9));
  const movableIds = new Set(movable.map(block => block.id));
  const obstacles = flow ? [
    ...readInlineTextObstacles(engine, page, [...movable, ...positioned].map(block => block.rect)),
    ...positioned.filter(block => changes.get(block.id)!.newText !== '').map(block => changes.get(block.id)!.layout!.targetRect!),
  ] : [];
  const deltas: { rect: TextRect; delta: number }[] = [];
  const shift = (block: TextBlock) => flow && movableIds.has(block.id)
    ? deltas.filter(item => item.rect.y + item.rect.height <= block.rect.y + .1 && sharesColumn(item.rect, block.rect)).reduce((sum, item) => sum + item.delta, 0) : 0;
  for (const block of [...blocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    cancelled(control);
    const edit = changes.get(block.id);
    const dy = shift(block);
    if (!edit && Math.abs(dy) < .001) continue;
    let item: PreparedBlock;
    try {
      item = prepareBlock(engine, page, block, edit ?? {
        blockId: block.id, originalText: block.text, newText: block.text, timestamp: 0,
        layout: { keepBaseline: true },
      }, session, control, { shiftY: dy, peers: blocks.filter(peer => peer.id !== block.id).map(peer => positionedIds.has(peer.id)
        ? changes.get(peer.id)!.layout!.targetRect! : { ...peer.rect, y: peer.rect.y + shift(peer) }) });
    } catch (error) {
      if (!issues) throw error;
      cancelled(control);
      issues.push({ blockId: block.id, pageNumber: block.pageNumber, kind: 'unsupported', message: error instanceof Error ? error.message : String(error), blocking: true });
      continue;
    }
    if (Math.abs(dy) >= .001) shiftPrepared(item, dy);
    const paragraph = edit && textFlow(block, edit) === 'paragraph';
    if (paragraph) {
      const delta = item.layout.requiredHeight - block.rect.height;
      if (Math.abs(delta) >= .001) deltas.push({ rect: block.rect, delta });
    }
    // Validate the final page position, after all earlier paragraphs have
    // released or consumed space. Testing the old y coordinate first leaves a
    // false overflow behind when a preceding deletion pulls this edit upwards.
    if (flow && (paragraph || Math.abs(dy) >= .001)) {
      const ink = item.layout.inkBounds;
      if (item.input.rect.y < 0 || item.input.rect.y + item.layout.requiredHeight > item.page.height + .001
        || (ink && ink.y + ink.height > item.page.height + .001)) {
        item.layout.fits = false;
        item.layout.overflow = 'The reflowed paragraphs extend beyond the bottom of the page. Move the region or split the paragraph before saving; all text has been kept.';
      } else if (ink && obstacles.some(obstacle => overlaps(ink, obstacle) && !overlaps(block.rect, obstacle))) {
        item.layout.fits = false;
        item.layout.overflow = 'Paragraph reflow needs more space before an image, drawing, form field, or read-only text. Move that content or adjust the paragraph before saving; all text has been kept.';
      }
    }
    prepared.set(block.id, item);
  }
  return [...prepared.values()];
}

/** Resolve original PDF style and measure without changing the document. */
export async function prepareTextEditLayout(data: ArrayBuffer | Uint8Array, block: TextBlock, edit?: TextEditOperation, control: TextLayoutControl = {}, context?: TextLayoutContext): Promise<PreparedTextEditLayout> {
  if (edit && edit.blockId !== block.id) throw new Error('The text edit does not belong to the selected source block.');
  const source = data instanceof Uint8Array ? new Uint8Array(data).buffer : data;
  cancelled(control); await assertTextEditSource(source, control.signal);
  if (!context) return measureTextEditLayout(source, block, edit, control);
  // The advanced dialog must inspect the same body as preview/check/export:
  // passive managed marks are detached, and pending image moves or deletions
  // are applied before computing available space for paragraphs.
  const { preservePageDecorations, imagesWithoutDetachedDecorations } = await import('../core/PreservePageDecorations');
  const images = (context.images ?? []).filter(image => image.pageNumber === block.pageNumber);
  const imageIds = new Set(images.map(image => image.id));
  const imageEdits = (context.imageEdits ?? []).filter(item => imageIds.has(item.imageId));
  let measured: PreparedTextEditLayout | undefined;
  await preservePageDecorations(source, new Set([block.pageNumber]), async (body, detached) => {
    cancelled(control);
    let actual = body;
    if (imageEdits.length) {
      const { applyImageEdits } = await import('./ImageEditApplier');
      actual = new Uint8Array(await applyImageEdits(body,
        imagesWithoutDetachedDecorations(new Map([[block.pageNumber, images]]), detached), imageEdits)).buffer;
    }
    measured = await measureTextEditLayout(actual, block, edit, control, context);
    return new Uint8Array(body);
  });
  cancelled(control);
  return measured!;
}

async function measureTextEditLayout(data: ArrayBuffer, block: TextBlock, edit: TextEditOperation | undefined, control: TextLayoutControl, context?: TextLayoutContext): Promise<PreparedTextEditLayout> {
  const engine = await loadMuPDF(); cancelled(control);
  const document = new engine.PDFDocument(data), session = new TextLayoutSession(engine);
  try {
    if (!Number.isInteger(block.pageNumber) || block.pageNumber < 1 || block.pageNumber > document.countPages()) throw new Error('The text block references an invalid page.');
    const page = document.loadPage(block.pageNumber - 1);
    try {
      assertReplaceableTextRendering(engine, page, block.pageNumber);
      const existing = context?.edits.find(item => item.blockId === block.id);
      const replacement = edit ?? existing ?? { blockId: block.id, originalText: block.text, newText: block.text, timestamp: 0 };
      const originalText = existing?.originalText ?? replacement.originalText;
      const sourceBlock = { ...block, text: originalText };
      let prepared: PreparedBlock | undefined;
      if (context) {
        const pageBlocks = [...context.blocks.filter(item => item.pageNumber === block.pageNumber && item.id !== block.id), sourceBlock];
        const ids = new Set(pageBlocks.map(item => item.id));
        const pageEdits = context.edits.filter(item => item.blockId !== block.id && ids.has(item.blockId));
        if (replacement.newText !== originalText || (replacement.layout && Object.values(replacement.layout).some(value => value !== undefined))) pageEdits.push(replacement);
        prepared = preparePageTextEdits(engine, page, pageBlocks, pageEdits, session, control).find(item => item.block.id === block.id);
      }
      prepared ??= prepareBlock(engine, page, sourceBlock, replacement, session, control);
      return { input: prepared.input, layout: prepared.layout, page: prepared.page, availableRect: prepared.availableRect, fonts: prepared.fonts };
    } finally { page.destroy(); }
  } finally { session.destroy(); document.destroy(); }
}

/** Inspect all detected regions in one engine session, without writing PDF content. */
export async function inspectTextBlocks(data: ArrayBuffer, blocks: Map<number, TextBlock[]>, edits: TextEditOperation[], control: TextLayoutControl & { onPage?: (page: number) => void } = {}): Promise<TextCheckReport> {
  cancelled(control);
  const issues: TextCheckIssue[] = [];
  try { await assertTextEditSource(data, control.signal); }
  catch (error) {
    cancelled(control);
    return { checked: 0, issues: [{ kind: 'source', message: error instanceof Error ? error.message : String(error), blocking: edits.length > 0 }] };
  }
  const engine = await loadMuPDF(), document = new engine.PDFDocument(data), session = new TextLayoutSession(engine);
  const changes = new Map(edits.map(edit => [edit.blockId, edit]));
  let checked = 0;
  try {
    for (const [pageNumber, regions] of blocks) {
      cancelled(control);
      const page = document.loadPage(pageNumber - 1);
      try {
        try { assertReplaceableTextRendering(engine, page, pageNumber); }
        catch (error) {
          issues.push({ pageNumber, kind: 'unsupported', message: error instanceof Error ? error.message : String(error), blocking: regions.some(block => changes.has(block.id)) });
          continue;
        }
        let pagePlan: Map<string, PreparedBlock>;
        try {
          pagePlan = new Map(preparePageTextEdits(engine, page, regions, edits.filter(edit => regions.some(block => block.id === edit.blockId)), session, control, issues).map(item => [item.block.id, item]));
        } catch (error) {
          cancelled(control);
          issues.push({ pageNumber, kind: 'unsupported', message: error instanceof Error ? error.message : String(error), blocking: regions.some(block => changes.has(block.id)) });
          continue;
        }
        for (const block of regions) {
          cancelled(control); checked++;
          if (issues.some(issue => issue.blockId === block.id && issue.blocking)) continue;
          try {
            const prepared = pagePlan.get(block.id) ?? prepareBlock(engine, page, block, { blockId: block.id, originalText: block.text, newText: block.text, timestamp: 0 }, session, control);
            if (pagePlan.has(block.id) && !prepared.layout.fits) issues.push({ blockId: block.id, pageNumber, kind: 'overflow', message: prepared.layout.overflow!, blocking: true });
            for (const message of prepared.layout.warnings) issues.push({ blockId: block.id, pageNumber, kind: 'font', message, blocking: false });
          } catch (error) {
            cancelled(control);
            issues.push({ blockId: block.id, pageNumber, kind: 'unsupported', message: error instanceof Error ? error.message : String(error), blocking: pagePlan.has(block.id) });
          }
        }
      } finally { page.destroy(); control.onPage?.(pageNumber); }
    }
    return { checked, issues };
  } finally { session.destroy(); document.destroy(); }
}

function copyDictionary(document: PDFDocument, source: PDFObject): PDFObject {
  const copy = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => { try { copy.put(key, value); } finally { value.destroy(); } });
  return copy;
}

function addReplacementText(engine: Engine, document: PDFDocument, page: PDFPage, blocks: PreparedBlock[], session: TextLayoutSession) {
  const regions = blocks.flatMap(prepared => {
    const groups: typeof prepared.layout.lines[] = [];
    for (const line of prepared.layout.lines) {
      if (!groups.length || (prepared.input.reflow && groups.at(-1)!.at(-1)!.paragraphEnd)) groups.push([]);
      groups.at(-1)!.push(line);
    }
    return groups.filter(lines => lines.some(line => line.glyphs.length)).map((lines, regionIndex) => ({ ...prepared, regionIndex, layout: { ...prepared.layout, lines } }));
  });
  if (!regions.length) return;
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
    for (const prepared of regions) {
      const device = writer.beginPage([0, 0, width, height]);
      try { session.draw(device, prepared.input, prepared.layout); device.close(); }
      finally { device.destroy(); }
      writer.endPage();
    }
    writer.close();
    overlay = new engine.PDFDocument(output);
    // Finish source-dictionary mutations before a graft map fixes its source
    // object range. Later ToUnicode streams would otherwise exceed that range.
    const overlayResources = regions.map((_, index) => keep(keep(overlay!.findPage(index)).get('Resources')));
    for (const resources of overlayResources) session.preserveUnicode(overlay, resources, blocks.map(block => block.layout));
    const graft = keep(document.newGraftMap());
    const pageObject = keep(page.getObject());
    const oldResources = keep(pageObject.getInheritable('Resources'));
    const newResources = keep(copyDictionary(document, oldResources));
    const oldXObjects = oldResources.isDictionary() ? keep(oldResources.get('XObject')) : oldResources;
    const xObjects = keep(copyDictionary(document, oldXObjects));
    const draws: string[] = [];
    for (const [index, prepared] of regions.entries()) {
      const overlayPage = keep(overlay.findPage(index)), overlayContents = keep(overlayPage.get('Contents'));
      const content = keep(overlayContents.readStream()), marked = keep(new engine.Buffer());
      const tag = textRegionTag(prepared.block.kind ?? 'paragraph', prepared.block.id, prepared.regionIndex);
      marked.write(`/${tag} BMC\n`); marked.writeBuffer(content); marked.write('\nEMC\n');
      // Fonts can be shared by several regions. Every ToUnicode map must cover
      // their union, and a single graft map keeps large CJK programs shared.
      const resources = keep(graft.graftObject(overlayResources[index]));
      const form = keep(document.addStream(new Uint8Array(marked.asUint8Array()), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources }));
      let name = 'PDFEditorText', suffix = 0;
      while (true) { const existing = xObjects.get(name); try { if (existing.isNull()) break; name = `PDFEditorText${++suffix}`; } finally { existing.destroy(); } }
      xObjects.put(name, form); draws.push(`/${name} Do`);
    }
    newResources.put('XObject', xObjects);
    pageObject.put('Resources', newResources);

    // Keep the original page and widgets. Append a vector Form XObject in native
    // PDF space; /Rotate and /UserUnit continue to apply to both old and new text.
    const contents = keep(document.newArray());
    contents.push(keep(document.addStream('q\n', {})));
    const previous = keep(pageObject.get('Contents'));
    if (previous.isArray()) previous.forEach(value => { try { contents.push(value); } finally { value.destroy(); } });
    else if (!previous.isNull()) contents.push(previous);
    contents.push(keep(document.addStream(`Q\nq\n${1 / unit} 0 0 ${1 / unit} ${crop[0]} ${crop[1]} cm\n${draws.join('\n')}\nQ\n`, {})));
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
export async function previewInlineTextEdits(data: ArrayBuffer, blocks: Map<number, TextBlock[]>, edits: TextEditOperation[], rects?: Map<string, import('./types').TextRect>, layouts?: Map<string, PreparedTextEditLayout>): Promise<Uint8Array> {
  return writeTextEdits(data, blocks, edits, {}, true, rects, layouts);
}

async function writeTextEdits(data: ArrayBuffer, blocks: Map<number, TextBlock[]>, edits: TextEditOperation[], control: TextLayoutControl, preview: boolean, rects?: Map<string, import('./types').TextRect>, layouts?: Map<string, PreparedTextEditLayout>): Promise<Uint8Array> {
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
    const issues: TextCheckIssue[] = [];
    for (const [pageNumber, entries] of perPage) {
      cancelled(control);
      const page = document.loadPage(pageNumber - 1);
      try {
        assertReplaceableTextRendering(engine, page, pageNumber);
        const prepared = preparePageTextEdits(engine, page, blocks.get(pageNumber) ?? [], entries.map(entry => entry.edit), session, control, preview ? undefined : issues);
        for (const item of prepared) rects?.set(item.block.id, { ...item.input.rect });
        // Send glyph geometry, not the source block and its potentially large
        // imported font program, back from the preview worker on every key.
        for (const item of prepared) layouts?.set(item.block.id, { input: item.input, layout: item.layout, page: item.page, availableRect: item.availableRect, fonts: item.fonts });
        if (!preview) for (const item of prepared.filter(item => !item.layout.fits)) {
          issues.push({ blockId: item.block.id, pageNumber, kind: 'overflow', message: item.layout.overflow!, blocking: true });
        }
        preparedPages.set(pageNumber, prepared);
      } catch (error) {
        if (preview) throw error;
        cancelled(control);
        issues.push({ pageNumber, kind: 'unsupported', message: error instanceof Error ? error.message : String(error), blocking: true });
      } finally { page.destroy(); }
    }
    if (issues.length) throw new TextCheckError(issues);
    for (const pageNumber of perPage.keys()) {
      const page = document.loadPage(pageNumber - 1);
      try {
        cancelled(control);
        const prepared = preparedPages.get(pageNumber)!;
        for (const { block } of prepared) {
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
