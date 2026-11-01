import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { detectTextBlocks } from '../../src/editing/TextBlockDetector';
import { applyTextEdits } from '../../src/editing/TextEditApplier';
import { originalParagraphText } from '../../src/editing/ParagraphText';
import { textRowJoin, textRowTag } from '../../src/editing/TextRegionMarkers';
import { replacementTextStyles } from '../../src/editing/TextSourceMetrics';
import type { TextGlyphStyle } from '../../src/editing/TextLayout';
import { restoreTextRowSpacing, textRowSpacing, textRowSpacingTag } from '../../src/editing/TextRowSpacing';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([500, 700]), font = await pdf.embedFont(StandardFonts.Courier);
  for (const [index, text] of ['Original body content', 'continues on next row', 'and concludes here'].entries()) {
    page.drawText(text, { x: 40, y: 630 - index * 16, size: 12, font });
  }
  page.drawText('Other column', { x: 300, y: 630, size: 12, font });
  return new Uint8Array(await pdf.save());
}

describe('editor-authored soft row boundaries', () => {
  it.each(['', ' ', '    ', '\u00a0', ' \u2009 '])('round-trips whitespace-only provenance %j', value => {
    expect(textRowJoin(textRowTag(value))).toBe(value);
  });
  it('rejects invalid, excessive and text-bearing metadata', () => {
    for (const tag of [null, {}, 'PDFEditorRow_S0', 'PDFEditorRow_S20001', 'PDFEditorRow_U0061', 'PDFEditorRow_U000a', 'PDFEditorRow_U00']) {
      expect(textRowJoin(tag)).toBeUndefined();
    }
  });
  it('uses provenance only with its matching physical rows and retains external PDF heuristics', () => {
    const rows = [{ text: 'abcdef', joinAfter: '' }, { text: 'ghij', joinAfter: '  ' }, { text: 'next' }];
    expect(originalParagraphText('abcdef\nghij\nnext', rows)).toBe('abcdefghij  next');
    expect(originalParagraphText('Unrelated\nsource', rows)).toBe('Unrelated source');
    expect(originalParagraphText('abcdef\nghij\nnext')).toBe('abcdef ghij next');
  });
  it('does not shift a later glyph style when a wrap removed multiple spaces', () => {
    const style = (fontName: string): TextGlyphStyle => ({ fontKey: fontName, fontName, fontSize: 12, horizontalScale: 1, tracking: 0, fontColor: '#000000' });
    const first = style('Times-Roman'), last = style('Times-Bold');
    const source = [{ character: 'A', style: first }, { character: '\n', style: first }, { character: 'B', style: last }];
    const styles = replacementTextStyles(source, 'A   B', true, [{ text: 'A', joinAfter: '   ' }, { text: 'B' }]);
    expect(styles.map(value => value.fontName)).toEqual(['Times-Roman', 'Times-Roman', 'Times-Roman', 'Times-Roman', 'Times-Bold']);
  });
  it('restores only actual authored whitespace and rejects stale metadata after removing characters', () => {
    const tag = textRowSpacingTag('中文AB  C\u00a0D');
    const metadata = textRowSpacing(tag);
    expect(restoreTextRowSpacing('中 文 A B C D', metadata)).toBe('中文AB  C\u00a0D');
    expect(restoreTextRowSpacing('中 文 A C D', metadata)).toBeUndefined();
    for (const invalid of ['PDFEditorSpacing_2_0-u0061', 'PDFEditorSpacing_2_0-u000a', 'PDFEditorSpacing_2_0-s20001',
      'PDFEditorSpacing_2_3-s1', 'PDFEditorSpacing_20001_N', 'PDFEditorSpacing_2_1-s1_1-s1']) expect(textRowSpacing(invalid)).toBeUndefined();
  });

  it.each([
    'abcdefghij'.repeat(24),
    `prefix ${'abcdefghij'.repeat(12)} suffix`,
    `${'a'.repeat(21)}  ${'b'.repeat(21)}    ${'c'.repeat(21)}`,
    '中文ABC混合排版def文字'.repeat(8),
    'state-of-the-art-'.repeat(10),
  ])('preserves soft wrap text through two real PDF.js/MuPDF save cycles: %s', async replacement => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    let data: Uint8Array<ArrayBufferLike> = await fixture();
    for (let cycle = 0; cycle < 3; cycle++) {
      const document = await pdfjs.getDocument({ data: data.slice(), disableFontFace: true }).promise;
      try {
        const blocks = await detectTextBlocks(await document.getPage(1)), block = blocks.find(value => value.rect.x < 100)!;
        if (cycle) {
          expect(block.lines.length).toBeGreaterThan(1);
          expect(originalParagraphText(block.text, block.lines)).toBe(replacement + 'XYZ'.repeat(cycle - 1));
        }
        if (cycle < 2) data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [{
          blockId: block.id, originalText: block.text, newText: replacement + 'XYZ'.repeat(cycle), timestamp: cycle,
          layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true },
        }]);
      } finally { await document.destroy(); }
    }
  });

  it('retains local emphasis after reopening justified CJK text with synthetic extraction gaps', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 700]);
    const regular = await pdf.embedFont(StandardFonts.Courier), bold = await pdf.embedFont(StandardFonts.CourierBold);
    page.drawText('Original ', { x: 40, y: 630, size: 12, font: regular });
    page.drawText('body', { x: 40 + regular.widthOfTextAtSize('Original ', 12), y: 630, size: 12, font: bold, color: rgb(.8, .2, .4) });
    page.drawText(' content', { x: 40 + regular.widthOfTextAtSize('Original body', 12), y: 630, size: 12, font: regular });
    page.drawText('continues on next row', { x: 40, y: 614, size: 12, font: regular });
    page.drawText('and concludes here', { x: 40, y: 598, size: 12, font: regular });
    const wording = `Original body content ${'中文ABC混合排版def文字'.repeat(8)}`;
    let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await pdf.save());
    let preserved: unknown;
    for (let cycle = 0; cycle < 2; cycle++) {
      const document = await pdfjs.getDocument({ data: data.slice(), disableFontFace: true }).promise;
      try {
        const blocks = await detectTextBlocks(await document.getPage(1)), target = blocks[0];
        if (cycle) expect(originalParagraphText(target.text, target.lines)).toBe(wording);
        data = await applyTextEdits(new Uint8Array(data).buffer, new Map([[1, blocks]]), [{ blockId: target.id,
          originalText: target.text, newText: wording + (cycle ? ' XYZ' : ''), timestamp: cycle,
          layout: { flow: 'paragraph', reflow: true, keepBaseline: true, autoGrow: true } }]);
      } finally { await document.destroy(); }
      const written = new mupdf.PDFDocument(data), sheet = written.loadPage(0), content = sheet.toStructuredText('');
      const emphasis: Array<{ character: string; font: string; size: number; color: number[] }> = [];
      try {
        content.walk({ onChar(character, _point, font, size, _quad, color) {
          try { if (font.getName().includes('Bold')) emphasis.push({ character, font: font.getName(), size, color }); }
          finally { font.destroy(); }
        } });
        expect(emphasis.map(glyph => glyph.character).join('')).toBe('body');
        for (const glyph of emphasis) { expect(glyph.color[0]).toBeCloseTo(.8, 5); expect(glyph.color[1]).toBeCloseTo(.2, 5); expect(glyph.color[2]).toBeCloseTo(.4, 5); }
        if (cycle) expect(emphasis).toEqual(preserved); else preserved = emphasis;
      } finally { content.destroy(); sheet.destroy(); written.destroy(); }
    }
  });
});
