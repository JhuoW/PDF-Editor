import type { Color, Font, PDFDocument, PDFObject, PDFWidget } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface Glyph { character: string; font: Font; advance: number }

function copyDictionary(document: PDFDocument, source: PDFObject) {
  const result = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => result.put(key, value));
  return result;
}

function wrap(glyphs: Glyph[], width: number): Glyph[][] {
  if (!glyphs.length) return [[]];
  const lines: Glyph[][] = [];
  let line: Glyph[] = [];
  let used = 0;
  for (const glyph of glyphs) {
    if (line.length && used + glyph.advance > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(glyph);
    used += glyph.advance;
  }
  lines.push(line);
  return lines;
}

function graftTextResources(document: PDFDocument, source: PDFObject, embeddedFonts: Map<string, PDFObject>) {
  const resources = document.newDictionary();
  const fontResources = document.newDictionary();
  source.forEach((value, key) => {
    if (key !== 'Font') resources.put(key, document.graftObject(value));
  });
  source.get('Font').forEach((font, key) => {
    // These resources come only from our two fixed engine fonts. DocumentWriter
    // embeds their full Identity-H glyph maps, so every widget can reuse them.
    const name = font.get('BaseFont').asName();
    if (!embeddedFonts.has(name)) embeddedFonts.set(name, document.graftObject(font));
    fontResources.put(key, embeddedFonts.get(name)!);
  });
  resources.put('Font', fontResources);
  fontResources.destroy();
  return resources;
}

function setAppearance(engine: Engine, document: PDFDocument, widget: PDFWidget, value: string, fonts: Font[], embeddedFonts: Map<string, PDFObject>) {
  // These scripts require shaping or bidirectional layout. An unshaped glyph
  // sequence would be misleading even when individual glyphs exist in a font.
  const normalized = value.normalize('NFC');
  const complexRanges = [[0x0590, 0x109f], [0x1780, 0x18af], [0x200c, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xa980, 0xa9df], [0xaa60, 0xaa7f], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
  if (/\p{M}/u.test(normalized) || Array.from(normalized).some(character => {
    const code = character.codePointAt(0)!;
    return complexRanges.some(([start, end]) => code >= start && code <= end);
  })) {
    throw new Error(`Form field "${widget.getName()}" contains text that requires complex-script layout, which is not supported yet. The field was not exported with missing or reordered characters.`);
  }
  const object = widget.getObject();
  const appearance = object.get('AP', 'N');
  if (!appearance.isStream()) throw new Error(`Form field "${widget.getName()}" has no writable appearance.`);
  const bbox = Array.from({ length: 4 }, (_, index) => appearance.get('BBox', index).asNumber());
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const rotation = ((object.get('MK', 'R').asNumber() % 360) + 360) % 360;
  const logicalWidth = rotation % 180 ? height : width;
  const logicalHeight = rotation % 180 ? width : height;
  const padding = Math.max(2, widget.getBorderWidth() + 1);
  const availableWidth = logicalWidth - padding * 2;
  const availableHeight = logicalHeight - padding * 2;
  if (availableWidth <= 0 || availableHeight <= 0) throw new Error(`Form field "${widget.getName()}" is too small to display its value.`);

  const displayed = widget.isPassword() ? Array.from(normalized, () => '•').join('') : normalized;
  const paragraphs = displayed.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n').map(paragraph => Array.from(paragraph, character => {
    const font = fonts.find(candidate => candidate.encodeCharacter(character) !== 0);
    if (!font) throw new Error(`Form field "${widget.getName()}" contains an unsupported character ${JSON.stringify(character)}. No value was discarded.`);
    return { character, font, advance: font.advanceGlyph(font.encodeCharacter(character)) };
  }));
  if (!widget.isMultiline() && paragraphs.length > 1) throw new Error(`Form field "${widget.getName()}" is single-line; remove the line breaks or use a multiline field.`);
  const defaults = widget.getDefaultAppearance();
  let size = Math.min(defaults.size > 0 ? defaults.size : 12, availableHeight / 1.2);
  const maxLength = widget.getMaxLen();
  const comb = widget.isComb() && maxLength > 0;
  if (comb && paragraphs[0].length > maxLength) throw new Error(`Form field "${widget.getName()}" exceeds its ${maxLength}-character limit.`);
  const longest = Math.max(...paragraphs.map(line => line.reduce((sum, glyph) => sum + glyph.advance, 0)), 0.01);
  if (!widget.isMultiline()) size = Math.min(size, availableWidth / longest);
  if (comb) size = Math.min(size, availableWidth / maxLength / Math.max(...paragraphs[0].map(glyph => glyph.advance), 0.01));
  let lines = paragraphs;
  // Reflow when shrinking multiline fields, so every character remains visible.
  for (;;) {
    lines = widget.isMultiline() ? paragraphs.flatMap(line => wrap(line, availableWidth / size)) : paragraphs;
    const maxLineWidth = Math.max(...lines.map(line => line.reduce((sum, glyph) => sum + glyph.advance, 0)), 0);
    if (lines.length * size * 1.2 <= availableHeight + 0.01 && maxLineWidth * size <= availableWidth + 0.01) break;
    size *= 0.9;
    if (size < 1) throw new Error(`Form field "${widget.getName()}" has too much text to display legibly. Shorten its value; no text was truncated.`);
  }
  if (size < 1) throw new Error(`Form field "${widget.getName()}" has too much text to display legibly. Shorten its value; no text was truncated.`);

  const output = new engine.Buffer();
  const writer = new engine.DocumentWriter(output, 'pdf', '');
  let overlay: PDFDocument | undefined;
  try {
    const device = writer.beginPage([0, 0, logicalWidth, logicalHeight]);
    try {
      for (const [lineNumber, glyphs] of lines.entries()) {
        const lineWidth = glyphs.reduce((sum, glyph) => sum + glyph.advance * size, 0);
        const alignment = widget.getQuadding();
        let x = padding + (alignment === 1 ? (availableWidth - lineWidth) / 2 : alignment === 2 ? availableWidth - lineWidth : 0);
        const baseline = widget.isMultiline() ? padding + size + lineNumber * size * 1.2 : (logicalHeight + size * 0.7) / 2;
        const text = new engine.Text();
        try {
          for (const [index, glyph] of glyphs.entries()) {
            if (comb) x = padding + (index + 0.5) * availableWidth / maxLength - glyph.advance * size / 2;
            text.showGlyph(glyph.font, [size, 0, 0, -size, x, baseline], glyph.font.encodeCharacter(glyph.character), glyph.character.codePointAt(0)!);
            x += glyph.advance * size;
          }
          const color: Color = defaults.color.length === 0 ? [0, 0, 0] : defaults.color;
          const colorSpace = color.length === 1 ? engine.ColorSpace.DeviceGray : color.length === 4 ? engine.ColorSpace.DeviceCMYK : engine.ColorSpace.DeviceRGB;
          device.fillText(text, engine.Matrix.identity, colorSpace, color, 1);
        } finally { text.destroy(); }
      }
      device.close();
    } finally { device.destroy(); }
    writer.endPage();
    writer.close();
    overlay = new engine.PDFDocument(output);
    const overlayPage = overlay.findPage(0);
    const content = overlayPage.get('Contents').readStream();
    const overlayResources = graftTextResources(document, overlayPage.get('Resources'), embeddedFonts);
    const textForm = document.addStream(new Uint8Array(content.asUint8Array()), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, logicalWidth, logicalHeight], Resources: overlayResources,
    });
    const originalResources = appearance.get('Resources');
    const resources = copyDictionary(document, originalResources);
    const xObjects = copyDictionary(document, originalResources.get('XObject'));
    let textName = 'PDFEditorFieldText';
    while (!xObjects.get(textName).isNull()) textName += '_';
    xObjects.put(textName, textForm);
    resources.put('XObject', xObjects);
    const original = appearance.readStream();
    const transforms: Record<number, string> = {
      0: '1 0 0 1 0 0', 90: `0 1 -1 0 ${width} 0`,
      180: `-1 0 0 -1 ${width} ${height}`, 270: `0 -1 1 0 0 ${height}`,
    };
    if (!(rotation in transforms)) throw new Error(`Form field "${widget.getName()}" has an unsupported rotation.`);
    const stream = `q\n${original.asString()}\nQ\nq\n1 0 0 1 ${bbox[0]} ${bbox[1]} cm\n${transforms[rotation]} cm\n/${textName} Do\nQ\n`;
    const dictionary = copyDictionary(document, appearance);
    // The replacement stream is uncompressed here; MuPDF compresses it on save.
    dictionary.delete('Filter');
    dictionary.delete('DecodeParms');
    dictionary.put('Resources', resources);
    const replacement = document.addStream(stream, dictionary);
    object.get('AP').put('N', replacement);
    for (const owned of [overlayPage, content, overlayResources, textForm, originalResources, resources, xObjects, original, dictionary, replacement]) owned.destroy();
  } finally {
    overlay?.destroy();
    writer.destroy();
    output.destroy();
    appearance.destroy();
    object.destroy();
  }
}

/** Add embedded Unicode text to blank widget appearances without flattening fields. */
export async function updateUnicodeFormAppearances(data: Uint8Array, values: Map<string, string>): Promise<Uint8Array> {
  const engine = await loadMuPDF();
  const document = new engine.PDFDocument(data);
  const fonts = [new engine.Font('Helvetica'), new engine.Font('zh-Hans')];
  const embeddedFonts = new Map<string, PDFObject>();
  const found = new Set<string>();
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index);
      try {
        for (const widget of page.getWidgets()) {
          try {
            const value = values.get(widget.getName());
            if (widget.isText() && value !== undefined) {
              setAppearance(engine, document, widget, value, fonts, embeddedFonts);
              found.add(widget.getName());
            }
          } finally { widget.destroy(); }
        }
      } finally { page.destroy(); }
    }
    const missing = [...values.keys()].filter(name => !found.has(name));
    if (missing.length) throw new Error(`Cannot render form fields without page widgets: ${missing.join(', ')}`);
    const result = document.saveToBuffer('garbage=1,compress');
    try { return new Uint8Array(result.asUint8Array()); }
    finally { result.destroy(); }
  } finally {
    for (const font of fonts) font.destroy();
    for (const font of embeddedFonts.values()) font.destroy();
    document.destroy();
  }
}
