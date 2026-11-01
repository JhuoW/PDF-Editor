import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { NativeSourceFontCatalog } from '../../src/editing/NativeSourceFonts';
import { applyTextEdits } from '../../src/editing/TextEditApplier';
import type { TextBlock } from '../../src/editing/types';

vi.mock('pdfjs-dist', () => ({ AnnotationMode: { DISABLE: 0 }, OPS: {} }));

const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const fixture = () => buffer(new Uint8Array(readFileSync('tests/fixtures/type1-font.pdf')));

function rows(data: ArrayBuffer): TextBlock[] {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0), text = page.toStructuredText('');
  const blocks: TextBlock[] = [];
  let current: { text: string; x: number; right: number; baseline: number; size: number; name: string } | undefined;
  try {
    text.walk({
      beginLine() { current = undefined; },
      onChar(character, origin, font, size, quad) {
        try {
          current ??= { text: '', x: origin[0], right: origin[0], baseline: origin[1], size, name: font.getName() };
          current.text += character; current.right = Math.max(current.right, quad[2], quad[6]);
        } finally { font.destroy(); }
      },
      endLine() {
        if (!current?.text.trim()) return;
        const { text, x, right, baseline, size, name } = current, y = baseline - size * .8;
        blocks.push({ id: `row-${blocks.length}`, pageNumber: 1, kind: 'line', editable: true, text,
          rect: { x, y, width: right - x, height: size },
          lines: [{ items: [], text, x, y, width: right - x, height: size, baseline }],
          style: { fontName: name, fontSize: size, alignment: 'left', lineHeight: 1.2 } });
      },
    });
    return blocks;
  } finally { text.destroy(); page.destroy(); document.destroy(); }
}

async function replace(data: ArrayBuffer, index: number, text: string) {
  const blocks = rows(data), block = blocks[index];
  return buffer(await applyTextEdits(data.slice(0), new Map([[1, blocks]]), [{ blockId: block.id, originalText: block.text, newText: text, timestamp: 1,
    layout: { flow: 'object', reflow: true, autoGrow: true, keepBaseline: true } }]));
}

/** Compare real outlines inside the rewritten row. Correct ToUnicode alone cannot pass. */
function ink(data: ArrayBuffer, rect: [number, number, number, number]) {
  const document = new mupdf.PDFDocument(data.slice(0)), page = document.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    const pixels = pixmap.getPixels(), selected: number[] = [];
    for (let y = rect[1] * 3; y < rect[3] * 3; y++) for (let x = rect[0] * 3; x < rect[2] * 3; x++) {
      const offset = y * pixmap.getStride() + x * 3;
      selected.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    }
    expect(selected.some(value => value < 100)).toBe(true);
    return selected;
  } finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}

function type3Document(sameName: boolean, code = 97) {
  const document = new mupdf.PDFDocument();
  const create = (name: string, height: number) => {
    const drawing = document.addStream(`500 0 0 0 400 ${height} d1 0 0 400 ${height} re f`, {});
    try { return document.addObject({ Type: 'Font', Subtype: 'Type3', Name: name,
      FontBBox: [0, 0, 500, 800], FontMatrix: [.001, 0, 0, .001, 0, 0], FirstChar: code, LastChar: code,
      Widths: [500], Encoding: { Type: 'Encoding', Differences: [code, 'a'] }, CharProcs: { a: drawing } }); }
    finally { drawing.destroy(); }
  };
  const first = create('First', 800), second = create(sameName ? 'First' : 'Second', 300), resources = document.newDictionary();
  try {
    resources.put('Font', { F1: first, F2: second });
    const hex = code.toString(16).padStart(2, '0');
    const page = document.addPage([0, 0, 400, 400], 0, resources,
      `BT /F1 20 Tf 40 300 Td <${hex}> Tj ET BT /F2 20 Tf 40 250 Td <${hex}> Tj ET`);
    try { document.insertPage(0, page); } finally { page.destroy(); }
    const saved = document.saveToBuffer('');
    try { return buffer(new Uint8Array(saved.asUint8Array())); } finally { saved.destroy(); }
  } finally { resources.destroy(); first.destroy(); second.destroy(); document.destroy(); }
}

function aliasedType1Document() {
  const document = new mupdf.PDFDocument(fixture()), page = document.findPage(0), resources = page.getInheritable('Resources'), font = resources.get('Font', 'F28');
  const cmap = document.addStream('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Aliases def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 2 beginbfchar <61> <0061> <41> <0391> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end', {});
  const contents = document.addStream('BT /F28 12 Tf 40 700 Td <6141> Tj ET BT /F28 12 Tf 40 640 Td <6141> Tj ET', {});
  try {
    const widths = font.get('Widths'), expanded = document.newArray();
    try {
      for (let code = 65; code < 80; code++) expanded.push(code === 65 ? 500 : 0);
      widths.forEach(value => { try { expanded.push(value); } finally { value.destroy(); } });
      font.put('FirstChar', 65); font.put('Widths', expanded);
    } finally { expanded.destroy(); widths.destroy(); }
    font.put('Encoding', { Type: 'Encoding', Differences: [65, 'a'] }); font.put('ToUnicode', cmap); page.put('Contents', contents);
    const saved = document.saveToBuffer('');
    try { return buffer(new Uint8Array(saved.asUint8Array())); } finally { saved.destroy(); }
  } finally { contents.destroy(); cmap.destroy(); font.destroy(); resources.destroy(); page.destroy(); document.destroy(); }
}

describe('source font outline identity', () => {
  it('preserves Type 1 outlines inside edited text across fallback insertion and repeated saves', async () => {
    const source = fixture(), prefix: [number, number, number, number] = [132, 124, 182, 139];
    const originalInk = ink(source, prefix);
    const first = await replace(source, 0, 'Plain Type one row Zed 中文');
    expect(ink(first, prefix)).toEqual(originalInk);
    const editedIndex = rows(first).findIndex(row => row.text.startsWith('Plain Type'));
    const second = await replace(first, editedIndex, 'Plain Type one row Zed 中文 two');
    expect(ink(second, prefix)).toEqual(originalInk);
    expect(rows(second).map(row => row.text).join(' ')).toContain('Plain Type one row Zed 中文 two');
  });

  it('keeps distinct Unicode aliases of one native glyph without changing untouched source mappings', async () => {
    const source = aliasedType1Document(), prefix: [number, number, number, number] = [39, 132, 52, 145];
    expect(rows(source).map(row => row.text)).toEqual(['aΑ', 'aΑ']);
    const first = await replace(source, 0, 'aΑa');
    expect(rows(first).map(row => row.text)).toEqual(['aΑa', 'aΑ']);
    expect(ink(first, prefix)).toEqual(ink(source, prefix));
    const second = await replace(first, 0, 'aΑaΑ');
    expect(rows(second).map(row => row.text)).toEqual(['aΑaΑ', 'aΑ']);
    expect(ink(second, prefix)).toEqual(ink(source, prefix));
  });

  it.each([false, true])('distinguishes Type 3 programs with equal advances (same name: %s)', sameName => {
    const document = new mupdf.PDFDocument(type3Document(sameName)), page = document.loadPage(0), catalog = new NativeSourceFontCatalog(mupdf);
    const pageObject = page.getObject(), resources = pageObject.getInheritable('Resources');
    const first = resources.get('Font', 'F1'), second = resources.get('Font', 'F2'), text = page.toStructuredText('');
    const found: number[] = [];
    try {
      text.walk({ onChar(_character, _origin, font) {
        try { found.push(catalog.find(page, font)!.object.asIndirect()); } finally { font.destroy(); }
      } });
      expect(found).toEqual([first.asIndirect(), second.asIndirect()]);
    } finally { text.destroy(); second.destroy(); first.destroy(); resources.destroy(); pageObject.destroy(); catalog.destroy(); page.destroy(); document.destroy(); }
  });

  it.each([false, true])('keeps the correct Type 3 outline after editing (same name: %s)', async sameName => {
    const source = type3Document(sameName), secondGlyph: [number, number, number, number] = [39, 132, 49, 151];
    const output = await replace(source, 1, 'aa');
    expect(ink(output, secondGlyph)).toEqual(ink(source, secondGlyph));
    expect(rows(output)[1].text).toBe('aa');
  });

  it('retains a real Type 3 glyph at code zero while unseen letters use a fallback', async () => {
    const source = type3Document(false, 0), originalGlyph: [number, number, number, number] = [39, 132, 49, 151];
    expect(rows(source).map(row => row.text)).toEqual(['a', 'a']);
    const first = await replace(source, 1, 'aa Z');
    expect(ink(first, originalGlyph)).toEqual(ink(source, originalGlyph));
    expect(rows(first).map(row => row.text)).toEqual(['a', 'aa Z']);
    const second = await replace(first, 1, 'aa Z a');
    expect(ink(second, originalGlyph)).toEqual(ink(source, originalGlyph));
    expect(rows(second).map(row => row.text)).toEqual(['a', 'aa Z a']);
  });
});
