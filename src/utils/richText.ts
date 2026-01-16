/**
 * Rich Text Utilities for Microsoft Word/PowerPoint style text formatting
 *
 * This module provides functions for manipulating text segments with individual formatting,
 * allowing per-character/per-selection formatting like Word/PowerPoint.
 */

import type { TextStyle, RichTextSegment } from '../annotations/types';
import { DEFAULT_TEXT_STYLE } from '../annotations/types';

/**
 * Selection state within rich text
 */
export interface SelectionState {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

/**
 * Result of getting selection style - includes common properties and which are mixed
 */
export interface SelectionStyleResult {
  style: Partial<TextStyle>;
  isMixed: {
    fontFamily: boolean;
    fontSize: boolean;
    fontWeight: boolean;
    fontStyle: boolean;
    textDecoration: boolean;
    color: boolean;
  };
}

/**
 * Pending format to apply to next typed characters
 */
export type PendingFormat = Partial<TextStyle>;

/**
 * Get the total character count across all segments
 */
export function getTotalLength(segments: RichTextSegment[]): number {
  return segments.reduce((sum, seg) => sum + seg.text.length, 0);
}

/**
 * Get the flattened plain text from segments
 */
export function getPlainText(segments: RichTextSegment[]): string {
  return segments.map(seg => seg.text).join('');
}

/**
 * Convert plain text content to segments (for migration from old format)
 */
export function textToSegments(text: string, style: TextStyle): RichTextSegment[] {
  if (!text) return [];
  return [{ text, style: { ...style } }];
}

/**
 * Get the style at a specific character position
 */
export function getStyleAtPosition(segments: RichTextSegment[], position: number): TextStyle {
  if (segments.length === 0) return { ...DEFAULT_TEXT_STYLE };

  let charIndex = 0;
  for (const segment of segments) {
    const segmentEnd = charIndex + segment.text.length;
    if (position >= charIndex && position < segmentEnd) {
      return { ...DEFAULT_TEXT_STYLE, ...segment.style };
    }
    charIndex = segmentEnd;
  }

  // If position is at the end, return the last segment's style
  if (segments.length > 0) {
    return { ...DEFAULT_TEXT_STYLE, ...segments[segments.length - 1].style };
  }

  return { ...DEFAULT_TEXT_STYLE };
}

/**
 * Get the segment index and offset within segment for a character position
 */
export function getSegmentAtPosition(
  segments: RichTextSegment[],
  position: number
): { segmentIndex: number; offset: number } | null {
  let charIndex = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const segmentEnd = charIndex + segment.text.length;

    if (position >= charIndex && position <= segmentEnd) {
      return { segmentIndex: i, offset: position - charIndex };
    }
    charIndex = segmentEnd;
  }

  return null;
}

/**
 * Check if two styles are equal
 */
export function stylesEqual(a: Partial<TextStyle>, b: Partial<TextStyle>): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.textDecoration === b.textDecoration &&
    a.color === b.color &&
    a.textAlign === b.textAlign &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing
  );
}

/**
 * Normalize segments - merge adjacent segments with identical styles
 */
export function normalizeSegments(segments: RichTextSegment[]): RichTextSegment[] {
  if (segments.length === 0) return [];

  const result: RichTextSegment[] = [];

  for (const segment of segments) {
    // Skip empty segments
    if (!segment.text) continue;

    const lastSegment = result[result.length - 1];

    // Merge with previous if styles match
    if (lastSegment && stylesEqual(lastSegment.style, segment.style)) {
      lastSegment.text += segment.text;
    } else {
      result.push({ text: segment.text, style: { ...segment.style } });
    }
  }

  return result;
}

/**
 * Get the combined style of a selection (for toolbar display)
 */
export function getSelectionStyle(
  segments: RichTextSegment[],
  start: number,
  end: number
): SelectionStyleResult {
  if (segments.length === 0 || start === end) {
    const style = getStyleAtPosition(segments, start);
    return {
      style,
      isMixed: {
        fontFamily: false,
        fontSize: false,
        fontWeight: false,
        fontStyle: false,
        textDecoration: false,
        color: false,
      },
    };
  }

  // Ensure start < end
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  // Collect all styles in the selection
  const stylesInSelection: Partial<TextStyle>[] = [];
  let charIndex = 0;

  for (const segment of segments) {
    const segmentStart = charIndex;
    const segmentEnd = charIndex + segment.text.length;

    // Check if segment overlaps with selection
    if (segmentEnd > selStart && segmentStart < selEnd) {
      stylesInSelection.push(segment.style);
    }

    charIndex = segmentEnd;
    if (charIndex >= selEnd) break;
  }

  if (stylesInSelection.length === 0) {
    return {
      style: { ...DEFAULT_TEXT_STYLE },
      isMixed: {
        fontFamily: false,
        fontSize: false,
        fontWeight: false,
        fontStyle: false,
        textDecoration: false,
        color: false,
      },
    };
  }

  // Check which properties are mixed
  const first = stylesInSelection[0];
  const isMixed = {
    fontFamily: false,
    fontSize: false,
    fontWeight: false,
    fontStyle: false,
    textDecoration: false,
    color: false,
  };

  for (let i = 1; i < stylesInSelection.length; i++) {
    const style = stylesInSelection[i];
    if (style.fontFamily !== first.fontFamily) isMixed.fontFamily = true;
    if (style.fontSize !== first.fontSize) isMixed.fontSize = true;
    if (style.fontWeight !== first.fontWeight) isMixed.fontWeight = true;
    if (style.fontStyle !== first.fontStyle) isMixed.fontStyle = true;
    if (style.textDecoration !== first.textDecoration) isMixed.textDecoration = true;
    if (style.color !== first.color) isMixed.color = true;
  }

  // Return the first style merged with defaults, with mixed indicators
  return {
    style: { ...DEFAULT_TEXT_STYLE, ...first },
    isMixed,
  };
}

/**
 * Apply style changes to a range of text
 */
export function applyStyleToRange(
  segments: RichTextSegment[],
  start: number,
  end: number,
  styleChanges: Partial<TextStyle>
): RichTextSegment[] {
  if (segments.length === 0 || start === end) return segments;

  // Ensure start < end
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  const result: RichTextSegment[] = [];
  let charIndex = 0;

  for (const segment of segments) {
    const segmentStart = charIndex;
    const segmentEnd = charIndex + segment.text.length;

    // Segment is completely before selection
    if (segmentEnd <= selStart) {
      result.push({ text: segment.text, style: { ...segment.style } });
    }
    // Segment is completely after selection
    else if (segmentStart >= selEnd) {
      result.push({ text: segment.text, style: { ...segment.style } });
    }
    // Segment overlaps with selection
    else {
      // Part before selection
      if (segmentStart < selStart) {
        const beforeText = segment.text.slice(0, selStart - segmentStart);
        result.push({ text: beforeText, style: { ...segment.style } });
      }

      // Selected part (with style changes)
      const selectedStart = Math.max(0, selStart - segmentStart);
      const selectedEnd = Math.min(segment.text.length, selEnd - segmentStart);
      const selectedText = segment.text.slice(selectedStart, selectedEnd);

      if (selectedText) {
        result.push({
          text: selectedText,
          style: { ...segment.style, ...styleChanges },
        });
      }

      // Part after selection
      if (segmentEnd > selEnd) {
        const afterText = segment.text.slice(selEnd - segmentStart);
        result.push({ text: afterText, style: { ...segment.style } });
      }
    }

    charIndex = segmentEnd;
  }

  return normalizeSegments(result);
}

/**
 * Insert text at a position with a specific style
 */
export function insertTextAtPosition(
  segments: RichTextSegment[],
  position: number,
  text: string,
  style: TextStyle
): RichTextSegment[] {
  if (!text) return segments;

  // Empty segments - just create new one
  if (segments.length === 0) {
    return [{ text, style: { ...style } }];
  }

  const result: RichTextSegment[] = [];
  let charIndex = 0;
  let inserted = false;

  for (const segment of segments) {
    const segmentStart = charIndex;
    const segmentEnd = charIndex + segment.text.length;

    // Insert point is within this segment
    if (!inserted && position >= segmentStart && position <= segmentEnd) {
      const offset = position - segmentStart;

      // Part before insert point
      if (offset > 0) {
        result.push({
          text: segment.text.slice(0, offset),
          style: { ...segment.style },
        });
      }

      // Inserted text
      result.push({ text, style: { ...style } });
      inserted = true;

      // Part after insert point
      if (offset < segment.text.length) {
        result.push({
          text: segment.text.slice(offset),
          style: { ...segment.style },
        });
      }
    } else {
      result.push({ text: segment.text, style: { ...segment.style } });
    }

    charIndex = segmentEnd;
  }

  // Insert at the end
  if (!inserted) {
    result.push({ text, style: { ...style } });
  }

  return normalizeSegments(result);
}

/**
 * Delete text in a range
 */
export function deleteTextInRange(
  segments: RichTextSegment[],
  start: number,
  end: number
): RichTextSegment[] {
  if (segments.length === 0 || start === end) return segments;

  // Ensure start < end
  const delStart = Math.min(start, end);
  const delEnd = Math.max(start, end);

  const result: RichTextSegment[] = [];
  let charIndex = 0;

  for (const segment of segments) {
    const segmentStart = charIndex;
    const segmentEnd = charIndex + segment.text.length;

    // Segment is completely before deletion
    if (segmentEnd <= delStart) {
      result.push({ text: segment.text, style: { ...segment.style } });
    }
    // Segment is completely after deletion
    else if (segmentStart >= delEnd) {
      result.push({ text: segment.text, style: { ...segment.style } });
    }
    // Segment overlaps with deletion
    else {
      const keepParts: string[] = [];

      // Part before deletion
      if (segmentStart < delStart) {
        keepParts.push(segment.text.slice(0, delStart - segmentStart));
      }

      // Part after deletion
      if (segmentEnd > delEnd) {
        keepParts.push(segment.text.slice(delEnd - segmentStart));
      }

      const remainingText = keepParts.join('');
      if (remainingText) {
        result.push({ text: remainingText, style: { ...segment.style } });
      }
    }

    charIndex = segmentEnd;
  }

  return normalizeSegments(result);
}

/**
 * Replace text in a range with new text (delete + insert)
 */
export function replaceTextInRange(
  segments: RichTextSegment[],
  start: number,
  end: number,
  newText: string,
  style: TextStyle
): RichTextSegment[] {
  const afterDelete = deleteTextInRange(segments, start, end);
  return insertTextAtPosition(afterDelete, Math.min(start, end), newText, style);
}

/**
 * Find word boundaries at a position (for double-click word selection)
 */
export function findWordBoundaries(text: string, position: number): { start: number; end: number } {
  if (!text || position < 0 || position > text.length) {
    return { start: position, end: position };
  }

  // Find start of word (go backwards)
  let start = position;
  while (start > 0 && /\S/.test(text[start - 1])) {
    start--;
  }

  // Find end of word (go forwards)
  let end = position;
  while (end < text.length && /\S/.test(text[end])) {
    end++;
  }

  return { start, end };
}

/**
 * Find a single word boundary (start or end) at a position
 */
export function findWordBoundary(text: string, position: number, direction: 'start' | 'end'): number {
  const bounds = findWordBoundaries(text, position);
  return direction === 'start' ? bounds.start : bounds.end;
}

/**
 * Find line boundaries at a position (for triple-click line selection)
 */
export function findLineBoundaries(text: string, position: number): { start: number; end: number } {
  if (!text || position < 0 || position > text.length) {
    return { start: position, end: position };
  }

  // Find start of line
  let start = position;
  while (start > 0 && text[start - 1] !== '\n') {
    start--;
  }

  // Find end of line
  let end = position;
  while (end < text.length && text[end] !== '\n') {
    end++;
  }

  return { start, end };
}

/**
 * Find next word boundary (for Ctrl+Arrow navigation)
 */
export function findNextWordBoundary(text: string, position: number, direction: 'forward' | 'backward'): number {
  if (!text) return position;

  if (direction === 'forward') {
    // Skip current word/whitespace, then find end of next word
    let pos = position;

    // Skip whitespace
    while (pos < text.length && /\s/.test(text[pos])) {
      pos++;
    }

    // Skip word
    while (pos < text.length && /\S/.test(text[pos])) {
      pos++;
    }

    return pos;
  } else {
    // Go backwards
    let pos = position;

    // Skip whitespace
    while (pos > 0 && /\s/.test(text[pos - 1])) {
      pos--;
    }

    // Skip word
    while (pos > 0 && /\S/.test(text[pos - 1])) {
      pos--;
    }

    return pos;
  }
}

/**
 * Calculate character position from click coordinates on canvas
 * This is used to determine cursor position from mouse clicks
 */
export function calculateCharacterPosition(
  segments: RichTextSegment[],
  clickX: number,
  clickY: number,
  ctx: CanvasRenderingContext2D,
  boxX: number,
  boxY: number,
  boxWidth: number,
  lineHeight: number,
  padding: { top: number; left: number; right: number; bottom: number },
  scale: number
): number {
  const text = getPlainText(segments);
  if (!text) return 0;

  // Calculate text area
  const textX = boxX + padding.left * scale;
  const textY = boxY + padding.top * scale;
  const textWidth = boxWidth - (padding.left + padding.right) * scale;

  // Determine which line was clicked
  const relativeY = clickY - textY;
  const lineIndex = Math.floor(relativeY / lineHeight);

  // Get lines with word wrapping
  const lines = wrapTextToLines(segments, ctx, textWidth, scale);

  if (lineIndex < 0) return 0;
  if (lineIndex >= lines.length) return text.length;

  // Calculate character offset for lines before clicked line
  let charOffset = 0;
  for (let i = 0; i < lineIndex; i++) {
    charOffset += lines[i].text.length;
  }

  // Find position within line
  const line = lines[lineIndex];
  const relativeX = clickX - textX;

  // Measure each character to find click position
  let x = 0;
  for (let i = 0; i < line.text.length; i++) {
    const charStyle = getStyleAtPosition(segments, charOffset + i);
    ctx.font = buildFontString(charStyle, scale);
    const charWidth = ctx.measureText(line.text[i]).width;

    if (relativeX < x + charWidth / 2) {
      return charOffset + i;
    }
    x += charWidth;
  }

  return charOffset + line.text.length;
}

/**
 * Build CSS font string from style
 */
export function buildFontString(style: TextStyle, scale: number = 1): string {
  let font = '';
  if (style.fontStyle === 'italic') font += 'italic ';
  if (style.fontWeight === 'bold') font += 'bold ';
  font += `${style.fontSize * scale}px ${style.fontFamily}`;
  return font;
}

/**
 * Wrap text into lines for rendering
 */
export interface WrappedLine {
  text: string;
  segments: { text: string; style: TextStyle; startIndex: number }[];
  startIndex: number;
}

export function wrapTextToLines(
  segments: RichTextSegment[],
  ctx: CanvasRenderingContext2D,
  maxWidth: number,
  scale: number
): WrappedLine[] {
  const lines: WrappedLine[] = [];
  const text = getPlainText(segments);

  if (!text) return [];

  let currentLine: WrappedLine = { text: '', segments: [], startIndex: 0 };
  let currentX = 0;
  let globalIndex = 0;

  // Split by explicit newlines first
  const paragraphs = text.split('\n');
  let paragraphStart = 0;

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];

    if (p > 0) {
      // Start new line for each paragraph
      if (currentLine.text || currentLine.segments.length > 0) {
        lines.push(currentLine);
      }
      currentLine = { text: '', segments: [], startIndex: paragraphStart };
      currentX = 0;
    }

    const words = paragraph.split(/(\s+)/);

    for (const word of words) {
      if (!word) continue;

      // Measure word with correct styling
      let wordWidth = 0;
      for (let i = 0; i < word.length; i++) {
        const style = getStyleAtPosition(segments, paragraphStart + currentLine.text.length + i);
        ctx.font = buildFontString(style, scale);
        wordWidth += ctx.measureText(word[i]).width;
      }

      // Check if word fits on current line
      if (currentX + wordWidth > maxWidth && currentLine.text.length > 0) {
        // Start new line
        lines.push(currentLine);
        currentLine = { text: '', segments: [], startIndex: paragraphStart + globalIndex };
        currentX = 0;
      }

      currentLine.text += word;
      currentX += wordWidth;
      globalIndex += word.length;
    }

    paragraphStart += paragraph.length + 1; // +1 for newline
  }

  // Add last line
  if (currentLine.text || lines.length === 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Render rich text segments to canvas with selection highlighting
 */
export function renderRichTextToCanvas(
  ctx: CanvasRenderingContext2D,
  segments: RichTextSegment[],
  x: number,
  y: number,
  width: number,
  height: number,
  scale: number,
  padding: { top: number; right: number; bottom: number; left: number },
  textAlign: 'left' | 'center' | 'right' | 'justify',
  verticalAlign: 'top' | 'middle' | 'bottom',
  lineHeight: number,
  selection: SelectionState | null,
  cursorPosition: number | null,
  showCursor: boolean
): void {
  const textX = x + padding.left * scale;
  const textY = y + padding.top * scale;
  const textWidth = width - (padding.left + padding.right) * scale;
  const textHeight = height - (padding.top + padding.bottom) * scale;

  // Get wrapped lines
  const lines = wrapTextToLines(segments, ctx, textWidth, scale);

  if (lines.length === 0) {
    // Draw cursor at start if editing empty text
    if (showCursor && cursorPosition === 0) {
      drawCursor(ctx, textX, textY, lineHeight);
    }
    return;
  }

  // Calculate total text height for vertical alignment
  const totalTextHeight = lines.length * lineHeight;
  let startY = textY;

  if (verticalAlign === 'middle') {
    startY = textY + (textHeight - totalTextHeight) / 2;
  } else if (verticalAlign === 'bottom') {
    startY = textY + textHeight - totalTextHeight;
  }

  // Render each line
  let globalCharIndex = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineY = startY + lineIdx * lineHeight;

    // Calculate line X based on alignment
    let lineX = textX;
    if (textAlign === 'center' || textAlign === 'right') {
      // Measure full line width
      let lineWidth = 0;
      for (let i = 0; i < line.text.length; i++) {
        const style = getStyleAtPosition(segments, globalCharIndex + i);
        ctx.font = buildFontString(style, scale);
        lineWidth += ctx.measureText(line.text[i]).width;
      }

      if (textAlign === 'center') {
        lineX = textX + (textWidth - lineWidth) / 2;
      } else {
        lineX = textX + textWidth - lineWidth;
      }
    }

    // Render characters with their styles
    let charX = lineX;

    for (let i = 0; i < line.text.length; i++) {
      const charIndex = globalCharIndex + i;
      const char = line.text[i];
      const style = getStyleAtPosition(segments, charIndex);

      ctx.font = buildFontString(style, scale);
      const charWidth = ctx.measureText(char).width;

      // Check if character is selected
      const isSelected = selection &&
        charIndex >= Math.min(selection.start, selection.end) &&
        charIndex < Math.max(selection.start, selection.end);

      // Draw selection highlight
      if (isSelected) {
        ctx.fillStyle = 'rgba(50, 151, 253, 0.3)';
        ctx.fillRect(charX, lineY, charWidth, lineHeight);
      }

      // Draw character
      ctx.fillStyle = style.color;
      ctx.textBaseline = 'top';
      ctx.fillText(char, charX, lineY + (lineHeight - style.fontSize * scale) / 2);

      // Draw text decorations
      if (style.textDecoration === 'underline') {
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(charX, lineY + lineHeight - 2);
        ctx.lineTo(charX + charWidth, lineY + lineHeight - 2);
        ctx.stroke();
      } else if (style.textDecoration === 'line-through') {
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const strikeY = lineY + lineHeight / 2;
        ctx.moveTo(charX, strikeY);
        ctx.lineTo(charX + charWidth, strikeY);
        ctx.stroke();
      }

      // Draw cursor
      if (showCursor && cursorPosition === charIndex) {
        drawCursor(ctx, charX, lineY, lineHeight);
      }

      charX += charWidth;
    }

    // Draw cursor at end of line
    if (showCursor && cursorPosition === globalCharIndex + line.text.length) {
      drawCursor(ctx, charX, lineY, lineHeight);
    }

    globalCharIndex += line.text.length;
  }
}

/**
 * Draw blinking cursor
 */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  height: number
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y + 2, 2, height - 4);
}
