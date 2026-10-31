import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, beginText, endText, setFontAndSize, setTextMatrix, setCharacterSqueeze, showText, setCharacterSpacing, setWordSpacing, setFillingRgbColor } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyTextEdits, prepareTextEditLayout, previewInlineTextEdits } from '../../src/editing/TextEditApplier';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

async function scaledParagraph() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]), font = await pdf.embedFont(StandardFonts.Courier);
  const fontKey = page.node.newFontDictionary('Body', font.ref);
  const rows = ['alpha beta', 'gamma delta', 'third line'];
  for (let i = 0; i < rows.length; i++) page.pushOperators(beginText(), setFontAndSize(fontKey, 12), setCharacterSqueeze(175), setTextMatrix(1, 0, 0, 1, 40, 500 - i * 16), showText(font.encodeText(rows[i])), endText());
  page.drawText('NEIGHBOR', { x: 40, y: 435, size: 12 });
  const block: TextBlock = { id: 'scaled', pageNumber: 1, text: rows.join('\n'), editable: true,
    rect: { x: 40, y: 88, width: 138.6, height: 44 },
    // Reproduce a draft cached by the old detector: horizontal scale was mistaken for font size.
    style: { fontName: 'Courier', fontSize: 21, alignment: 'left', lineHeight: 16 / 21 },
    lines: rows.map((text, i) => ({ text, items: [], x: 40, y: 88 + i * 16, width: text.length * 12.6, height: 12, baseline: 100 + i * 16 })),
  };
  return { data: new Uint8Array(await pdf.save()).buffer, block };
}
function inspect(data: Uint8Array) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(0), text = page.toStructuredText('');
  const chars: { c: string; x: number; y: number; size: number; font: string; color: number[] }[] = [];
  try {
    text.walk({ onChar(c, origin, font, size, _quad, color) { try { chars.push({ c, x: origin[0], y: origin[1], size, font: font.getName(), color: [...color] }); } finally { font.destroy(); } } });
    return chars;
  } finally { text.destroy(); page.destroy(); pdf.destroy(); }
}
describe('source text metrics and export fidelity', () => {
  it('reflows justified text using the original spacing range, without double justification or reducing the font', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]), font = await pdf.embedFont(StandardFonts.Courier);
    const rows = ['alpha beta gamma', 'long words', 'one two'], gaps = [2.4, 40.8, 7.2], widths = [105.6, 105.6, 50.4];
    rows.forEach((row, i) => {
      let x = 40;
      for (const word of row.split(' ')) { page.drawText(word, { x, y: 500 - i * 14.4, font, size: 12 }); x += word.length * 7.2 + gaps[i]; }
    });
    const data = new Uint8Array(await pdf.save()).buffer;
    const block: TextBlock = { id: 'justified', pageNumber: 1, text: rows.join('\n'), editable: true, rect: { x: 40, y: 88, width: 105.6, height: 40.8 },
      style: { fontName: 'Courier', fontSize: 12, alignment: 'justify', lineHeight: 1.2 },
      lines: rows.map((text, i) => ({ text, items: [], x: 40, y: 88 + i * 14.4, width: widths[i], height: 12, baseline: 100 + i * 14.4 })) };
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: 'omega beta gamma long words one two end', timestamp: 1,
      layout: { keepBaseline: true, reflow: true } };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.layout.lines).toHaveLength(3);
    expect(prepared.input.rect.height).toBe(40.8);
    expect(prepared.layout.fontSize).toBe(12);
    for (const line of prepared.layout.lines.slice(0, -1)) expect(line.width).toBeCloseTo(105.6);
    const exported = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit]));
    expect(exported.map(glyph => glyph.c).join('').replace(/\s/g, '')).toBe(edit.newText.replace(/\s/g, ''));
  });
  it('preserves a custom ToUnicode mapping through export instead of reverting to the font program encoding', async () => {
    const pdf = new mupdf.PDFDocument(), font = new mupdf.Font('Times-Roman'), resource = pdf.addFont(font);
    const chars = ['fi', ...Array.from(' test')], gids = chars.map(c => font.encodeCharacter(c === 'fi' ? 'X' : c));
    const hex = (value: number) => value.toString(16).padStart(4, '0');
    const mapping = new Map(gids.map((gid, index) => [gid, chars[index]]));
    const cmap = pdf.addStream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /TestUnicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange ${mapping.size} beginbfchar ${[...mapping].map(([gid, c]) => `<${hex(gid)}> <${c.split('').map(c => hex(c.charCodeAt(0))).join('')}>`).join('\n')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`, {});
    resource.put('ToUnicode', cmap);
    const width = gids.reduce((sum, gid) => sum + font.advanceGlyph(gid) * 18, 0);
    const sheet = pdf.addPage([0, 0, 500, 600], 0, { Font: { Body: resource } }, `BT /Body 18 Tf 1 0 0 1 40 500 Tm <${gids.map(hex).join('')}> Tj ET`);
    pdf.insertPage(-1, sheet);
    const buffer = pdf.saveToBuffer(''), data = new Uint8Array(buffer.asUint8Array()).buffer;
    buffer.destroy(); sheet.destroy(); cmap.destroy(); resource.destroy(); font.destroy(); pdf.destroy();
    expect(inspect(new Uint8Array(data)).map(g => g.c).join('')).toBe('fi test');
    const block: TextBlock = { id: 'encoding', pageNumber: 1, text: 'fi test', editable: true, rect: { x: 40, y: 82, width, height: 18 },
      style: { fontName: 'Times-Roman', fontSize: 18, alignment: 'left', lineHeight: 1.2 },
      lines: [{ text: 'fi test', items: [], x: 40, y: 82, width, height: 18, baseline: 100 }] };
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: 'fi next', timestamp: 1, layout: { keepBaseline: true, reflow: true, autoGrow: true } };
    const output = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit]));
    expect(output.map(g => g.c).join('')).toBe('fi next');
    expect(output.slice(0, 2)).toEqual(inspect(new Uint8Array(data)).slice(0, 2));
  });

  it('uses positioned gaps as synthetic spaces without counting them twice as character spacing', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]), font = await pdf.embedFont(StandardFonts.Courier);
    let x = 40;
    for (const word of ['alpha', 'beta', 'gamma']) {
      page.drawText(word, { x, y: 500, size: 12, font }); x += word.length * 7.2 + 2.3;
    }
    const width = x - 40 - 2.3, data = new Uint8Array(await pdf.save()).buffer;
    const block: TextBlock = { id: 'spacing', pageNumber: 1, text: 'alpha beta gamma', editable: true, rect: { x: 40, y: 88, width, height: 12 },
      style: { fontName: 'Courier', fontSize: 12, alignment: 'left', lineHeight: 1.2 },
      lines: [{ text: 'alpha beta gamma', items: [], x: 40, y: 88, width, height: 12, baseline: 100 }] };
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: 'omega beta gamma', timestamp: 1, layout: { keepBaseline: true, reflow: true } };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.layout.lines).toHaveLength(1);
    expect(prepared.input.rect.width).toBeCloseTo(width);
    expect(prepared.layout.lines[0].width).toBeCloseTo(width, 2);
    expect(prepared.layout.warnings).toEqual([]);
    const before = inspect(new Uint8Array(data)).filter(g => g.c.trim()), after = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit])).filter(g => g.c.trim());
    expect(after.map(g => g.c).join('')).toBe('omegabetagamma');
    after.forEach((glyph, i) => expect(Math.abs(glyph.x - before[i].x)).toBeLessThan(.02));
  });
  it('reuses an embedded ligature without duplicating letters or changing neighboring glyph advances', async () => {
    const buffer = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
    const device = writer.beginPage([0, 0, 500, 600]), text = new mupdf.Text(), font = new mupdf.Font('Times-Italic');
    const ligature = font.encodeCharacter('ﬁ'), advance = font.advanceGlyph(ligature) * 18;
    text.showGlyph(font, [18, 0, 0, -18, 40, 100], ligature, 'f'.codePointAt(0)!);
    text.showGlyph(font, [18, 0, 0, -18, 40, 100], -1, 'i'.codePointAt(0)!);
    const end = text.showString(font, [18, 0, 0, -18, 40 + advance, 100], 'le test');
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    device.close(); writer.endPage(); writer.close();
    const data = new Uint8Array(buffer.asUint8Array()).buffer;
    device.destroy(); text.destroy(); font.destroy(); writer.destroy(); buffer.destroy();
    const block: TextBlock = { id: 'ligature', pageNumber: 1, text: 'file test', editable: true, rect: { x: 40, y: 82, width: end[4] - 40, height: 18 },
      style: { fontName: 'Times-Italic', fontSize: 18, alignment: 'left', lineHeight: 1.2 },
      lines: [{ text: 'file test', items: [], x: 40, y: 82, width: end[4] - 40, height: 18, baseline: 100 }] };
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: 'file next', timestamp: 1, layout: { keepBaseline: true, reflow: true, autoGrow: true } };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.layout.lines[0].glyphs[0].character).toBe('fi');
    expect(prepared.layout.lines[0].glyphs[0].advance).toBeCloseTo(advance, 3);
    const after = inspect(await applyTextEdits(data, new Map([[1, [block]]]), [edit]));
    expect(after.map(glyph => glyph.c).join('').normalize('NFKC')).toBe('file next');
    const before = inspect(new Uint8Array(data));
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
  });
  it('retains font runs, color, horizontal scale, character and word spacing after a local replacement', async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]);
    const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const plainKey = page.node.newFontDictionary('Plain', regular.ref), boldKey = page.node.newFontDictionary('Emphasis', bold.ref);
    const sourceText = '1234 BOLD tail';
    page.pushOperators(beginText(), setTextMatrix(1, 0, 0, 1, 40, 500), setCharacterSqueeze(90), setCharacterSpacing(.6), setWordSpacing(2),
      setFontAndSize(plainKey, 12), setFillingRgbColor(.1, .3, .7), showText(regular.encodeText('1234 ')),
      setFontAndSize(boldKey, 18), setFillingRgbColor(.7, .1, .2), showText(bold.encodeText('BOLD')),
      setFontAndSize(plainKey, 12), setFillingRgbColor(.1, .3, .7), showText(regular.encodeText(' tail')), endText());
    const data = new Uint8Array(await pdf.save()).buffer;
    const block: TextBlock = { id: 'mixed', pageNumber: 1, text: sourceText, editable: true,
      style: { fontName: 'Helvetica', fontSize: 18, alignment: 'left', lineHeight: 1.2 }, rect: { x: 40, y: 82, width: 160, height: 18 },
      lines: [{ text: sourceText, items: [], x: 40, y: 82, width: 160, height: 18, baseline: 100 }] };
    const edit: TextEditOperation = { blockId: block.id, originalText: sourceText, newText: '5678 BOLD tail', timestamp: 1,
      layout: { keepBaseline: true, reflow: true, autoGrow: true } };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.input.fontSize).toBeCloseTo(18);
    const resized = await prepareTextEditLayout(data, block, { ...edit, layout: { ...edit.layout, fontSize: 24 } });
    expect(resized.layout.lines.flatMap(line => line.glyphs).filter(glyph => /[5678]/.test(glyph.character)).every(glyph => Math.abs(glyph.fontSize! - 16) < .001)).toBe(true);
    expect(resized.layout.lines.flatMap(line => line.glyphs).filter(glyph => /[BOLD]/.test(glyph.character)).every(glyph => Math.abs(glyph.fontSize! - 24) < .001)).toBe(true);
    const exported = await applyTextEdits(data, new Map([[1, [block]]]), [edit]);
    const before = inspect(new Uint8Array(data)), after = inspect(exported);
    expect(after.map(glyph => glyph.c).join('')).toBe(edit.newText);
    for (let i = 0; i < after.length; i++) {
      // Base-14 substitutes and PDF font widths round at 1/1000 em.
      expect(Math.abs(after[i].x - before[i].x)).toBeLessThan(.02);
      expect(after[i].y).toBeCloseTo(before[i].y, 3);
      expect(after[i].size).toBeCloseTo(before[i].size, 3);
      // The nonembedded PDF Base-14 names become their embedded equivalents.
      expect(after[i].font.replace(/^NimbusSans-(Regular)?/, 'Helvetica').replace('HelveticaBold', 'Helvetica-Bold')).toBe(before[i].font);
      after[i].color.forEach((channel, c) => expect(channel).toBeCloseTo(before[i].color[c], 2));
    }
    expect(inspect(await previewInlineTextEdits(data, new Map([[1, [block]]]), [edit]))).toEqual(after);
  });

  it.each([8, 12, 24])('resolves growth before export at %ipt without any preview round trip', async size => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([500, 600]), font = await pdf.embedFont(StandardFonts.Courier);
    page.drawText('Short', { x: 40, y: 500, size, font });
    page.drawText('UNCHANGED', { x: 40, y: 250, size: 12, font });
    const data = new Uint8Array(await pdf.save()).buffer;
    const block: TextBlock = { id: 'grow', pageNumber: 1, text: 'Short', editable: true, rect: { x: 40, y: 100 - size, width: size * 3, height: size },
      style: { fontName: 'Courier', fontSize: size, alignment: 'left', lineHeight: 1.2 },
      lines: [{ text: 'Short', items: [], x: 40, y: 100 - size, width: size * 3, height: size, baseline: 100 }] };
    for (const replacement of ['Longer replacement with wrapping and 中文 English 混排.', 'First line\n中文第二行\nThird line', 'S', '']) {
      const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: replacement, timestamp: 1, layout: { keepBaseline: true, reflow: true, autoGrow: true } };
      const blocks = new Map([[1, [block]]]), exported = await applyTextEdits(data, blocks, [edit]);
      const chars = inspect(exported).filter(glyph => glyph.y < 300);
      expect(chars.map(glyph => glyph.c).join('').replace(/\s/g, '')).toBe(replacement.replace(/\s/g, ''));
      // CJK fallback has its own glyph metrics, but remains at the requested size.
      expect(chars.every(glyph => Math.abs(glyph.size - size) < .001)).toBe(true);
      expect(inspect(exported).filter(glyph => glyph.y >= 300)).toEqual(inspect(new Uint8Array(data)).filter(glyph => glyph.y >= 300));
      expect(inspect(await previewInlineTextEdits(data, blocks, [edit]))).toEqual(inspect(exported));
    }
  });
  it('repairs the 53pt/44pt false overflow without shrinking text or dropping source horizontal scaling', async () => {
    const { data, block } = await scaledParagraph();
    const edit: TextEditOperation = { blockId: block.id, originalText: block.text, newText: 'omega beta\ngamma delta\nthird line', timestamp: 1 };
    const prepared = await prepareTextEditLayout(data, block, edit);
    expect(prepared.input.fontSize).toBeCloseTo(12);
    expect(prepared.layout.requiredHeight).toBeCloseTo(44);
    expect(prepared.layout.fits).toBe(true);
    expect(prepared.input.sourceStyles?.[0].horizontalScale).toBeCloseTo(1.75);
    expect(prepared.layout.lines[0].glyphs[0].advance).toBeCloseTo(12.6, 3);
    const blocks = new Map([[1, [block]]]);
    const exported = await applyTextEdits(data, blocks, [edit]), preview = await previewInlineTextEdits(data, blocks, [edit]);
    const chars = inspect(exported).filter(c => c.y < 140);
    expect(chars.map(c => c.c).join('')).toBe('omega betagamma deltathird line');
    expect(chars[1].x - chars[0].x).toBeCloseTo(12.6, 3);
    expect([...new Set(chars.map(c => c.y))]).toEqual([100, 116, 132]);
    expect(inspect(preview)).toEqual(inspect(exported));
    expect(inspect(exported).filter(c => c.y > 140)).toEqual(inspect(new Uint8Array(data)).filter(c => c.y > 140));
  });
});
