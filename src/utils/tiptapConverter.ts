/**
 * TipTap HTML to PDF Conversion Utilities
 *
 * This module provides functions to convert TipTap rich text HTML content
 * to formats suitable for PDF rendering and RichTextSegments.
 */

import type { TextStyle, RichTextSegment } from '../annotations/types';

/**
 * Parse TipTap HTML content and extract rich text segments
 */
export function parseTipTapHTML(html: string, defaultStyle: TextStyle): RichTextSegment[] {
  if (!html || html === '<p></p>') {
    return [];
  }

  const segments: RichTextSegment[] = [];

  // Create a DOM parser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Process all paragraphs
  const paragraphs = doc.body.querySelectorAll('p');

  paragraphs.forEach((p, pIndex) => {
    // Get paragraph-level alignment
    const pStyle = p.getAttribute('style') || '';
    const textAlign = extractStyleValue(pStyle, 'text-align') as TextStyle['textAlign'] || defaultStyle.textAlign;

    // Process child nodes
    processNode(p, segments, { ...defaultStyle, textAlign });

    // Add newline between paragraphs (except after last)
    if (pIndex < paragraphs.length - 1) {
      segments.push({
        text: '\n',
        style: { ...defaultStyle, textAlign }
      });
    }
  });

  // Normalize segments to merge adjacent ones with same style
  return normalizeSegments(segments);
}

/**
 * Process a DOM node and extract text with styles
 */
function processNode(node: Node, segments: RichTextSegment[], inheritedStyle: Partial<TextStyle>): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent || '';
      if (text) {
        segments.push({
          text,
          style: { ...inheritedStyle }
        });
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as HTMLElement;
      const newStyle = { ...inheritedStyle };

      // Apply element-specific styles
      switch (element.tagName.toLowerCase()) {
        case 'strong':
        case 'b':
          newStyle.fontWeight = 'bold';
          break;
        case 'em':
        case 'i':
          newStyle.fontStyle = 'italic';
          break;
        case 'u':
          newStyle.textDecoration = 'underline';
          break;
        case 's':
        case 'strike':
        case 'del':
          newStyle.textDecoration = 'line-through';
          break;
        case 'span':
          // Extract inline styles from span
          const spanStyle = element.getAttribute('style') || '';
          applyInlineStyles(spanStyle, newStyle);
          break;
        case 'mark':
          // Highlight - we could track background color if needed
          const markColor = element.getAttribute('data-color');
          if (markColor) {
            // For now, we don't have background color in segments
            // but this could be added
          }
          break;
        case 'br':
          segments.push({
            text: '\n',
            style: { ...newStyle }
          });
          continue; // Don't recurse into br
      }

      // Recurse into child elements
      processNode(element, segments, newStyle);
    }
  }
}

/**
 * Apply inline styles from a style attribute to a TextStyle object
 */
function applyInlineStyles(styleAttr: string, style: Partial<TextStyle>): void {
  if (!styleAttr) return;

  // Font family
  const fontFamily = extractStyleValue(styleAttr, 'font-family');
  if (fontFamily) {
    style.fontFamily = fontFamily.replace(/['"]/g, '');
  }

  // Font size
  const fontSize = extractStyleValue(styleAttr, 'font-size');
  if (fontSize) {
    const size = parseInt(fontSize, 10);
    if (!isNaN(size)) {
      style.fontSize = size;
    }
  }

  // Color
  const color = extractStyleValue(styleAttr, 'color');
  if (color) {
    style.color = normalizeColor(color);
  }

  // Font weight
  const fontWeight = extractStyleValue(styleAttr, 'font-weight');
  if (fontWeight === 'bold' || fontWeight === '700') {
    style.fontWeight = 'bold';
  } else if (fontWeight === 'normal' || fontWeight === '400') {
    style.fontWeight = 'normal';
  }

  // Font style
  const fontStyle = extractStyleValue(styleAttr, 'font-style');
  if (fontStyle === 'italic') {
    style.fontStyle = 'italic';
  } else if (fontStyle === 'normal') {
    style.fontStyle = 'normal';
  }

  // Text decoration
  const textDecoration = extractStyleValue(styleAttr, 'text-decoration');
  if (textDecoration) {
    if (textDecoration.includes('underline')) {
      style.textDecoration = 'underline';
    } else if (textDecoration.includes('line-through')) {
      style.textDecoration = 'line-through';
    } else if (textDecoration === 'none') {
      style.textDecoration = 'none';
    }
  }

  // Text align
  const textAlign = extractStyleValue(styleAttr, 'text-align');
  if (textAlign && ['left', 'center', 'right', 'justify'].includes(textAlign)) {
    style.textAlign = textAlign as TextStyle['textAlign'];
  }
}

/**
 * Extract a style value from an inline style string
 */
function extractStyleValue(styleAttr: string, property: string): string | null {
  const regex = new RegExp(`${property}\\s*:\\s*([^;]+)`, 'i');
  const match = styleAttr.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Normalize color values to hex format
 */
function normalizeColor(color: string): string {
  // Already hex
  if (color.startsWith('#')) {
    return color;
  }

  // RGB format
  const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // RGBA format (ignore alpha for PDF)
  const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/i);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // Named colors (basic mapping)
  const namedColors: Record<string, string> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#00ff00',
    blue: '#0000ff',
    yellow: '#ffff00',
    cyan: '#00ffff',
    magenta: '#ff00ff',
  };

  return namedColors[color.toLowerCase()] || color;
}

/**
 * Normalize segments - merge adjacent segments with identical styles
 */
function normalizeSegments(segments: RichTextSegment[]): RichTextSegment[] {
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
 * Check if two styles are equal
 */
function stylesEqual(a: Partial<TextStyle>, b: Partial<TextStyle>): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.textDecoration === b.textDecoration &&
    a.color === b.color &&
    a.textAlign === b.textAlign
  );
}

/**
 * Convert RichTextSegments back to TipTap-compatible HTML
 * Useful for loading saved content back into the editor
 */
export function segmentsToTipTapHTML(segments: RichTextSegment[], defaultStyle: TextStyle): string {
  if (segments.length === 0) {
    return '<p></p>';
  }

  const plainText = segments.map(s => s.text).join('');
  const lines = plainText.split('\n');

  let html = '';
  let globalIndex = 0;

  for (const line of lines) {
    // Determine paragraph alignment from first segment in line
    const lineStyle = getStyleAtIndex(segments, globalIndex);
    const alignStyle = lineStyle.textAlign !== 'left' ? ` style="text-align: ${lineStyle.textAlign}"` : '';

    html += `<p${alignStyle}>`;

    if (line.length === 0) {
      // Empty line - TipTap needs content or it collapses
      html += '<br>';
    } else {
      // Build content with spans for formatting
      let lineIndex = 0;
      while (lineIndex < line.length) {
        const style = getStyleAtIndex(segments, globalIndex + lineIndex);

        // Find run of characters with same style
        let runEnd = lineIndex + 1;
        while (runEnd < line.length) {
          const nextStyle = getStyleAtIndex(segments, globalIndex + runEnd);
          if (!stylesEqual(style, nextStyle)) break;
          runEnd++;
        }

        const runText = escapeHtml(line.slice(lineIndex, runEnd));
        html += buildStyledSpan(runText, style, defaultStyle);

        lineIndex = runEnd;
      }
    }

    html += '</p>';
    globalIndex += line.length + 1; // +1 for newline
  }

  return html;
}

/**
 * Get style at a specific character index
 */
function getStyleAtIndex(segments: RichTextSegment[], index: number): Partial<TextStyle> {
  let charIndex = 0;

  for (const segment of segments) {
    const segmentEnd = charIndex + segment.text.length;
    if (index >= charIndex && index < segmentEnd) {
      return segment.style;
    }
    charIndex = segmentEnd;
  }

  // Return last segment's style if at end
  if (segments.length > 0) {
    return segments[segments.length - 1].style;
  }

  return {};
}

/**
 * Build a styled span element for TipTap HTML
 */
function buildStyledSpan(text: string, style: Partial<TextStyle>, defaultStyle: TextStyle): string {
  let result = text;

  // Apply inline formatting tags
  if (style.fontWeight === 'bold') {
    result = `<strong>${result}</strong>`;
  }
  if (style.fontStyle === 'italic') {
    result = `<em>${result}</em>`;
  }
  if (style.textDecoration === 'underline') {
    result = `<u>${result}</u>`;
  }
  if (style.textDecoration === 'line-through') {
    result = `<s>${result}</s>`;
  }

  // Build style attribute for non-default values
  const styleAttrs: string[] = [];

  if (style.fontFamily && style.fontFamily !== defaultStyle.fontFamily) {
    styleAttrs.push(`font-family: ${style.fontFamily}`);
  }
  if (style.fontSize && style.fontSize !== defaultStyle.fontSize) {
    styleAttrs.push(`font-size: ${style.fontSize}px`);
  }
  if (style.color && style.color !== defaultStyle.color) {
    styleAttrs.push(`color: ${style.color}`);
  }

  if (styleAttrs.length > 0) {
    result = `<span style="${styleAttrs.join('; ')}">${result}</span>`;
  }

  return result;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Get plain text from TipTap HTML
 */
export function getTipTapPlainText(html: string): string {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  let text = '';
  const paragraphs = doc.body.querySelectorAll('p');

  paragraphs.forEach((p, index) => {
    text += p.textContent || '';
    if (index < paragraphs.length - 1) {
      text += '\n';
    }
  });

  return text;
}
