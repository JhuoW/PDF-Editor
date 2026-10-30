import { describe, expect, it } from 'vitest';
import { inlineAvailableRect } from '../../src/editing/InlineTextBounds';
import { inlineCaret, inlineOffsetAt, inlineSelection, inlineTextRows } from '../../src/editing/InlineTextGeometry';
import type { TextBlock } from '../../src/editing/types';
import type { PreparedTextEditLayout } from '../../src/editing/TextEditApplier';

const block: TextBlock = { id: 'body', pageNumber: 1, editable: true, text: 'Hello', rect: { x: 30, y: 50, width: 50, height: 10 }, lines: [{ text: 'Hello', x: 30, y: 50, width: 50, height: 10, baseline: 58, items: [] }], style: { fontName: 'Helvetica', fontSize: 10, lineHeight: 1.2, alignment: 'left' } };
const neighbor = (rect: TextBlock['rect']) => ({ ...block, id: 'neighbor', rect });
const prepared: PreparedTextEditLayout = {
  input: { text: 'ab 😀\ncd', rect: { x: 10, y: 20, width: 100, height: 50 }, fontName: 'Helvetica', fontSize: 10, fontColor: '#000000', alignment: 'left', lineHeight: 1.2 },
  page: { width: 400, height: 600 }, layout: { fits: true, requiredHeight: 22, fontSize: 10, lineAdvance: 12, inkBounds: null, warnings: [], lines: [
    { text: 'ab 😀', x: 10, baseline: 28, width: 40, paragraphEnd: true, glyphs: Array.from('ab 😀', (character, index) => ({ character, fontName: 'Helvetica', glyphId: 1, x: 10 + index * 10, baseline: 28, advance: 10 })) },
    { text: 'cd', x: 10, baseline: 40, width: 20, paragraphEnd: true, glyphs: Array.from('cd', (character, index) => ({ character, fontName: 'Helvetica', glyphId: 1, x: 10 + index * 10, baseline: 40, advance: 10 })) },
  ] },
};

describe('direct PDF editing geometry', () => {
  it('locates an intentionally blank row between two paragraph breaks', () => {
    const value = structuredClone(prepared);
    value.input.text = 'ab 😀\n\ncd';
    value.layout.lines.splice(1, 0, { text: '', x: 25, baseline: 34, width: 0, paragraphEnd: true, glyphs: [] });
    expect(inlineTextRows(value).map(row => [row.start, row.end])).toEqual([[0, 5], [6, 6], [7, 9]]);
    expect(inlineCaret(value, 6)).toEqual({ x: 25, y: 26, width: 1, height: 10 });
  });
  it('allows single-line text to grow into clear space and stops before neighboring text and artwork', () => {
    const beside = neighbor({ x: 180, y: 50, width: 60, height: 10 });
    const below = { ...neighbor({ x: 30, y: 150, width: 200, height: 20 }), id: 'below' };
    expect(inlineAvailableRect(block, [block, beside, below], 400, 600, [{ x: 25, y: 100, width: 220, height: 30 }])).toEqual({ x: 30, y: 50, width: 147.5, height: 47.5 });
    expect(block.rect).toEqual({ x: 30, y: 50, width: 50, height: 10 });
  });
  it('keeps paragraph widths, centered headings and existing bounds intact', () => {
    expect(inlineAvailableRect({ ...block, lines: [...block.lines, ...block.lines] }, [block], 400, 600).width).toBe(50);
    expect(inlineAvailableRect({ ...block, style: { ...block.style, alignment: 'center' } }, [block], 400, 600).width).toBe(50);
    expect(inlineAvailableRect(block, [block, neighbor({ x: 32, y: 60, width: 30, height: 10 })], 400, 600).height).toBe(10);
  });
  it('maps clicks to nearest glyph boundaries and follows PDF baselines across rows', () => {
    expect(inlineOffsetAt(prepared, 23, 25)).toBe(1);
    expect(inlineOffsetAt(prepared, 28, 25)).toBe(2);
    expect(inlineOffsetAt(prepared, 500, 25)).toBe(5);
    expect(inlineOffsetAt(prepared, 16, 37)).toBe(7);
    expect(inlineCaret(prepared, 7)).toEqual({ x: 20, y: 32, width: 1, height: 10 });
  });
  it('keeps UTF-16 offsets for supplementary characters, newlines and selections', () => {
    expect(inlineTextRows(prepared).map(row => [row.start, row.end])).toEqual([[0, 5], [6, 8]]);
    expect(inlineSelection(prepared, 3, 7)).toEqual([{ x: 40, y: 20, width: 10, height: 10 }, { x: 10, y: 32, width: 10, height: 10 }]);
  });
});
