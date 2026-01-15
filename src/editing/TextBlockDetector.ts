/**
 * Text Block Detection
 * Groups PDF text items into logical blocks and lines
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import type { TextItem, TextLine, TextBlock } from './types';

// Thresholds for grouping text
const LINE_SPACING_THRESHOLD = 1.5; // Items within this multiple of font height are same line
const BLOCK_SPACING_THRESHOLD = 2.0; // Lines within this multiple are same block
const WORD_SPACING_THRESHOLD = 0.3; // Items within this multiple of font width are same word

/**
 * Extract and group text from a PDF page into logical blocks
 */
export async function detectTextBlocks(page: PDFPageProxy): Promise<TextBlock[]> {
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const pageHeight = viewport.height;

  // Convert text content items to our TextItem format
  // PDF.js returns TextItem | TextMarkedContent, we only want TextItem (which has 'str')
  const items: TextItem[] = textContent.items
    .filter((item): item is import('pdfjs-dist/types/src/display/api').TextItem =>
      'str' in item && typeof (item as { str?: string }).str === 'string' && (item as { str: string }).str.trim() !== ''
    )
    .map((item) => {
      const tx = item.transform;
      // PDF coordinates have origin at bottom-left, convert to top-left
      const x = tx[4];
      const y = pageHeight - tx[5];
      const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
      const width = item.width ?? 0;
      const height = item.height ?? fontSize;

      return {
        str: item.str,
        x,
        y: y - height, // Adjust y to be top of text
        width,
        height,
        fontName: item.fontName ?? 'unknown',
        fontSize,
        transform: tx,
      };
    });

  if (items.length === 0) {
    return [];
  }

  // Sort items by y position (top to bottom), then x position (left to right)
  items.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > a.height * 0.5) {
      return yDiff;
    }
    return a.x - b.x;
  });

  // Group items into lines
  const lines = groupIntoLines(items);

  // Group lines into blocks
  const blocks = groupIntoBlocks(lines, page.pageNumber);

  return blocks;
}

/**
 * Group text items into lines based on y-position proximity
 */
function groupIntoLines(items: TextItem[]): TextLine[] {
  const lines: TextLine[] = [];
  let currentLine: TextItem[] = [];
  let currentLineY = -Infinity;
  let currentLineHeight = 0;

  for (const item of items) {
    // Check if this item is on the same line
    const issameLine =
      currentLine.length === 0 ||
      Math.abs(item.y - currentLineY) < currentLineHeight * LINE_SPACING_THRESHOLD;

    if (issameLine) {
      currentLine.push(item);
      if (currentLine.length === 1) {
        currentLineY = item.y;
        currentLineHeight = item.height;
      }
    } else {
      // Finish current line and start a new one
      if (currentLine.length > 0) {
        lines.push(createLine(currentLine));
      }
      currentLine = [item];
      currentLineY = item.y;
      currentLineHeight = item.height;
    }
  }

  // Don't forget the last line
  if (currentLine.length > 0) {
    lines.push(createLine(currentLine));
  }

  return lines;
}

/**
 * Create a TextLine from a list of items
 */
function createLine(items: TextItem[]): TextLine {
  // Sort items left to right
  items.sort((a, b) => a.x - b.x);

  // Combine text with appropriate spacing
  let text = '';
  let prevItem: TextItem | null = null;

  for (const item of items) {
    if (prevItem) {
      const gap = item.x - (prevItem.x + prevItem.width);
      const avgCharWidth = prevItem.width / Math.max(prevItem.str.length, 1);

      // Add space if there's a significant gap
      if (gap > avgCharWidth * WORD_SPACING_THRESHOLD) {
        text += ' ';
      }
    }
    text += item.str;
    prevItem = item;
  }

  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  const minY = Math.min(...items.map((i) => i.y));
  const maxY = Math.max(...items.map((i) => i.y + i.height));

  return {
    items,
    text: text.trim(),
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    baseline: items[0]?.y + items[0]?.height || minY,
  };
}

/**
 * Group lines into logical text blocks
 */
function groupIntoBlocks(lines: TextLine[], pageNumber: number): TextBlock[] {
  if (lines.length === 0) return [];

  const blocks: TextBlock[] = [];
  let currentBlockLines: TextLine[] = [];
  let blockIdCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevLine = currentBlockLines[currentBlockLines.length - 1];

    // Check if this line should be in the same block
    const isSameBlock =
      currentBlockLines.length === 0 ||
      (prevLine &&
        // Vertical proximity check
        line.y - (prevLine.y + prevLine.height) < prevLine.height * BLOCK_SPACING_THRESHOLD &&
        // Horizontal overlap check (lines should somewhat align)
        hasHorizontalOverlap(line, prevLine));

    if (isSameBlock) {
      currentBlockLines.push(line);
    } else {
      // Finish current block and start a new one
      if (currentBlockLines.length > 0) {
        blocks.push(createBlock(currentBlockLines, pageNumber, blockIdCounter++));
      }
      currentBlockLines = [line];
    }
  }

  // Don't forget the last block
  if (currentBlockLines.length > 0) {
    blocks.push(createBlock(currentBlockLines, pageNumber, blockIdCounter++));
  }

  return blocks;
}

/**
 * Check if two lines have horizontal overlap (for column detection)
 */
function hasHorizontalOverlap(line1: TextLine, line2: TextLine): boolean {
  const overlap =
    Math.min(line1.x + line1.width, line2.x + line2.width) - Math.max(line1.x, line2.x);
  const minWidth = Math.min(line1.width, line2.width);
  return overlap > minWidth * 0.3; // At least 30% overlap
}

/**
 * Create a TextBlock from a list of lines
 */
function createBlock(lines: TextLine[], pageNumber: number, id: number): TextBlock {
  const text = lines.map((l) => l.text).join('\n');

  const minX = Math.min(...lines.map((l) => l.x));
  const maxX = Math.max(...lines.map((l) => l.x + l.width));
  const minY = Math.min(...lines.map((l) => l.y));
  const maxY = Math.max(...lines.map((l) => l.y + l.height));

  // Determine dominant style from first line
  const firstItem = lines[0]?.items[0];
  const fontSize = firstItem?.fontSize || 12;
  const fontName = firstItem?.fontName || 'unknown';

  // Estimate alignment
  const alignment = estimateAlignment(lines);

  // Calculate line height
  const lineHeight =
    lines.length > 1
      ? (lines[1].y - lines[0].y) / fontSize
      : 1.2;

  return {
    id: `block-${pageNumber}-${id}`,
    pageNumber,
    lines,
    text,
    rect: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
    style: {
      fontName,
      fontSize,
      alignment,
      lineHeight,
    },
    editable: true,
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
