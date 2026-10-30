/**
 * Text Block Detection
 * Groups PDF text items into logical blocks and lines
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import { AnnotationMode, OPS } from 'pdfjs-dist';
import type { TextItem, TextLine, TextBlock } from './types';
import { CLIPPING_TEXT_EDIT_REASON, INVISIBLE_TEXT_EDIT_REASON } from './types';
import { decorationInstanceFromTag } from '../core/PageDecorationMarkers';

const WORD_SPACING_THRESHOLD = 0.3;
const COMPLEX_REGION_REASON = 'Some text regions contain superscripts, overlapping glyphs, or rotated text that cannot be safely reflowed. Ordinary text blocks can still be edited.';

// Keep the original PDF font identity for grouping. Different embedded fonts can
// all report the same generic CSS family (for example Computer Modern in papers).
interface DetectedItem extends TextItem { fontKey: string; rotated: boolean }
interface DetectedLine extends TextLine {
  items: DetectedItem[];
  fontKey: string;
  fontSize: number;
  complex: boolean;
  mixedFonts: boolean;
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
export async function detectTextBlocks(page: PDFPageProxy): Promise<TextBlock[]> {
  const [textContent, restriction] = await Promise.all([page.getTextContent({ includeMarkedContent: true }), getTextEditingRestriction(page)]);
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const unit = page.userUnit || 1;

  // Convert text content items to our TextItem format
  // PDF.js returns TextItem | TextMarkedContent, we only want TextItem (which has 'str')
  const markedContent: boolean[] = [];
  const items: DetectedItem[] = textContent.items
    .filter((item): item is import('pdfjs-dist/types/src/display/api').TextItem => {
      if ('type' in item) {
        if (item.type === 'endMarkedContent') markedContent.pop();
        else if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
          markedContent.push(decorationInstanceFromTag('tag' in item ? item.tag : undefined) !== undefined);
        }
        return false;
      }
      // Keep batch-created page marks separate from original-body text. Their
      // templates and numbering must be changed in the decorations dialog.
      return !markedContent.some(Boolean) && typeof item.str === 'string' && item.str.trim() !== '';
    })
    .map((item) => {
      const tx = item.transform;
      // The viewport includes CropBox offsets and /UserUnit. Store all editing
      // coordinates in this unrotated, scale=1 viewport consistently.
      const [x, y] = viewport.convertToViewportPoint(tx[4], tx[5]);
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * unit;
      const width = (item.width ?? 0) * unit;
      const height = item.height ? item.height * unit : fontSize;

      return {
        str: item.str,
        x,
        y: y - height, // Adjust y to be top of text
        width,
        height,
        fontName: textContent.styles[item.fontName]?.fontFamily ?? item.fontName ?? 'unknown',
        fontKey: item.fontName ?? 'unknown',
        rotated: !!textContent.styles[item.fontName]?.vertical || Math.abs(tx[1]) > 0.01 || Math.abs(tx[2]) > 0.01 || tx[0] < 0,
        fontSize,
        transform: tx,
      };
    });

  if (items.length === 0) {
    return [];
  }

  // Sort by baseline, never by approximate top bounds. Sorting by top can put
  // smaller fragments of the same physical line into another reading row.
  items.sort((a, b) => (a.y + a.height) - (b.y + b.height) || a.x - b.x);

  // Group items into lines
  const lines = groupIntoLines(items);

  // Group lines into blocks
  const blocks = groupIntoBlocks(lines, page.pageNumber);

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
  for (const item of items) {
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

  const lines: DetectedLine[] = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let segment: DetectedItem[] = [], right = -Infinity;
    for (const item of row.items) {
      const gap = item.x - right;
      if (segment.length && gap > Math.max(12, row.size * 1.8)) {
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
    baseline, fontKey: fonts.join('|'), fontSize: size, mixedFonts: fonts.length > 1,
    complex: overlapping || items.some(item => item.rotated || Math.abs(item.y + item.height - baseline) > Math.max(0.75, size * 0.2)),
  };
}

/** Build paragraphs within a column, without joining headings, other fonts, or page numbers. */
function groupIntoBlocks(lines: DetectedLine[], pageNumber: number): TextBlock[] {
  const groups: DetectedLine[][] = [];
  const active: DetectedLine[][] = [];
  for (const line of lines) {
    let best: DetectedLine[] | undefined;
    let nearest = Infinity;
    for (let index = active.length - 1; index >= 0; index--) {
      const group = active[index];
      const previous = group[group.length - 1];
      const gap = line.baseline - previous.baseline;
      // A distant paragraph can never match a later line. Avoid rescanning all
      // prior blocks on pages with many columns, labels, or style changes.
      if (gap > previous.fontSize * 1.8) { active.splice(index, 1); continue; }
      if (gap >= nearest || gap <= line.fontSize * 0.5 || gap > line.fontSize * 1.7) continue;
      if (line.complex || previous.complex || line.mixedFonts || previous.mixedFonts) continue;
      if (line.fontKey !== previous.fontKey || Math.abs(line.fontSize - previous.fontSize) > Math.max(0.1, line.fontSize * 0.03)) continue;
      const overlap = Math.min(line.x + line.width, previous.x + previous.width) - Math.max(line.x, previous.x);
      if (overlap <= Math.min(line.width, previous.width) * 0.3) continue;
      const left = Math.min(...group.map(part => part.x));
      const centered = Math.abs(line.x + line.width / 2 - previous.x - previous.width / 2) < line.fontSize * 0.25;
      // An indented first line starts a new paragraph even when leading is unchanged.
      if (line.x - left > line.fontSize * 0.65 && !centered) continue;
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
  const lineHeight = lines.length > 1
    ? median(lines.slice(1).map((line, index) => line.baseline - lines[index].baseline)) / fontSize
    : 1.2;
  const complex = lines.some(line => line.complex);
  return {
    // Never reuse a block ID across fresh detection after page organization.
    id: `block-${crypto.randomUUID()}`, pageNumber, lines,
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

  // Low variance means consistent alignment
  const minVariance = Math.min(leftVariance, rightVariance, centerVariance);

  if (minVariance === leftVariance && leftVariance < 5) return 'left';
  if (minVariance === rightVariance && rightVariance < 5) return 'right';
  if (minVariance === centerVariance && centerVariance < 5) return 'center';

  // If both left and right are aligned, it's justified
  if (leftVariance < 5 && rightVariance < 5) return 'justify';

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
