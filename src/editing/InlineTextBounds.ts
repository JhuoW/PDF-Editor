import type { TextBlock, TextRect } from './types';
import type { PDFPage } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import { belongsToTextBlock, readTextPageContent, type TextPageContent } from './TextPageContent';

/** Read painted content so automatic growth also respects images and vectors. */
export function readInlineTextObstacles(engine: Awaited<ReturnType<typeof loadMuPDF>>, page: PDFPage, sources: TextBlock[], content = readTextPageContent(engine, page)): TextRect[] {
  return [...content.glyphs.filter(glyph => !sources.some(block => belongsToTextBlock(glyph, block))).map(glyph => glyph.rect), ...content.artwork];
}

export function readInlineTextBounds(engine: Awaited<ReturnType<typeof loadMuPDF>>, page: PDFPage, block: TextBlock, width: number, height: number, targetRect?: TextRect, growWidth = false, content?: TextPageContent): TextRect {
  const obstacles = readInlineTextObstacles(engine, page, [block], content);
  // The source glyphs will be removed from block.rect, but growth after a move
  // must be measured around the destination rather than the old paragraph.
  const destination = targetRect ? { ...block, rect: targetRect } : block;
  return inlineAvailableRect(growWidth ? { ...destination, lines: destination.lines.slice(0, 1) } : destination, [block], width, height, obstacles);
}

/** Grow only into clear space; retain the original source removal rectangle. */
export function inlineAvailableRect(block: TextBlock, blocks: TextBlock[], width: number, height: number, artwork: TextRect[] = []): TextRect {
  const source = block.rect, gap = Math.min(4, block.style.fontSize * .25);
  const obstacles = [...blocks.filter(item => item.id !== block.id).map(item => item.rect), ...artwork];
  // Preserve paragraph widths and centered/right-aligned text. A single left-
  // aligned line can use clear space on its right before wrapping.
  let right = block.lines.length === 1 && block.style.alignment === 'left' ? width - Math.min(source.x, 24) : source.x + source.width;
  for (const rect of obstacles) {
    if (rect.x >= source.x + source.width - .1 && rect.y < source.y + source.height && rect.y + rect.height > source.y) right = Math.min(right, rect.x - gap);
  }
  right = Math.max(source.x + source.width, right);
  let bottom = height - Math.min(source.y, 24);
  for (const rect of obstacles) {
    if (rect.y >= source.y + source.height - .1 && rect.x < right && rect.x + rect.width > source.x) bottom = Math.min(bottom, rect.y - gap);
  }
  return { ...source, width: right - source.x, height: Math.max(source.height, bottom - source.y) };
}
