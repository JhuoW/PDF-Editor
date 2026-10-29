import type { Font, PDFDocument, PDFObject, PDFPage } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import type { OCRWord } from './types';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface FontMetrics { font: Font; ascent: number; descent: number }

/** Measure the same searchable character quads that PDF readers will use. */
function fontMetrics(engine: Engine, name: string, character: string): FontMetrics {
  const font = new engine.Font(name);
  const list = new engine.DisplayList([0, 0, 10, 10]);
  const device = new engine.DisplayListDevice(list);
  const text = new engine.Text();
  try {
    text.showGlyph(font, [1, 0, 0, -1, 5, 5], font.encodeCharacter(character), character.codePointAt(0)!);
    device.ignoreText(text, engine.Matrix.identity);
    device.close();
    const structured = list.toStructuredText('');
    let ascent = 0;
    let descent = 0;
    try {
      structured.walk({ onChar(_character, origin, _font, _size, quad) {
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        ascent = Math.max(ascent, origin[1] - Math.min(...ys));
        descent = Math.max(descent, Math.max(...ys) - origin[1]);
      } });
    } finally { structured.destroy(); }
    if (!Number.isFinite(ascent + descent) || ascent + descent <= 0) throw new Error('Cannot determine OCR font metrics.');
    return { font, ascent, descent };
  } catch (error) {
    font.destroy();
    throw error;
  } finally {
    text.destroy(); device.destroy(); list.destroy();
  }
}

function copyDictionary(document: PDFDocument, source: PDFObject): PDFObject {
  const copy = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => {
    try { copy.put(key, value); } finally { value.destroy(); }
  });
  return copy;
}

/** Append native PDF render-mode 3 text; the original page is never rasterized. */
export function appendInvisibleText(
  engine: Engine,
  document: PDFDocument,
  page: PDFPage,
  words: OCRWord[],
  raster: { scale: number; x: number; y: number },
) {
  const bounds = page.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  const fonts = new Map<string, FontMetrics>();
  const getFont = (name: string, character: string) => {
    if (!fonts.has(name)) fonts.set(name, fontMetrics(engine, name, character));
    return fonts.get(name)!;
  };
  // Validate all glyphs before opening the writer. Unsupported text must reject
  // the operation, including when it occurs after valid words on this page.
  const prepareWord = (word: OCRWord) => {
    const glyphs = Array.from(word.text, character => {
      let metrics = getFont('Helvetica', 'M');
      let glyph = metrics.font.encodeCharacter(character);
      if (!glyph) {
        metrics = getFont('zh-Hans', '中');
        glyph = metrics.font.encodeCharacter(character);
      }
      if (!glyph) throw new Error(`OCR text contains an unsupported character ${JSON.stringify(character)} (U+${character.codePointAt(0)!.toString(16).toUpperCase()}); no PDF was changed.`);
      return { ...metrics, glyph, character, advance: metrics.font.advanceGlyph(glyph) };
    });
    const advance = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
    const ascent = Math.max(...glyphs.map(glyph => glyph.ascent));
    const descent = Math.max(...glyphs.map(glyph => glyph.descent));
    const horizontalScale = (word.bbox.x1 - word.bbox.x0) / raster.scale / advance;
    const fontSize = (word.bbox.y1 - word.bbox.y0) / raster.scale / (ascent + descent);
    if (![horizontalScale, fontSize].every(value => Number.isFinite(value) && value > 0)) throw new Error('OCR returned text with invalid glyph dimensions.');
    const x = (word.bbox.x0 + raster.x) / raster.scale - bounds[0];
    const baseline = (word.bbox.y0 + raster.y) / raster.scale - bounds[1] + ascent * fontSize;
    return { glyphs, horizontalScale, fontSize, x, baseline };
  };
  let prepared: Array<ReturnType<typeof prepareWord>>;
  try { prepared = words.map(prepareWord); }
  catch (error) {
    for (const metrics of fonts.values()) metrics.font.destroy();
    throw error;
  }
  const output = new engine.Buffer();
  const writer = new engine.DocumentWriter(output, 'pdf', '');
  let overlay: PDFDocument | undefined;
  const owned: Array<{ destroy(): void }> = [];
  const own = <T extends { destroy(): void }>(value: T): T => { owned.push(value); return value; };
  try {
    const device = writer.beginPage([0, 0, width, height]);
    try {
      for (const word of prepared) {
        const { glyphs, horizontalScale, fontSize, baseline } = word;
        let x = word.x;
        const text = new engine.Text();
        try {
          for (const glyph of glyphs) {
            text.showGlyph(glyph.font, [horizontalScale, 0, 0, -fontSize, x, baseline], glyph.glyph, glyph.character.codePointAt(0)!);
            x += glyph.advance * horizontalScale;
          }
          device.ignoreText(text, engine.Matrix.identity);
        } finally { text.destroy(); }
      }
      device.close();
    } finally { device.destroy(); }
    writer.endPage();
    writer.close();
    overlay = new engine.PDFDocument(output);
    const overlayPage = own(overlay.findPage(0));
    const overlayContents = own(overlayPage.get('Contents'));
    const content = own(overlayContents.readStream());
    const overlayResources = own(overlayPage.get('Resources'));
    const resources = own(document.graftObject(overlayResources));
    const form = own(document.addStream(new Uint8Array(content.asUint8Array()), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources,
    }));
    const pageObject = own(page.getObject());
    const oldResources = own(pageObject.getInheritable('Resources'));
    const newResources = own(copyDictionary(document, oldResources));
    const oldXObjects = own(oldResources.get('XObject'));
    const xObjects = own(copyDictionary(document, oldXObjects));
    let name = 'PDFEditorOCR';
    let suffix = 0;
    for (;;) {
      const existing = xObjects.get(name);
      const available = existing.isNull();
      existing.destroy();
      if (available) break;
      name = `PDFEditorOCR${++suffix}`;
    }
    xObjects.put(name, form);
    newResources.put('XObject', xObjects);
    pageObject.put('Resources', newResources);
    // Overlay PDF coordinates are bottom-left; the OCR raster follows MuPDF's
    // rotated, CropBox-relative, UserUnit-scaled page space. Invert that full
    // transform, rather than assuming an unrotated page with an origin of zero.
    const matrix = engine.Matrix.concat([1, 0, 0, -1, bounds[0], bounds[3]], engine.Matrix.invert(page.getTransform()));
    if (!matrix.every(Number.isFinite)) throw new Error('Cannot map OCR coordinates onto this PDF page.');
    const contents = own(document.newArray());
    contents.push(own(document.addStream('q\n', {})));
    const previous = own(pageObject.get('Contents'));
    if (previous.isArray()) previous.forEach(value => { try { contents.push(value); } finally { value.destroy(); } });
    else if (!previous.isNull()) contents.push(previous);
    const transform = matrix.map(value => Number(value.toFixed(10))).join(' ');
    contents.push(own(document.addStream(`Q\nq\n${transform} cm\n/${name} Do\nQ\n`, {})));
    pageObject.put('Contents', contents);
  } finally {
    for (const object of owned.reverse()) object.destroy();
    overlay?.destroy(); writer.destroy(); output.destroy();
    for (const metrics of fonts.values()) metrics.font.destroy();
  }
}
