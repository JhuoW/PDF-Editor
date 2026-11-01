/**
 * Text Block Detection
 * Groups PDF text items into logical blocks and lines
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode, OPS } from 'pdfjs-dist';
import type { TextItem, TextLine, TextBlock } from './types';
import { CLIPPING_TEXT_EDIT_REASON, INVISIBLE_TEXT_EDIT_REASON, TYPE3_TEXT_EDIT_REASON, UNMAPPED_TEXT_EDIT_REASON } from './types';
import { decorationInstanceFromTag } from '../core/PageDecorationMarkers';
import { textRegionFromTag, textRegionLeading, textRegionSource } from './TextRegionMarkers';

const WORD_SPACING_THRESHOLD = 0.3;
const COMPLEX_REGION_REASON = 'Some text regions contain superscripts, overlapping glyphs, or rotated text that cannot be safely reflowed. Ordinary text blocks can still be edited.';

// Keep the original PDF font identity for grouping. Different embedded fonts can
// all report the same generic CSS family (for example Computer Modern in papers).
interface DetectedItem extends TextItem { fontKey: string; rotated: boolean; region?: string; unsupportedType3?: boolean }
interface DetectedLine extends TextLine {
  items: DetectedItem[];
  fontKey: string;
  fontSize: number;
  /** The prose size, distinct from one larger inline word's layout footprint. */
  bodyFontSize: number;
  complex: boolean;
  mixedFonts: boolean;
  region?: string;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Text extraction includes OCR glyphs that were never painted on the page. */
export async function getTextEditingRestriction(page: PDFPageProxy): Promise<string | null> {
  const operators = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  let renderingMode = 0;
  const stack: number[] = [];
  const containsGlyph = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsGlyph);
    if (typeof value === 'string') return value.trim().length > 0;
    return !!value && typeof value === 'object' && 'unicode' in value
      && typeof value.unicode === 'string' && value.unicode.trim().length > 0;
  };
  for (const [index, operator] of operators.fnArray.entries()) {
    const args = operators.argsArray[index];
    if (operator === OPS.save || operator === OPS.paintFormXObjectBegin || operator === OPS.beginGroup) stack.push(renderingMode);
    else if (operator === OPS.restore || operator === OPS.paintFormXObjectEnd || operator === OPS.endGroup) renderingMode = stack.pop() ?? 0;
    else if (operator === OPS.setTextRenderingMode) renderingMode = args[0];
    else if (renderingMode >= 3 && renderingMode <= 7
      && [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(operator)
      && containsGlyph(args)) return renderingMode === 3 ? INVISIBLE_TEXT_EDIT_REASON : CLIPPING_TEXT_EDIT_REASON;
  }
  return null;
}

/**
 * Extract and group text from a PDF page into logical blocks
 */
export async function detectTextBlocks(page: PDFPageProxy, kind: 'paragraph' | 'line' = 'paragraph'): Promise<TextBlock[]> {
  const [textContent, restriction] = await Promise.all([page.getTextContent({ includeMarkedContent: true }), getTextEditingRestriction(page)]);
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const unit = page.userUnit || 1;

  // Convert text content items to our TextItem format
  // PDF.js returns TextItem | TextMarkedContent, we only want TextItem (which has 'str')
  const markedContent: { decoration: boolean; region?: string }[] = [], regions = new Map<object, string>();
  let items: DetectedItem[] = textContent.items
    .filter((item): item is import('pdfjs-dist/types/src/display/api').TextItem => {
      if ('type' in item) {
        if (item.type === 'endMarkedContent') markedContent.pop();
        else if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
          const tag = 'tag' in item ? item.tag : undefined;
          markedContent.push({ decoration: decorationInstanceFromTag(tag) !== undefined, region: textRegionFromTag(tag) });
        }
        return false;
      }
      // Keep batch-created page marks separate from original-body text. Their
      // templates and numbering must be changed in the decorations dialog.
      const region = [...markedContent].reverse().find(entry => entry.region)?.region;
      if (region) regions.set(item, region);
      return !markedContent.some(entry => entry.decoration) && typeof item.str === 'string' && item.str.trim() !== '';
    })
    .map((item) => {
      const tx = item.transform;
      // The viewport includes CropBox offsets and /UserUnit. Store all editing
      // coordinates in this unrotated, scale=1 viewport consistently.
      const [x, y] = viewport.convertToViewportPoint(tx[4], tx[5]);
      // Tz changes horizontal scale, not point size. Using the first column
      // turns a 12pt, 175%-wide font into 21pt and makes a 44pt region need 53pt.
      const fontSize = Math.hypot(tx[2], tx[3]) * unit;
      const width = (item.width ?? 0) * unit;
      const height = item.height ? item.height * unit : fontSize;
      const resolvedFont = page.commonObjs?.has(item.fontName) ? page.commonObjs.get(item.fontName) as {
        name?: string; isType3Font?: boolean; charProcOperatorList?: Record<string, { fnArray: number[] }>;
      } : undefined;
      const fontName = typeof resolvedFont?.name === 'string' ? resolvedFont.name : undefined;
      const programs = Object.values(resolvedFont?.charProcOperatorList ?? {});
      // d1 glyphs are monochrome masks. A painted d0 glyph can contain arbitrary
      // colored artwork whose ownership/outer paint cannot be recovered safely.
      // An empty d0 space is harmless and must not lock an otherwise ordinary font.
      const unsupportedType3 = resolvedFont?.isType3Font && (!programs.length || programs.some(program =>
        program.fnArray.includes(OPS.setCharWidth) && program.fnArray.some(operator =>
          ![OPS.setCharWidth, OPS.save, OPS.restore].includes(operator))));

      return {
        str: item.str,
        x,
        y: y - height, // Adjust y to be top of text
        width,
        height,
        fontName: fontName ?? textContent.styles[item.fontName]?.fontFamily ?? item.fontName ?? 'unknown',
        // PDF producers may allocate a new subset/resource for each row.
        // Compare real face names when available, including weight and style.
        fontKey: fontName?.replace(/^[A-Z]{6}\+/, '') ?? item.fontName ?? 'unknown',
        region: regions.get(item),
        rotated: !!textContent.styles[item.fontName]?.vertical || Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] < 0,
        unsupportedType3,
        fontSize,
        transform: tx,
      };
    });

  if (items.length === 0) {
    return [];
  }

  // Render mode 2 written as a fill plus a stroke paints identical items twice;
  // that is one source glyph run and must not lock the row as overlapping text.
  const painted = new Set<string>();
  items = items.filter(item => {
    const key = `${item.str}|${item.x.toFixed(2)}|${item.y.toFixed(2)}|${item.fontKey}`;
    if (painted.has(key)) return false;
    painted.add(key); return true;
  });

  // Sort by baseline, never by approximate top bounds. Sorting by top can put
  // smaller fragments of the same physical line into another reading row.
  items.sort((a, b) => (a.y + a.height) - (b.y + b.height) || a.x - b.x);

  // Group items into lines
  const lines = groupIntoLines(items);

  // Group lines into blocks
  const paragraphs = groupIntoBlocks(lines, page.pageNumber);
  const leading = new Map(paragraphs.flatMap(paragraph => paragraph.lines.map(line => [line, paragraph.style.lineHeight] as const)));
  const blocks = kind === 'line' ? lines.map(line => {
    const block = createBlock([line], page.pageNumber);
    block.style.lineHeight = leading.get(line) ?? block.style.lineHeight;
    return block;
  }) : paragraphs;
  for (const block of blocks) {
    block.kind = kind;
    if (block.lines.some(line => line.items.some(item => (item as DetectedItem).unsupportedType3))) {
      block.editable = false;
      block.unsupportedReason = TYPE3_TEXT_EDIT_REASON;
    }
    // Fonts without Unicode data extract as raw codes: the letters shown are not what is
    // painted (a space often reads as U+0003), so accepting an edit would change the words.
    if (block.editable && Array.from(block.text).some(character => (character.codePointAt(0)! < 32 && !'\n\t'.includes(character)) || character.codePointAt(0) === 127)) {
      block.editable = false;
      block.unsupportedReason = UNMAPPED_TEXT_EDIT_REASON;
    }
  }

  // Mixed visible/invisible items can be grouped into one block. Conservatively
  // lock the page: changing OCR glyphs would leave the scanned image underneath.
  if (restriction) for (const block of blocks) {
    block.editable = false;
    block.unsupportedReason = restriction;
  }

  return blocks;
}

/** Cluster physical baselines first, then separate distant columns on each row. */
function groupIntoLines(items: DetectedItem[]): DetectedLine[] {
  const rows: Array<{ items: DetectedItem[]; baseline: number; size: number }> = [];
  const lines: DetectedLine[] = [];
  for (const item of items) {
    // A rotated margin label has no horizontal baseline or width. Clustering it
    // with body text can swallow several ordinary rows into a read-only region
    // (for example the arXiv stamp beside a paper's abstract).
    if (item.rotated) { lines.push(createLine([item])); continue; }
    const baseline = item.y + item.height;
    // Adjacent body lines are normally only 1.2 font sizes apart. They must not
    // share a row. Small superscripts/subscripts may overlap their main row, but
    // the resulting complex region will be protected from replacement.
    const row = rows.at(-1);
    const difference = row ? Math.abs(baseline - row.baseline) : Infinity;
    const sameBaseline = row && difference <= Math.max(0.75, Math.min(row.size, item.fontSize) * 0.2);
    const script = row && Math.min(row.size, item.fontSize) < Math.max(row.size, item.fontSize) * 0.85
      && difference <= Math.max(row.size, item.fontSize) * 0.65;
    if (row && (sameBaseline || script)) {
      row.items.push(item);
      if (item.fontSize > row.size) { row.size = item.fontSize; row.baseline = baseline; }
    } else rows.push({ items: [item], baseline, size: item.fontSize });
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let segment: DetectedItem[] = [], right = -Infinity;
    for (const item of row.items) {
      const gap = item.x - right;
      const previous = segment.at(-1);
      // Small chart ticks beside a body column are not inline emphasis or
      // superscripts. A gap plus a strong size change separates these objects
      // even when their baselines happen to fall in the same row cluster.
      const separateSize = previous && Math.min(previous.fontSize, item.fontSize) < Math.max(previous.fontSize, item.fontSize) * .6
        && gap > Math.max(previous.fontSize, item.fontSize) * .75;
      if (segment.length && (gap > Math.max(12, row.size * 1.8) || separateSize || segment[0].region !== item.region)) {
        lines.push(createLine(segment)); segment = [];
      }
      segment.push(item); right = Math.max(segment.length === 1 ? -Infinity : right, item.x + item.width);
    }
    if (segment.length) lines.push(createLine(segment));
  }
  return lines.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
}

function createLine(items: DetectedItem[]): DetectedLine {
  let text = '';
  let previous: DetectedItem | null = null;
  let overlapping = false;
  const size = Math.max(...items.map(item => item.fontSize));
  const sizeWeights = new Map<number, number>();
  for (const item of items) {
    const key = Math.round(item.fontSize * 100) / 100;
    sizeWeights.set(key, (sizeWeights.get(key) ?? 0) + Array.from(item.str.replace(/\s/gu, '')).length);
  }
  const bodyFontSize = [...sizeWeights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? size;
  const mainItems = items.filter(item => item.fontSize >= size * 0.85);
  const baseline = median(mainItems.map(item => item.y + item.height));
  for (const item of items) {
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const avgCharWidth = previous.width / Math.max(previous.str.length, 1);
      if (gap > avgCharWidth * WORD_SPACING_THRESHOLD && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
      if (gap < -Math.max(1.5, size * 0.2)) overlapping = true;
    }
    text += item.str; previous = item;
  }
  const minX = Math.min(...items.map(item => item.x));
  const maxX = Math.max(...items.map(item => item.x + item.width));
  const minY = Math.min(...items.map(item => item.y));
  const maxY = Math.max(...items.map(item => item.y + item.height));
  const fonts = [...new Set(items.map(item => item.fontKey))].sort();
  return {
    items, text: text.trim(), x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    baseline, fontKey: fonts.join('|'), fontSize: size, bodyFontSize, mixedFonts: fonts.length > 1, region: items[0].region,
    complex: overlapping || items.some(item => item.rotated || Math.abs(item.y + item.height - baseline) > Math.max(0.75, size * 0.2)),
  };
}

/** Build paragraphs within a column, without joining headings, other fonts, or page numbers. */
function groupIntoBlocks(lines: DetectedLine[], pageNumber: number): TextBlock[] {
  const groups: DetectedLine[][] = [];
  const active: DetectedLine[][] = [];
  const leading: number[] = [];
  for (const [index, line] of lines.entries()) {
    const size = line.bodyFontSize;
    for (let next = index + 1; next < lines.length && lines[next].baseline <= line.baseline + size * 1.7; next++) {
      const candidate = lines[next];
      if (candidate.baseline > line.baseline + size * .5 && Math.abs(candidate.x - line.x) < size * .65
        && Math.abs(candidate.bodyFontSize - size) < .1 && candidate.items.some(item => line.items.some(prior => prior.fontKey === item.fontKey))) {
        leading.push((candidate.baseline - line.baseline) / size); break;
      }
    }
  }
  const usualLeading = leading.length ? median(leading) : undefined;
  for (const line of lines) {
    const size = line.bodyFontSize;
    let best: DetectedLine[] | undefined;
    let nearest = Infinity;
    for (let index = active.length - 1; index >= 0; index--) {
      const group = active[index];
      const previous = group[group.length - 1];
      const gap = line.baseline - previous.baseline;
      if (line.region && line.region === previous.region && !line.complex && !previous.complex && gap > 0 && gap < nearest) {
        best = group; nearest = gap; continue;
      }
      // A distant paragraph can never match a later line. Avoid rescanning all
      // prior blocks on pages with many columns, labels, or style changes.
      if (gap > previous.bodyFontSize * 1.8) { active.splice(index, 1); continue; }
      if (line.region !== previous.region) continue;
      if (gap >= nearest || gap <= size * 0.5 || gap > size * 1.7) continue;
      if (group.length === 1 && usualLeading && gap > usualLeading * size * 1.2) continue;
      if (line.complex || previous.complex) continue;
      // Inline emphasis and Chinese/Latin fallback runs belong to the same
      // paragraph. Font changes within a row must not turn it into an isolated
      // editing area. A distinct heading font still starts a separate block.
      if (!line.items.some(item => previous.items.some(prior => prior.fontKey === item.fontKey))
        || Math.abs(size - previous.bodyFontSize) > Math.max(0.1, size * 0.03)) continue;
      const overlap = Math.min(line.x + line.width, previous.x + previous.width) - Math.max(line.x, previous.x);
      if (overlap <= Math.min(line.width, previous.width) * 0.3) continue;
      const left = Math.min(...group.map(part => part.x));
      const right = Math.max(...group.map(part => part.x + part.width));
      // A wrap column beside a figure must not become a page-wide region when
      // text continues below the figure. Likewise, a short fragment after an
      // equation does not own the blank space occupied by that equation.
      if (group.length > 1 && line.x + line.width > right + Math.max(size * 2, (right - left) * .25)) continue;
      if (group.length === 1 && previous.x - line.x > size * 3 && previous.width < line.width * .6) continue;
      const centered = Math.abs(line.x + line.width / 2 - previous.x - previous.width / 2) < size * 0.25;
      // An indented first line starts a new paragraph even when leading is unchanged.
      if (line.x - left > size * 0.65 && !centered) continue;
      // A larger-than-usual baseline gap also marks a paragraph boundary.
      if (group.length > 1) {
        const leading = median(group.slice(1).map((part, index) => part.baseline - group[index].baseline));
        if (gap > leading * 1.2) continue;
      }
      best = group; nearest = gap;
    }
    if (best) best.push(line);
    else { const group = [line]; groups.push(group); active.push(group); }
  }
  return groups.map(group => createBlock(group, pageNumber)).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

function createBlock(lines: DetectedLine[], pageNumber: number): TextBlock {
  const minX = Math.min(...lines.map(line => line.x));
  const maxX = Math.max(...lines.map(line => line.x + line.width));
  const minY = Math.min(...lines.map(line => line.y));
  const maxY = Math.max(...lines.map(line => line.y + line.height));
  const fontSize = lines[0].fontSize;
  const fontName = lines[0].items.find(item => item.fontSize === fontSize)?.fontName ?? 'unknown';
  const nominalLeading = textRegionLeading(lines[0].region);
  const lineHeight = nominalLeading !== undefined ? nominalLeading / fontSize : lines.length > 1
    ? median(lines.slice(1).map((line, index) => line.baseline - lines[index].baseline)) / fontSize
    : 1.2;
  const complex = lines.some(line => line.complex);
  return {
    // Never reuse a block ID across fresh detection after page organization.
    id: `block-${crypto.randomUUID()}`, pageNumber, lines,
    ...(lines[0].region ? { region: textRegionSource(lines[0].region) } : {}),
    text: lines.map(line => line.text).join('\n'),
    rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    style: { fontName, fontSize, alignment: estimateAlignment(lines), lineHeight },
    editable: !complex,
    ...(complex ? { unsupportedReason: COMPLEX_REGION_REASON } : {}),
  };
}

/**
 * Estimate text alignment from line positions
 */
function estimateAlignment(lines: TextLine[]): 'left' | 'center' | 'right' | 'justify' {
  if (lines.length < 2) return 'left';

  const leftPositions = lines.map((l) => l.x);
  const rightPositions = lines.map((l) => l.x + l.width);
  const centerPositions = lines.map((l) => l.x + l.width / 2);

  const leftVariance = calculateVariance(leftPositions);
  const rightVariance = calculateVariance(rightPositions);
  const centerVariance = calculateVariance(centerPositions);

  // Justified paragraphs usually end with a shorter, left-aligned final row.
  // Check their full rows first; checking the left edge first made this branch
  // unreachable and changed justified text to ragged-right after editing.
  if (lines.length >= 3 && leftVariance < 5 && calculateVariance(rightPositions.slice(0, -1)) < 1) return 'justify';

  // Low variance means consistent alignment
  const minVariance = Math.min(leftVariance, rightVariance, centerVariance);

  if (minVariance === leftVariance && leftVariance < 5) return 'left';
  if (minVariance === rightVariance && rightVariance < 5) return 'right';
  if (minVariance === centerVariance && centerVariance < 5) return 'center';

  return 'left';
}

/**
 * Calculate variance of a number array
 */
function calculateVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Find text block at a given point
 */
export function findBlockAtPoint(
  blocks: TextBlock[],
  x: number,
  y: number
): TextBlock | null {
  for (const block of blocks) {
    const { rect } = block;
    if (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    ) {
      return block;
    }
  }
  return null;
}

/**
 * Merge adjacent blocks that likely belong together
 */
export function mergeRelatedBlocks(blocks: TextBlock[]): TextBlock[] {
  // This is a simplified implementation
  // A full implementation would analyze fonts, columns, and layout
  return blocks;
}
