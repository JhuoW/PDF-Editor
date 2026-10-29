import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { PageDecorationRenderer, type RenderedPageDecoration } from '../../src/core/PageDecorationRenderer';

async function source(rotation = 0, unit = 1) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([400, 500]);
  page.setCropBox(40, 60, 300, 400); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
  page.drawText('ORIGINAL CONTENT', { x: 60, y: 400, size: 14 });
  page.drawRectangle({ x: 60, y: 80, width: 20, height: 20, color: rgb(0, 0, 0) });
  return new mupdf.PDFDocument(await pdf.save());
}
function clone(document: mupdf.PDFDocument, source: mupdf.PDFObject) {
  const result = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => { try { result.put(key, value); } finally { value.destroy(); } });
  return result;
}
function nextName(dictionary: mupdf.PDFObject, prefix: string) {
  let number = 0;
  while (true) {
    const value = dictionary.get(`${prefix}${number}`);
    try { if (value.isNull()) return `${prefix}${number}`; } finally { value.destroy(); }
    number++;
  }
}
/** Test-only placement: visual top-left points -> the page's native user space. */
function place(document: mupdf.PDFDocument, rendered: RenderedPageDecoration, x: number, y: number, options: { angle?: number; opacity?: number; background?: boolean } = {}) {
  const page = document.loadPage(0), object = page.getObject();
  const originalResources = object.getInheritable('Resources'), resources = clone(document, originalResources);
  const oldXObjects = originalResources.get('XObject'), xObjects = clone(document, oldXObjects);
  const name = nextName(xObjects, 'Decoration');
  xObjects.put(name, rendered.form); resources.put('XObject', xObjects);
  const oldStates = originalResources.get('ExtGState'), states = clone(document, oldStates);
  const stateName = nextName(states, 'Opacity');
  states.put(stateName, { Type: 'ExtGState', ca: options.opacity ?? 1, CA: options.opacity ?? 1 }); resources.put('ExtGState', states);
  const radians = (options.angle ?? 0) * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  const centerX = x + rendered.width / 2, centerY = y + rendered.height / 2;
  const rotation: mupdf.Matrix = [cosine, sine, -sine, cosine, centerX - cosine * centerX + sine * centerY, centerY - sine * centerX - cosine * centerY];
  const topLeft: mupdf.Matrix = [1, 0, 0, -1, x, y + rendered.height];
  const matrix = mupdf.Matrix.concat(mupdf.Matrix.concat(topLeft, rotation), mupdf.Matrix.invert(page.getTransform()));
  const stream = document.addStream(`q\n${matrix.join(' ')} cm\n/${stateName} gs\n/${name} Do\nQ\n`, {});
  const original = object.get('Contents'), contents = document.newArray();
  if (options.background) contents.push(stream);
  if (original.isArray()) original.forEach(item => { try { contents.push(item); } finally { item.destroy(); } });
  else if (!original.isNull()) contents.push(original);
  if (!options.background) contents.push(stream);
  object.put('Contents', contents); object.put('Resources', resources);
  for (const value of [contents, original, stream, states, oldStates, xObjects, oldXObjects, resources, originalResources, object]) value.destroy();
  page.destroy(); rendered.form.destroy();
}
function reopen(document: mupdf.PDFDocument) {
  const buffer = document.saveToBuffer('garbage=1,compress');
  try { return new mupdf.PDFDocument(new Uint8Array(buffer.asUint8Array())); } finally { buffer.destroy(); }
}
function inspect(document: mupdf.PDFDocument) {
  const page = document.loadPage(0), text = page.toStructuredText(''), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  const characters: Array<{ character: string; quad: number[] }> = [];
  try {
    text.walk({ onChar(character, _origin, font, _size, quad) { characters.push({ character, quad }); font.destroy(); } });
    return { text: text.asText(), characters, width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: new Uint8Array(pixmap.getPixels()) };
  } finally { pixmap.destroy(); text.destroy(); page.destroy(); }
}
const sample = (output: ReturnType<typeof inspect>, x: number, y: number) => [...output.pixels.slice((y * output.width + x) * 3, (y * output.width + x) * 3 + 3)];
function bitmap(jpeg = false) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
  try {
    const pixels = pixmap.getPixels();
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) pixels.set(y < 10 ? x < 20 ? [255, 0, 0] : [0, 255, 0] : x < 20 ? [0, 0, 255] : [255, 255, 0], (y * 40 + x) * 3);
    return new Uint8Array(jpeg ? pixmap.asJPEG(100) : pixmap.asPNG());
  } finally { pixmap.destroy(); }
}
function withOrientation(jpeg: Uint8Array, orientation: number) {
  const app1 = new Uint8Array(36), view = new DataView(app1.buffer);
  app1.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0]);
  view.setUint16(18, 1, true); view.setUint16(20, 0x112, true); view.setUint16(22, 3, true); view.setUint32(24, 1, true); view.setUint16(28, orientation, true);
  const data = new Uint8Array(jpeg.length + app1.length); data.set(jpeg.subarray(0, 2)); data.set(app1, 2); data.set(jpeg.subarray(2), 2 + app1.length); return data;
}

describe('vector page decoration rendering', () => {
  it.each(['Helvetica', 'Times', 'Courier'] as const)('renders extractable Unicode in %s without changing original content or embedding a page image', async fontFamily => {
    const document = await source(), before = inspect(document);
    const renderer = new PageDecorationRenderer(mupdf, document);
    try {
      const value = '水印 café Ωμέγα Привет\nPAGE 002';
      const rendered = renderer.render({ type: 'text', text: value, fontFamily, fontSize: 14, color: '#1234ab' });
      const xObjects = rendered.form.get('Resources', 'XObject');
      try { expect(xObjects.isNull() || xObjects.length === 0).toBe(true); } finally { xObjects.destroy(); }
      place(document, rendered, 25, 100);
      renderer.destroy();
      const saved = reopen(document);
      try {
        const output = inspect(saved);
        expect(output.text).toContain('ORIGINAL CONTENT');
        expect(output.text.replace(/\s/g, '')).toContain(value.replace(/\s/g, ''));
        expect(output.characters.slice(0, before.characters.length)).toEqual(before.characters);
        expect(output.pixels.some((component, offset) => offset % 3 === 2 && component > 100 && output.pixels[offset - 2] < 80)).toBe(true);
      } finally { saved.destroy(); }
    } finally { renderer.destroy(); document.destroy(); }
  });

  it('reuses embedded fonts across different page-number/Bates strings and keeps all characters extractable', async () => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document), fontRefs = new Map<string, Set<string>>();
    try {
      for (const [index, text] of ['合同-000001 α', '证据-000002 Я', '終頁-000003 Ω'].entries()) {
        const output = renderer.render({ type: 'text', text, fontFamily: 'Helvetica', fontSize: 13, color: '#000000' });
        const fonts = output.form.get('Resources', 'Font');
        try { fonts.forEach(font => { const base = font.get('BaseFont'); try { const name = base.asName(); if (!fontRefs.has(name)) fontRefs.set(name, new Set()); fontRefs.get(name)!.add(font.toString()); } finally { base.destroy(); font.destroy(); } }); }
        finally { fonts.destroy(); }
        place(document, output, 20, 110 + 40 * index);
      }
      expect([...fontRefs.values()].every(references => references.size === 1)).toBe(true);
      expect([...fontRefs.keys()].some(name => name.includes('Droid'))).toBe(true);
      const saved = reopen(document); try { const text = inspect(saved).text; for (const value of ['合同-000001 α', '证据-000002 Я', '終頁-000003 Ω']) expect(text).toContain(value); } finally { saved.destroy(); }
    } finally { renderer.destroy(); document.destroy(); }
  });

  it.each([0, 90, 180, 270])('places transparent vector content in final visible coordinates on CropBox/UserUnit2/Rotate%d', async rotation => {
    const document = await source(rotation, 2), renderer = new PageDecorationRenderer(mupdf, document);
    try {
      place(document, renderer.render({ type: 'solid', width: 50, height: 30, color: '#ff0000' }), 20, 25, { opacity: 0.5 });
      const text = renderer.render({ type: 'text', text: '中文 ABC', fontFamily: 'Helvetica', fontSize: 15, color: '#0000ff' });
      place(document, text, 130, 150, { angle: 30 });
      const saved = reopen(document);
      try {
        const output = inspect(saved);
        const pixel = sample(output, 30, 35); expect(pixel[0]).toBe(255); expect(pixel[1]).toBeGreaterThanOrEqual(125); expect(pixel[1]).toBeLessThanOrEqual(130); expect(pixel[2]).toBe(pixel[1]);
        expect(output.text).toContain('中文 ABC');
        const letter = output.characters.find(item => item.character === '中')!;
        expect(letter.quad[0]).toBeGreaterThan(115); expect(letter.quad[0]).toBeLessThan(160); expect(letter.quad[1]).toBeGreaterThan(130); expect(letter.quad[1]).toBeLessThan(180);
      } finally { saved.destroy(); }
    } finally { renderer.destroy(); document.destroy(); }
  });

  it('uses an ordinary background vector without covering foreground original text', async () => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document);
    try {
      const before = inspect(document);
      place(document, renderer.render({ type: 'solid', width: 300, height: 400, color: '#ffff00' }), 0, 0, { background: true });
      const saved = reopen(document);
      try { const output = inspect(saved); expect(sample(output, 5, 5)).toEqual([255, 255, 0]); expect(sample(output, 30, 365)).toEqual([0, 0, 0]); expect(output.characters).toEqual(before.characters); }
      finally { saved.destroy(); }
    } finally { renderer.destroy(); document.destroy(); }
  });

  it.each([false, true])('keeps a PNG/JPEG image proportional, shares its native resource, and leaves input bytes intact (jpeg=%s)', async jpeg => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document), data = bitmap(jpeg), before = data.slice();
    const decode = vi.spyOn(mupdf.Image.prototype, 'toPixmap');
    try {
      const first = renderer.render({ type: 'image', data, maxWidth: 100, maxHeight: 100 }), second = renderer.render({ type: 'image', data, maxWidth: 200, maxHeight: 200 });
      expect(first).toMatchObject({ width: 100, height: 50, imageResourceName: 'DecorationImage' }); expect(second).toMatchObject({ width: 200, height: 100 });
      const a = first.form.get('Resources', 'XObject', first.imageResourceName!), b = second.form.get('Resources', 'XObject', second.imageResourceName!);
      try { expect(a.toString()).toBe(b.toString()); } finally { a.destroy(); b.destroy(); }
      expect(decode).toHaveBeenCalledTimes(1);
      place(document, first, 50, 100); second.form.destroy();
      const saved = reopen(document); try { const output = inspect(saved), pixel = sample(output, 60, 110); expect(pixel[0]).toBeGreaterThan(245); expect(pixel[1]).toBeLessThan(10); } finally { saved.destroy(); }
      expect(data).toEqual(before);
    } finally { decode.mockRestore(); renderer.destroy(); document.destroy(); }
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('normalizes EXIF orientation %d in the native Image itself for later managed updates', async orientation => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document);
    const expected = [[0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1], [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2]][orientation - 1];
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    try {
      const result = renderer.render({ type: 'image', data: withOrientation(bitmap(true), orientation), maxWidth: 100, maxHeight: 100 });
      const resource = result.form.get('Resources', 'XObject', result.imageResourceName!), image = document.loadImage(resource), pixmap = image.toPixmap();
      try {
        const width = pixmap.getWidth(), height = pixmap.getHeight(), channels = pixmap.getNumberOfComponents(), pixels = pixmap.getPixels();
        expect([width, height]).toEqual(orientation >= 5 ? [20, 40] : [40, 20]);
        const points = [[width / 4, height / 4], [width * 3 / 4, height / 4], [width / 4, height * 3 / 4], [width * 3 / 4, height * 3 / 4]];
        for (const [index, [x, y]] of points.entries()) {
          const offset = (Math.floor(y) * width + Math.floor(x)) * channels;
          for (let channel = 0; channel < 3; channel++) expect(Math.abs(pixels[offset + channel] - colors[expected[index]][channel])).toBeLessThan(15);
        }
      } finally { pixmap.destroy(); image.destroy(); resource.destroy(); result.form.destroy(); }
    } finally { renderer.destroy(); document.destroy(); }
  });

  it('preserves PNG transparency over an existing vector background', async () => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], true);
    try {
      const pixels = pixmap.getPixels();
      // MuPDF pixmaps use premultiplied alpha. Top half is half-opaque red;
      // bottom half is transparent and must leave the vector background visible.
      for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) pixels.set(y < 10 ? [128, 0, 0, 128] : [0, 0, 0, 0], (y * 20 + x) * 4);
      place(document, renderer.render({ type: 'solid', width: 300, height: 400, color: '#00ff00' }), 0, 0, { background: true });
      place(document, renderer.render({ type: 'image', data: new Uint8Array(pixmap.asPNG()), maxWidth: 100, maxHeight: 100 }), 100, 150);
      const saved = reopen(document);
      try {
        const output = inspect(saved), blended = sample(output, 120, 170);
        expect(blended[0]).toBeGreaterThanOrEqual(126); expect(blended[0]).toBeLessThanOrEqual(129);
        expect(blended[1]).toBeGreaterThanOrEqual(126); expect(blended[1]).toBeLessThanOrEqual(129); expect(blended[2]).toBe(0);
        expect(sample(output, 120, 220)).toEqual([0, 255, 0]);
        expect(output.text).toContain('ORIGINAL CONTENT');
      } finally { saved.destroy(); }
    } finally { pixmap.destroy(); renderer.destroy(); document.destroy(); }
  });

  it('rejects missing glyphs, complex scripts, controls, oversized content, invalid dimensions/colors and use after release', async () => {
    const document = await source(), renderer = new PageDecorationRenderer(mupdf, document);
    const text = { type: 'text' as const, fontFamily: 'Helvetica' as const, fontSize: 12, color: '#000000' };
    try {
      for (const value of ['中文😀', 'العربية', 'abc\0hidden', 'x'.repeat(4097), '  ']) expect(() => renderer.render({ ...text, text: value })).toThrow();
      expect(() => renderer.render({ ...text, text: 'MMMM'.repeat(1000), fontSize: 500 })).toThrow('dimensions');
      expect(() => renderer.render({ type: 'solid', width: Number.NaN, height: 40, color: '#ffffff' })).toThrow('dimensions');
      expect(() => renderer.render({ type: 'solid', width: 40, height: 40, color: 'url(https://invalid.example)' })).toThrow('hexadecimal');
      expect(() => renderer.render({ type: 'image', data: new TextEncoder().encode('WEBP'), maxWidth: 20, maxHeight: 20 })).toThrow('PNG and JPEG');
      renderer.destroy(); expect(() => renderer.render({ ...text, text: 'Released' })).toThrow('released');
    } finally { renderer.destroy(); document.destroy(); }
  });
});
