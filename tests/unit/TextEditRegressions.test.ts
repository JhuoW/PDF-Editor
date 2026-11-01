import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import type { PDFPageProxy } from 'pdfjs-dist';
import { applyImageEdits } from '../../src/editing/ImageEditApplier';
import { detectTextBlocks } from '../../src/editing/TextBlockDetector';
import { applyTextEdits } from '../../src/editing/TextEditApplier';
import { UNMAPPED_TEXT_EDIT_REASON, type PDFImage, type TextBlock, type TextEditOperation, type TextLayoutOptions } from '../../src/editing/types';
import { isSoftHyphenBreak } from '../../src/editing/ParagraphText';
import { useEditingStore } from '../../src/store/editingStore';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {
  save: 10, restore: 11, beginText: 31, endText: 32, setTextRenderingMode: 38,
  showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47,
  paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
} }));

const OBJECT: TextLayoutOptions = { keepBaseline: true, reflow: true, autoGrow: true, flow: 'object' };
const TIMES = '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>';
const toBuffer = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

/** Hand-written source pages for painting state that pdf-lib cannot express. */
function pdf(content: string, resources = '', extra: string[] = [], annots = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 4 0 R ${annots} /Resources << /Font << /F1 5 0 R >> ${resources} >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, TIMES, ...extra,
  ];
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length, entries = offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return toBuffer(new TextEncoder().encode(body));
}
const row = (y: number, text: string, state = '') => `BT /F1 12 Tf ${state} 40 ${y} Td (${text}) Tj ET`;

/** Rows read the way the editor reads them, from positioned glyphs in page coordinates. */
function detectRows(data: ArrayBuffer): TextBlock[] {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0), text = page.toStructuredText('');
  const rows: TextBlock[] = [];
  let line: { text: string; x: number; right: number; baseline: number; size: number } | undefined;
  try {
    text.walk({
      beginLine() { line = undefined; },
      onChar(character, origin, font, size, quad) {
        font.destroy();
        line ??= { text: '', x: origin[0], right: origin[0], baseline: origin[1], size };
        line.text += character; line.right = Math.max(quad[2], quad[6]);
      },
      endLine() {
        if (!line?.text.trim()) return;
        const { text, x, right, baseline, size } = line, top = baseline - size * .8;
        rows.push({ id: `row-${rows.length}`, pageNumber: 1, text, editable: true, kind: 'line',
          rect: { x, y: top, width: right - x, height: size },
          lines: [{ items: [], text, x, y: top, width: right - x, height: size, baseline }],
          style: { fontName: 'Times', fontSize: size, alignment: 'left', lineHeight: 1.2 } });
      },
    });
  } finally { text.destroy(); page.destroy(); document.destroy(); }
  return rows;
}
const edit = (block: TextBlock, newText: string, layout: TextLayoutOptions = OBJECT): TextEditOperation =>
  ({ blockId: block.id, originalText: block.text, newText, timestamp: 1, layout });
const save = async (data: ArrayBuffer, blocks: TextBlock[], edits: TextEditOperation[]) =>
  toBuffer(await applyTextEdits(data.slice(0), new Map([[1, blocks]]), edits));
function pageText(data: ArrayBuffer) {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0), text = page.toStructuredText('');
  try { return text.asText(); } finally { text.destroy(); page.destroy(); document.destroy(); }
}
/** The page's own content stream followed by every Form it draws, as a text search would read it. */
function operators(data: ArrayBuffer) {
  const document = new mupdf.PDFDocument(data.slice(0));
  try {
    let found = '';
    for (let id = 1; id < document.countObjects(); id++) {
      const object = document.newIndirect(id);
      try {
        if (!object.isStream()) continue;
        const stream = object.readStream();
        try { found += String.fromCharCode(...stream.asUint8Array()) + '\n'; } finally { stream.destroy(); }
      } catch { /* image and font programs are not content */ } finally { object.destroy(); }
    }
    return found;
  } finally { document.destroy(); }
}
/** Painted color at one point, on a white page. */
function pixelAt(data: ArrayBuffer, x: (pixels: Uint8Array, width: number, height: number) => number[]) {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try { return x(new Uint8Array(pixmap.getPixels()), pixmap.getWidth(), pixmap.getHeight()); }
  finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}
/** Darkest ink in a horizontal band, as RGB. */
const inkInBand = (data: ArrayBuffer, top: number, bottom: number) => pixelAt(data, (pixels, width) => {
  let best = [255, 255, 255];
  for (let y = top; y < bottom; y++) for (let column = 0; column < width; column++) {
    const offset = (y * width + column) * 3, rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    if (rgb[0] + rgb[1] + rgb[2] < best[0] + best[1] + best[2]) best = rgb;
  }
  return best;
});
function paints(data: ArrayBuffer) {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0);
  const found: { kind: 'fill' | 'stroke'; alpha: number; text: string }[] = [];
  const read = (kind: 'fill' | 'stroke', text: mupdf.Text, alpha: number) => {
    let value = '';
    text.walk({ showGlyph(_font, _matrix, _glyph, unicode) { if (unicode > 0) value += String.fromCodePoint(unicode); } });
    found.push({ kind, alpha, text: value });
  };
  const device = new mupdf.Device({
    fillText(text, _matrix, colorspace, _color, alpha) { try { read('fill', text, alpha); } finally { text.destroy(); colorspace.destroy(); } },
    strokeText(text, stroke, _matrix, colorspace, _color, alpha) { try { read('stroke', text, alpha); } finally { text.destroy(); stroke.destroy(); colorspace.destroy(); } },
  });
  try { page.runPageContents(device, mupdf.Matrix.identity); device.close(); return found; }
  finally { device.destroy(); page.destroy(); document.destroy(); }
}

describe('Type 1 source fonts', () => {
  const fixture = () => { const file = readFileSync('tests/fixtures/type1-font.pdf'); return toBuffer(new Uint8Array(file)); };

  it('stays behind its simple font: Type0 wrappers paint garbage in other readers', async () => {
    const data = fixture(), rows = detectRows(data), target = rows.find(item => item.text.startsWith('Plain'))!;
    const saved = await save(data, rows, [edit(target, 'Plain Type one row here')]);
    expect(pageText(saved)).toContain('Plain Type one row here');
    expect(pageText(saved)).toContain('Second row stays here');
    const document = new mupdf.PDFDocument(saved.slice(0));
    try {
      for (let id = 1; id < document.countObjects(); id++) {
        const object = document.newIndirect(id), subtype = object.get('Subtype');
        try {
          if (subtype.isName() && subtype.asName() === 'CIDFontType0') {
            const program = object.get('FontDescriptor', 'FontFile');
            try { expect(program.isNull()).toBe(true); } finally { program.destroy(); }
          }
        } finally { subtype.destroy(); object.destroy(); }
      }
    } finally { document.destroy(); }
  });

  it('survives saving, reopening and editing the same row again', async () => {
    const data = fixture(), rows = detectRows(data);
    const first = await save(data, rows, [edit(rows.find(item => item.text.startsWith('Plain'))!, 'Plain Type row')]);
    const again = detectRows(first), target = again.find(item => item.text === 'Plain Type row')!;
    expect(target).toBeDefined();
    const second = await save(first, again, [edit(target, 'Plain row')]);
    expect(pageText(second)).toContain('Plain row');
    expect(pageText(second)).not.toContain('Plain Type row');
    expect(pageText(second)).toContain('Second row stays here');
  });

  it('keeps Unicode for a fallback font that is reused after reopening', async () => {
    // Neither Z nor the space exists in this subset. Reading the saved fallback back
    // reports another program name, whose mapping used to be dropped from ToUnicode.
    const data = fixture(), rows = detectRows(data);
    const first = await save(data, rows, [edit(rows.find(item => item.text.startsWith('Second'))!, 'Second Zed here')]);
    const again = detectRows(first), target = again.find(item => item.text === 'Second Zed here')!;
    const second = await save(first, again, [edit(target, 'Second Zed Zed here')]);
    expect(pageText(second)).toContain('Second Zed Zed here');
    expect(Array.from(pageText(second)).filter(character => character.codePointAt(0)! < 32 && character !== '\n')).toEqual([]);
  });
});

describe('removing source rows', () => {
  const tight = pdf([100, 112, 124].map((y, index) => row(400 - y, `Tight row ${index} gypq`)).join('\n'));

  it('removes only the edited row of closely spaced text', async () => {
    const rows = detectRows(tight);
    const saved = await save(tight, rows, [edit(rows[1], '')]);
    expect(pageText(saved)).toContain('Tight row 0 gypq');
    expect(pageText(saved)).not.toContain('Tight row 1 gypq');
    expect(pageText(saved)).toContain('Tight row 2 gypq');
  });

  it('keeps links and widgets that overlap the edited row', async () => {
    const data = pdf(row(300, 'Linked row text'), '', ['<< /Type /Annot /Subtype /Link /Rect [40 290 200 312] /Border [0 0 0] /A << /S /URI /URI (https://example.com/kept) >> >>'], '/Annots [6 0 R]');
    const rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[0], 'Changed row text')]);
    const document = new mupdf.PDFDocument(saved.slice(0)), page = document.loadPage(0);
    try { expect(page.getLinks().map(link => link.getURI())).toEqual(['https://example.com/kept']); }
    finally { page.destroy(); document.destroy(); }
    expect(pageText(saved)).toContain('Changed row text');
  });

  it('edits a row that already runs past the page edge', async () => {
    const data = pdf(`BT /F1 12 Tf 360 300 Td (Runs past the edge) Tj ET\n${row(200, 'Inside the page')}`);
    const rows = detectRows(data), target = rows.find(item => item.text.startsWith('Runs'))!;
    const saved = await save(data, rows, [edit(target, 'Runs')]);
    expect(pageText(saved)).not.toContain('past the edge');
    expect(pageText(saved)).toContain('Runs');
  });
});

describe('source paint survives a rewrite', () => {
  const colored = (setColor: string, resources = '') => {
    const data = pdf(`BT /F1 24 Tf ${setColor} 40 300 Td (Colored line) Tj ET`, resources);
    return { data, rows: detectRows(data) };
  };
  const band = [80, 110] as const;
  const separation = `/ColorSpace << /S [/Separation /Spot /DeviceCMYK << /FunctionType 2 /Domain [0 1] /N 1 /C0 [0 0 0 0] /C1 [1 .2 0 0] >>] >>`;

  it.each([
    ['Separation', '/S cs 1 scn', separation],
    ['Lab', '/L cs 50 60 30 scn', '/ColorSpace << /L [/Lab << /WhitePoint [.9642 1 .8249] /Range [-128 127 -128 127] >>] >>'],
    ['CMYK', '1 0 0 0 k', ''],
    ['Gray', '.5 g', ''],
    ['RGB', '.8 .1 .2 rg', ''],
  ])('keeps %s text the color the page showed', async (_name, setColor, resources) => {
    const { data, rows } = colored(setColor, resources);
    const before = inkInBand(data, ...band);
    expect(before.some(value => value < 250)).toBe(true);
    const after = inkInBand(await save(data, rows, [edit(rows[0], 'Colored text')]), ...band);
    after.forEach((value, index) => expect(Math.abs(value - before[index])).toBeLessThan(6));
  });

  it('keeps fill transparency', async () => {
    const { data, rows } = colored('/G gs', '/ExtGState << /G << /ca .5 >> >>');
    const saved = await save(data, rows, [edit(rows[0], 'Colored text')]);
    const fill = paints(saved).find(item => item.kind === 'fill' && item.text.includes('Colored'))!;
    expect(fill.alpha).toBeCloseTo(.5, 2);
  });

  it('keeps outlined text outlined', async () => {
    const { data, rows } = colored('0 0 1 RG .5 w 1 Tr');
    const saved = await save(data, rows, [edit(rows[0], 'Colored text')]);
    const found = paints(saved).filter(item => item.text.includes('Colored'));
    expect(found.some(item => item.kind === 'stroke')).toBe(true);
    expect(found.some(item => item.kind === 'fill')).toBe(false);
  });

  it('keeps filled and stroked text as one row with both paints', async () => {
    const { data, rows } = colored('0 0 1 RG 1 0 0 rg .5 w 2 Tr');
    const saved = await save(data, rows, [edit(rows[0], 'Colored text')]);
    const found = paints(saved).filter(item => item.text.includes('Colored'));
    expect(found.map(item => item.kind).sort()).toEqual(['fill', 'stroke']);
  });
});

describe('print colors', () => {
  const separation = '/ColorSpace << /S [/Separation /Spot /DeviceCMYK << /FunctionType 2 /Domain [0 1] /N 1 /C0 [0 0 0 0] /C1 [1 0 0 0] >>] >>';
  const rewrite = async (setColor: string, resources = '') => {
    const data = pdf(`BT /F1 24 Tf ${setColor} 40 300 Td (Colored line) Tj ET`, resources), rows = detectRows(data);
    return operators(await save(data, rows, [edit(rows[0], 'Colored text')]));
  };

  it('keeps black as a single ink rather than converting it to RGB', async () => {
    expect(await rewrite('0 g')).toMatch(/(^|\s)0 g\s/);
  });
  it('keeps CMYK inks', async () => {
    expect(await rewrite('.1 .2 .3 .4 k')).toMatch(/0\.1 0\.2 0\.3 0\.4 k\s/);
  });
  it('keeps a spot color resource', async () => {
    expect(await rewrite('/S cs .5 scn', separation)).toMatch(/\/PDFEditorColor0 cs 0\.5 scn/);
  });
  it('does not confuse two colors that display identically', async () => {
    const data = pdf(`BT /F1 24 Tf /S cs 1 scn 40 300 Td (Spot line) Tj ET\nBT /F1 24 Tf 1 0 0 0 k 40 200 Td (Process line) Tj ET`, separation), rows = detectRows(data);
    const target = rows.find(item => item.text === 'Process line')!;
    const content = operators(await save(data, rows, [edit(target, 'Process text')]));
    expect(content).toMatch(/1 0 0 0 k\s/);
    expect(content).not.toContain('PDFEditorColor');
  });
  it('writes the color a user chose, not the source ink', async () => {
    const data = pdf('BT /F1 24 Tf 1 0 0 0 k 40 300 Td (Colored line) Tj ET'), rows = detectRows(data);
    const content = operators(await save(data, rows, [edit(rows[0], 'Colored text', { ...OBJECT, fontColor: '#ff0000' })]));
    expect(content).not.toMatch(/1 0 0 0 k\s+BT/);
    expect(content).toMatch(/1 0 0 rg/);
  });
});

describe('reading order and stacking', () => {
  const order = (data: ArrayBuffer) => pageText(data).split('\n').map(item => item.trim()).filter(Boolean);

  it('keeps an edited row between its neighbors', async () => {
    const data = pdf([row(300, 'First row'), row(280, 'Second row'), row(260, 'Third row')].join('\n')), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[1], 'Second row edited')]);
    expect(order(saved)).toEqual(['First row', 'Second row edited', 'Third row']);
  });
  it('keeps order when one text object holds every row', async () => {
    const data = pdf('BT /F1 12 Tf 40 300 Td (First row) Tj 0 -20 Td (Second row) Tj 0 -20 Td (Third row) Tj ET'), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[1], 'Second row edited')]);
    expect(order(saved)).toEqual(['First row', 'Second row edited', 'Third row']);
    expect(inkInBand(saved, 95, 100).some(value => value < 128)).toBe(true); // Third row's position survived the split
  });
  it('keeps the last row of a text object in place', async () => {
    const data = pdf('BT /F1 12 Tf 40 300 Td (First row) Tj 0 -20 Td (Second row) Tj ET\nBT /F1 12 Tf 40 260 Td (Third row) Tj ET'), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[1], 'Second row edited')]);
    expect(order(saved)).toEqual(['First row', 'Second row edited', 'Third row']);
  });
  it('stays near its neighbors when one run holds two columns', async () => {
    const data = pdf(`${row(320, 'First row')}\nBT /F1 12 Tf 40 280 Td [(Left col) -12000 (Right col)] TJ ET\n${row(240, 'Last row')}`), rows = detectRows(data);
    const target = rows.find(item => item.text === 'Right col')!;
    const saved = await save(data, rows, [edit(target, 'Right column')]);
    const lines = order(saved);
    expect(lines.indexOf('Right column')).toBeLessThan(lines.indexOf('Last row'));
    expect(lines.indexOf('First row')).toBeLessThan(lines.indexOf('Right column'));
  });
  it('leaves no row markers behind when nothing is drawn', async () => {
    const data = pdf([row(300, 'First row'), row(260, 'Third row')].join('\n')), rows = detectRows(data);
    const blank = await save(data, rows, [edit(rows[0], ' ')]);
    expect(operators(blank)).not.toContain('PDFEditorAnchor');
    expect(operators(await save(data, rows, [edit(rows[0], 'First row edited')]))).not.toContain('PDFEditorAnchor');
    expect(pageText(blank)).not.toContain('First row');
  });
  it('keeps text under artwork that covered it', async () => {
    const cover = '1 0 0 rg 30 290 200 30 re f';
    const data = pdf(`${row(300, 'Covered row')}\n${cover}`), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[0], 'Covered text')]);
    const pixels = pixelAt(saved, (values, width) => { let dark = 0; for (let y = 85; y < 105; y++) for (let x = 40; x < 120; x++) if (values[(y * width + x) * 3] < 100) dark++; return [dark]; });
    expect(pixels[0]).toBe(0);
  });
  it('puts a moved row on top of what it was moved over', async () => {
    const data = pdf(`${row(300, 'Moved row')}\n1 0 0 rg 200 190 150 30 re f`), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[0], 'Moved row', { keepBaseline: true, translate: true, autoGrow: false, targetRect: { ...rows[0].rect, x: 210, y: 192 } })]);
    const pixels = pixelAt(saved, (values, width) => { let dark = 0; for (let y = 190; y < 210; y++) for (let x = 210; x < 290; x++) if (values[(y * width + x) * 3] < 100) dark++; return [dark]; });
    expect(pixels[0]).toBeGreaterThan(0);
  });
  it('does not let replacement text inherit an earlier state of the page', async () => {
    // Character spacing outlives a text object, so every later row is tracked too.
    const data = pdf(`BT /F1 12 Tf 4 Tc 40 340 Td (Tracked) Tj ET\n/G gs\n${row(260, 'Plain row')}\n/N gs\n${row(180, 'Last row')}`, '/ExtGState << /G << /ca .3 >> /N << /ca 1 >> >>'), rows = detectRows(data);
    const target = rows.at(-1)!;
    const saved = await save(data, rows, [edit(target, 'Last rows')]);
    const fill = paints(saved).find(item => item.text.includes('Last rows'))!;
    expect(fill.alpha).toBe(1);
    const written = detectRows(saved).find(item => Math.abs(item.rect.y - target.rect.y) < 2)!;
    expect(written.rect.width).toBeLessThan(target.rect.width + 15); // one more tracked letter, not tracked twice
  });
  it('stays visible when the source sat inside a clip', async () => {
    const data = pdf(`q 30 290 60 30 re W n ${row(300, 'Clipped row of text')} Q`), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[0], 'Clipped row')]);
    expect(pageText(saved)).toContain('Clipped row');
  });
});

describe('Type 3 fonts', () => {
  const glyph = (height: number) => `500 0 0 0 400 ${height} d1 0 0 400 ${height} re f`;
  const font = (data: string[]) => data;
  const page = () => pdf('BT /T3 12 Tf 40 300 Td (abc abc) Tj ET', '', font([
    '<< /Type /Font /Subtype /Type3 /Name /Blocks /FontBBox [0 0 500 800] /FontMatrix [.001 0 0 .001 0 0] /FirstChar 32 /LastChar 99 /Widths 8 0 R /Encoding 7 0 R /CharProcs 9 0 R >>',
    '<< /Type /Encoding /Differences [32 /space 97 /a /b /c] >>',
    `[${Array.from({ length: 68 }, () => 500).join(' ')}]`,
    '<< /space 10 0 R /a 11 0 R /b 12 0 R /c 13 0 R >>',
    ...['500 0 d0', glyph(800), glyph(500), glyph(300)].map(procedure => `<< /Length ${procedure.length} >>\nstream\n${procedure}\nendstream`),
  ]));
  const withFont = (data: ArrayBuffer) => {
    // The fixture helper only declares /F1; add the Type 3 font under the name the page uses.
    const text = new TextDecoder('latin1').decode(data);
    return toBuffer(pdfWithType3(text));
  };

  it('rewrites a row through the original font and survives reopening', async () => {
    const data = withFont(page()), rows = detectRows(data);
    expect(rows[0].text).toBe('abc abc');
    const saved = await save(data, rows, [edit(rows[0], 'cab abc')]);
    expect(pageText(saved)).toContain('cab abc');
    expect(pageText(saved).match(/cab abc/g)).toHaveLength(1);
    // Check the actual outlines, not just the text mapping or drawing callbacks.
    // The reference uses the source font to paint the expected new codes directly.
    const expected = toBuffer(new TextEncoder().encode(new TextDecoder().decode(data).replace('(abc abc)', '(cab abc)')));
    const rowInk = (bytes: ArrayBuffer) => pixelAt(bytes, (pixels, width) => {
      const selected: number[] = [];
      for (let y = 89; y < 102; y++) for (let x = 39; x < 84; x++) {
        const offset = (y * width + x) * 3; selected.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      }
      return selected;
    });
    expect(rowInk(saved)).toEqual(rowInk(expected));
    const again = detectRows(saved);
    const second = await save(saved, again, [edit(again.find(item => item.text === 'cab abc')!, 'cab')]);
    expect(pageText(second)).toContain('cab');
    expect(pageText(second)).not.toContain('cab abc');
  });
  it('uses a fallback font for a letter it has never drawn', async () => {
    const data = withFont(page()), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows[0], 'abc XYZ')]);
    expect(pageText(saved)).toContain('abc XYZ');
  });
});
function pdfWithType3(source: string) {
  // Offsets change with the added resource, so rebuild from the object list.
  const objects = [...source.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map(match => match[1]);
  objects[2] = objects[2].replace('/Font << /F1 5 0 R >>', '/Font << /F1 5 0 R /T3 6 0 R >>');
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(body, character => character.charCodeAt(0));
}

describe('hyphens at row ends', () => {
  it('does not infer discretionary hyphens from literal compound words', () => {
    for (const row of ['uses an al-', 'a well-', 'state-of-the-', 'English-', 'Section-', 'literal\u2010']) {
      expect(isSoftHyphenBreak(row)).toBe(false);
    }
    expect(isSoftHyphenBreak('ragged soft\u00ad')).toBe(true);
  });

  it('preserves a literal line-end hyphen when reflow stops splitting the word', async () => {
    const rows = ['The quick brown al-', 'ternative route ran'];
    const data = pdf(rows.map((text, index) => row(300 - index * 14, text)).join('\n'));
    const measured = detectRows(data);
    const block: TextBlock = { id: 'hyphen', pageNumber: 1, text: rows.join('\n'), editable: true, kind: 'paragraph',
      rect: { x: 40, y: measured[0].rect.y, width: 300, height: 26 },
      lines: measured.map(item => item.lines[0]),
      style: { fontName: 'Times', fontSize: 12, alignment: 'justify', lineHeight: 14 / 12 } };
    const flow: TextLayoutOptions = { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' };
    const saved = await save(data, [block], [edit(block, 'The brown al-ternative route ran', flow)]);
    expect(pageText(saved).replace(/\s+/g, ' ')).toContain('The brown al-ternative route ran');
  });
});

describe('rows already past the page edge', () => {
  it('stay one row when text is added', async () => {
    const data = pdf(`BT /F1 12 Tf 330 300 Td (Runs past the edge) Tj ET\n${row(286, 'Row below it')}`), rows = detectRows(data);
    const saved = await save(data, rows, [edit(rows.find(item => item.text.startsWith('Runs'))!, 'Runs past the edge more')]);
    const baselines = new Set<number>();
    const document = new mupdf.PDFDocument(saved.slice(0)), page = document.loadPage(0), text = page.toStructuredText('');
    try { text.walk({ onChar(character, origin, font) { font.destroy(); if ('Runspastedgmo'.includes(character) && origin[0] >= 330) baselines.add(Math.round(origin[1])); } }); }
    finally { text.destroy(); page.destroy(); document.destroy(); }
    expect([...baselines]).toEqual([100]);
  });
});

describe('source spacing', () => {
  it('keeps every tracked letter where it was', async () => {
    // PDF.js extracts tracked text with a space between letters; only one is a real space.
    const data = pdf(`BT /F1 12 Tf 3 Tc 40 300 Td (Tracked out) Tj ET`);
    const positions = (buffer: ArrayBuffer) => {
      const document = new mupdf.PDFDocument(buffer.slice(0)), page = document.loadPage(0), structured = page.toStructuredText('');
      const glyphs: { character: string; x: number }[] = [];
      try {
        structured.walk({ onChar(character, origin, font) { font.destroy(); if (character.trim()) glyphs.push({ character, x: origin[0] }); } });
        return glyphs;
      } finally { structured.destroy(); page.destroy(); document.destroy(); }
    };
    const source = positions(data), text = 'T r a c k e d o u t';
    const width = source.at(-1)!.x + 10 - source[0].x, baseline = 100;
    const block: TextBlock = { id: 'tracked', pageNumber: 1, text, editable: true, kind: 'line',
      rect: { x: 40, y: baseline - 10, width, height: 12 },
      lines: [{ items: [], text, x: 40, y: baseline - 10, width, height: 12, baseline }],
      style: { fontName: 'Times', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
    const saved = await save(data, [block], [edit(block, 'T r a c k e d o u')]);
    const result = positions(saved);
    expect(result.map(glyph => glyph.character).join('')).toBe('Trackedou');
    result.forEach((glyph, index) => expect(glyph.x).toBeCloseTo(source[index].x, 1));
  });
});

describe('text without Unicode data', () => {
  const content = (items: string[]) => ({ pageNumber: 1, userUnit: 1,
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 600 - y] }),
    getTextContent: async () => ({ items: items.map((str, index) => ({ str, transform: [12, 0, 0, 12, 40, 500 - index * 40], width: str.length * 6, height: 12, fontName: 'f1' })), styles: { f1: { fontFamily: 'serif' } } }),
  } as unknown as PDFPageProxy);

  it('locks rows that extract as raw codes and leaves the rest of the page editable', async () => {
    const blocks = await detectTextBlocks(content(['5RZ\u0003ZLWK\u0003VSDFHV', 'Readable row']), 'line');
    expect(blocks[0].editable).toBe(false);
    expect(blocks[0].unsupportedReason).toBe(UNMAPPED_TEXT_EDIT_REASON);
    expect(blocks[1].editable).toBe(true);
  });

  it('redraws the painted outlines, not the letters the raw codes spell', async () => {
    // A writer output has Identity-H codes; dropping ToUnicode leaves MuPDF with U+FFFD.
    const output = new mupdf.Buffer(), writer = new mupdf.DocumentWriter(output, 'pdf', '');
    const device = writer.beginPage([0, 0, 400, 400]), text = new mupdf.Text(), font = new mupdf.Font('Times-Roman');
    let x = 40;
    for (const character of 'Third') {
      const glyph = font.encodeCharacter(character.codePointAt(0)!);
      text.showGlyph(font, [12, 0, 0, -12, x, 100], glyph, character.codePointAt(0)!);
      x += font.advanceGlyph(glyph) * 12;
    }
    device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    device.close(); writer.endPage(); writer.close();
    text.destroy(); device.destroy();
    const document = new mupdf.PDFDocument(output);
    for (let id = 1; id < document.countObjects(); id++) {
      const object = document.newIndirect(id), unicode = object.get('ToUnicode');
      if (!unicode.isNull()) object.delete('ToUnicode');
      unicode.destroy(); object.destroy();
    }
    const raw = document.saveToBuffer('');
    const data = toBuffer(raw.asUint8Array().slice());
    raw.destroy(); document.destroy(); output.destroy(); writer.destroy();
    const before = inkRows(data);
    const shown = 'wxyzQ', width = x - 40;
    const block: TextBlock = { id: 'raw', pageNumber: 1, text: shown, editable: true, kind: 'line',
      rect: { x: 40, y: 90, width, height: 12 },
      lines: [{ items: [], text: shown, x: 40, y: 90, width, height: 12, baseline: 100 }],
      style: { fontName: 'Times', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
    const saved = await save(data, [block], [edit(block, 'wxyzQ', { ...OBJECT, targetRect: { ...block.rect, y: 190 }, translate: true, autoGrow: false })]);
    // The same outlines appear 100 points lower: identical ink, shifted.
    expect(inkRows(saved, 100)).toEqual(before);
    font.destroy();
  });
});
function inkRows(data: ArrayBuffer, shift = 0) {
  return pixelAt(data, (pixels, width) => {
    const rows: number[] = [];
    for (let y = 85 + shift; y < 105 + shift; y++) {
      let count = 0;
      for (let column = 0; column < width; column++) if (pixels[(y * width + column) * 3] < 128) count++;
      rows.push(count);
    }
    return rows;
  });
}

describe('reverting and object growth', () => {
  it('drops the edit when the text is typed back to the original', () => {
    const text = 'First row\nSecond row';
    const block: TextBlock = { id: 'revert', pageNumber: 1, text, editable: true,
      rect: { x: 40, y: 88, width: 120, height: 30 },
      lines: [{ items: [], text: 'First row', x: 40, y: 88, width: 60, height: 12, baseline: 100 }, { items: [], text: 'Second row', x: 40, y: 104, width: 60, height: 12, baseline: 116 }],
      style: { fontName: 'Times', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
    const store = useEditingStore.getState();
    store.clearAll();
    store.setTextBlocks(1, [block]);
    store.updateBlockText(block.id, 'First row Second row changed', undefined, { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' });
    expect(useEditingStore.getState().textEdits).toHaveLength(1);
    useEditingStore.getState().updateBlockText(block.id, 'First row Second row', undefined, { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' });
    expect(useEditingStore.getState().textEdits).toHaveLength(0);
    useEditingStore.getState().clearAll();
  });

  it('keeps a grown single-row object on one row', async () => {
    const data = pdf(`${row(300, 'Short')}\n${row(286, 'Next row stays')}`);
    const rows = detectRows(data), target = rows.find(item => item.text === 'Short')!;
    const saved = await save(data, rows, [edit(target, 'Short row with many more words')]);
    const text = pageText(saved);
    expect(text).toContain('Short row with many more words');
    expect(text).toContain('Next row stays');
  });
});

describe('unbalanced content streams', () => {
  it('moves an image in a page with an extra restore and an unclosed save', async () => {
    const pixels = 'ff0000'.repeat(4);
    const data = pdf(`Q\nq 50 0 0 50 40 300 cm /I1 Do Q\nq\n${row(100, 'After the image')}\n]`, '/XObject << /I1 6 0 R >>',
      [`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`]);
    const rect = { x: 40, y: 50, width: 50, height: 50 };
    const image: PDFImage = { id: 'image', pageNumber: 1, objectName: 'I1', rect, originalRect: { ...rect },
      source: { transform: [50, 0, 0, 50, 40, 300], occurrence: 0, occurrenceCount: 1, pixelWidth: 2, pixelHeight: 2, insideForm: false } };
    const saved = toBuffer(await applyImageEdits(data.slice(0), new Map([[1, [image]]]), [{ type: 'move', imageId: 'image', newRect: { ...rect, x: 200 }, timestamp: 1 }]));
    const red = (x: number, y: number) => pixelAt(saved, (values, width) => Array.from(values.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)));
    expect(red(220, 75)).toEqual([255, 0, 0]);
    expect(red(60, 75)).toEqual([255, 255, 255]);
    expect(pageText(saved)).toContain('After the image');
  });
});
