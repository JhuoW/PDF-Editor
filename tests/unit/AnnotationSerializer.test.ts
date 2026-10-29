import { describe, expect, it } from 'vitest';
import { AnnotationFlags, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { serializeAnnotationsToPDF } from '../../src/annotations/AnnotationSerializer';
import { createFreeTextAnnotation, createImageAnnotation, createRectangleAnnotation, createStampAnnotation, createStickyNoteAnnotation } from '../../src/store/annotationStore';
import type { Annotation, ImageAnnotation } from '../../src/annotations/types';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=';

async function blankPDF() {
  const document = await PDFDocument.create();
  document.addPage([600, 800]);
  return new Uint8Array(await document.save()).buffer;
}

describe('annotation export preserves content', () => {
  it('writes Unicode notes and replies as native text annotations with metadata and reply references', async () => {
    const note = createStickyNoteAnnotation(1, { x: 40, y: 100 }, '中文便签 — Ελληνικά — 😀', '#336699');
    note.id = 'note-1';
    note.author = '作者 Zoë';
    note.iconType = 'newparagraph';
    note.opacity = 0.75;
    note.createdAt = new Date('2026-10-28T10:00:00Z');
    note.modifiedAt = new Date('2026-10-28T12:00:00Z');
    note.replies = [{
      id: 'reply-1', author: '回复者', content: '第一条回复 ✓', createdAt: new Date('2026-10-28T11:00:00Z'),
    }];
    const output = await serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [note]]]));
    const pdf = await PDFDocument.load(output);
    const page = pdf.getPage(0);
    const annotations = page.node.Annots()!;
    expect(annotations.size()).toBe(2);
    const noteRef = annotations.get(0);
    expect(noteRef).toBeInstanceOf(PDFRef);
    const dictionary = annotations.lookup(0, PDFDict);
    expect(dictionary.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Text'));
    expect(dictionary.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe(note.content);
    expect(dictionary.lookup(PDFName.of('T'), PDFHexString).decodeText()).toBe(note.author);
    expect(dictionary.lookup(PDFName.of('NM'), PDFHexString).decodeText()).toBe(note.id);
    expect(dictionary.lookup(PDFName.of('CreationDate'), PDFString).asString()).toBe('D:20261028100000Z');
    expect(dictionary.lookup(PDFName.of('M'), PDFString).asString()).toBe('D:20261028120000Z');
    expect(dictionary.lookup(PDFName.of('Name'))).toBe(PDFName.of('NewParagraph'));
    expect(dictionary.lookup(PDFName.of('C'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber()))
      .toEqual([0.2, 0.4, 0.6]);
    expect(dictionary.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(0.75);
    expect(dictionary.lookup(PDFName.of('F'), PDFNumber).asNumber() & AnnotationFlags.Print).not.toBe(0);
    expect(dictionary.get(PDFName.of('P'))).toBe(page.ref);
    expect(dictionary.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => (value as PDFNumber).asNumber()))
      .toEqual([40, 76, 64, 100]);

    const reply = annotations.lookup(1, PDFDict);
    expect(reply.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe(note.replies[0].content);
    expect(reply.lookup(PDFName.of('T'), PDFHexString).decodeText()).toBe('回复者');
    expect(reply.get(PDFName.of('IRT'))).toBe(noteRef);
    expect(reply.lookup(PDFName.of('RT'))).toBe(PDFName.of('R'));
    expect(reply.lookup(PDFName.of('CreationDate'), PDFString).asString()).toBe('D:20261028110000Z');
    // Native annotation icons are not duplicated in the underlying page content.
    expect(page.node.Contents()).toBeUndefined();

    const reader = new mupdf.PDFDocument(output);
    const readerPage = reader.loadPage(0);
    const readerNotes = readerPage.getAnnotations();
    try {
      expect(readerNotes.map(annotation => annotation.getType())).toEqual(['Text', 'Text']);
      expect(readerNotes.map(annotation => annotation.getContents())).toEqual([note.content, note.replies[0].content]);
      expect(readerNotes[0].getAuthor()).toBe(note.author);
      expect(readerNotes[0].getIcon()).toBe('NewParagraph');
    } finally {
      for (const annotation of readerNotes) annotation.destroy();
      readerPage.destroy();
      reader.destroy();
    }
  });

  it('preserves existing native annotations when appending a note', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    page.node.addAnnot(pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') },
    })));
    const note = createStickyNoteAnnotation(1, { x: 20, y: 20 }, 'Added note');
    const result = await serializeAnnotationsToPDF(new Uint8Array(await pdf.save()).buffer, new Map([[1, [note]]]));
    const annotations = (await PDFDocument.load(result)).getPage(0).node.Annots()!;
    expect(annotations.size()).toBe(2);
    expect(annotations.lookup(0, PDFDict).lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    expect(annotations.lookup(1, PDFDict).lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Added note');
  });

  it('embeds a custom stamp image instead of exporting its label as text', async () => {
    const stamp = createStampAnnotation(1, [10, 20, 120, 80], 'CUSTOM LABEL MUST NOT REPLACE IMAGE', 'custom', png);
    const result = await serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [stamp]]]));
    const pdf = await PDFDocument.load(result);
    const resources = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const images = resources.entries().map(([, ref]) => pdf.context.lookup(ref))
      .filter(object => object instanceof PDFRawStream && object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(images).toHaveLength(1);

    const reader = new mupdf.PDFDocument(result);
    const page = reader.loadPage(0);
    const text = page.toStructuredText('');
    try { expect(text.asText().trim()).toBe(''); }
    finally { text.destroy(); page.destroy(); reader.destroy(); }
  });

  it.each([
    ['not a data URL', /base64 PNG or JPEG/],
    ['data:image/png;base64,invalid!', /Unable to embed image\/png/],
    ['data:image/png;base64,aGVsbG8=', /Unable to embed image\/png/],
    ['data:image/webp;base64,aGVsbG8=', /Unsupported image format "image\/webp"/],
  ])('fails visibly for invalid or unsupported image input %s', async (imageData, message) => {
    const image = createImageAnnotation(1, [10, 20, 50, 50], imageData, 1, 1);
    image.id = 'broken-image';
    const result = serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [image]]]));
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toThrow('image annotation "broken-image" on page 1');
  });

  it('rejects a missing custom stamp image instead of falling back to the stamp name', async () => {
    const stamp = createStampAnnotation(1, [10, 20, 120, 80], 'missing', 'custom');
    await expect(serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [stamp]]])))
      .rejects.toThrow('Custom stamp image is missing');
  });

  it('rejects unsupported text glyphs with the annotation identity', async () => {
    const text = createFreeTextAnnotation(1, [10, 20, 200, 80], '中文');
    text.id = 'unsupported-text';
    await expect(serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [text]]])))
      .rejects.toThrow(/freetext annotation "unsupported-text" on page 1:.*cannot encode/);
  });

  it('rejects overflowing text instead of dropping lines from the exported PDF', async () => {
    const text = createFreeTextAnnotation(1, [10, 20, 200, 20], 'First\nSecond\nThird');
    await expect(serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [text]]])))
      .rejects.toThrow('Text exceeds the text box height');
  });

  it('rejects annotations assigned to a missing page', async () => {
    const note = createStickyNoteAnnotation(2, { x: 20, y: 20 }, 'Must not disappear');
    await expect(serializeAnnotationsToPDF(await blankPDF(), new Map([[2, [note]]])))
      .rejects.toThrow('missing page 2');
  });
});

const red = [255, 0, 0];
const green = [0, 255, 0];
const blue = [0, 0, 255];
const yellow = [255, 255, 0];
const white = [255, 255, 255];

function quadrantImage(): ImageAnnotation {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
  try {
    const pixels = pixmap.getPixels();
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        pixels.set(y < 10 ? (x < 10 ? red : green) : (x < 10 ? blue : yellow), (y * 20 + x) * 3);
      }
    }
    const data = `data:image/png;base64,${Buffer.from(pixmap.asPNG()).toString('base64')}`;
    return createImageAnnotation(1, [100, 200, 100, 100], data, 20, 20);
  } finally {
    pixmap.destroy();
  }
}

async function renderedPixels(annotations: Annotation[]) {
  const bytes = await serializeAnnotationsToPDF(await blankPDF(), new Map([[1, annotations]]));
  const document = new mupdf.PDFDocument(bytes);
  const page = document.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  try {
    const pixels = new Uint8Array(pixmap.getPixels());
    const stride = pixmap.getStride();
    const components = pixmap.getNumberOfComponents();
    return {
      bytes,
      pixel: (x: number, y: number) => Array.from(pixels.subarray(y * stride + x * components, y * stride + x * components + 3)),
    };
  } finally {
    pixmap.destroy();
    page.destroy();
    document.destroy();
  }
}

const quadrantPoints = [[125, 525], [175, 525], [125, 575], [175, 575]];

it('renders a native note below its editor top-left anchor without shifting it upwards', async () => {
  const note = createStickyNoteAnnotation(1, { x: 40, y: 100 }, 'Position regression', '#ffff00');
  const { pixel } = await renderedPixels([note]);
  const painted: [number, number][] = [];
  for (let y = 675; y < 730; y++) {
    for (let x = 30; x < 75; x++) {
      if (pixel(x, y).some(channel => channel < 240)) painted.push([x, y]);
    }
  }
  expect(painted.length).toBeGreaterThan(20);
  expect(Math.min(...painted.map(([, y]) => y))).toBeGreaterThanOrEqual(700);
  expect(Math.max(...painted.map(([, y]) => y))).toBeLessThanOrEqual(724);
  expect(Math.min(...painted.map(([x]) => x))).toBeGreaterThanOrEqual(40);
  expect(Math.max(...painted.map(([x]) => x))).toBeLessThanOrEqual(64);
});

describe('image annotation export matches visible transformations', () => {
  it.each([
    [false, false, [red, green, blue, yellow]],
    [true, false, [green, red, yellow, blue]],
    [false, true, [blue, yellow, red, green]],
    [true, true, [yellow, blue, green, red]],
  ] as const)('renders horizontal flip=%s and vertical flip=%s', async (flipHorizontal, flipVertical, expected) => {
    const image = { ...quadrantImage(), flipHorizontal, flipVertical };
    const { pixel } = await renderedPixels([image]);
    expect(quadrantPoints.map(([x, y]) => pixel(x, y))).toEqual(expected);
  });

  it.each([
    [90, [blue, red, yellow, green]],
    [180, [yellow, blue, green, red]],
    [270, [green, yellow, red, blue]],
  ] as const)('rotates clockwise by %i degrees around the image center', async (rotation, expected) => {
    const image = { ...quadrantImage(), rotation };
    const { pixel } = await renderedPixels([image]);
    expect(quadrantPoints.map(([x, y]) => pixel(x, y))).toEqual(expected);
    expect(pixel(99, 550)).toEqual(white);
    expect(pixel(201, 550)).toEqual(white);
  });

  it('composes local flips with clockwise rotation in the same order as the canvas', async () => {
    const image = { ...quadrantImage(), flipHorizontal: true, rotation: 90 };
    const { pixel } = await renderedPixels([image]);
    expect(quadrantPoints.map(([x, y]) => pixel(x, y))).toEqual([yellow, green, blue, red]);
  });

  it.each([
    [{ top: 50, right: 0, bottom: 0, left: 50 }, yellow],
    [{ top: 0, right: 50, bottom: 50, left: 0 }, red],
  ])('stretches only the selected source crop and clips the expanded image', async (cropBounds, expected) => {
    const image = { ...quadrantImage(), cropBounds };
    const { pixel, bytes } = await renderedPixels([image]);
    expect(quadrantPoints.map(([x, y]) => pixel(x, y))).toEqual([expected, expected, expected, expected]);
    for (const [x, y] of [[99, 550], [201, 550], [150, 499], [150, 601]]) expect(pixel(x, y)).toEqual(white);
    const pdf = await PDFDocument.load(bytes);
    const imageObjects = pdf.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFRawStream && object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(imageObjects).toHaveLength(1);
    // The crop is a PDF clip, preserving the original image resolution.
    expect((imageObjects[0][1] as PDFRawStream).dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(20);
  });

  it('clips rounded corners while preserving the interior pixels', async () => {
    const image = { ...quadrantImage(), borderRadius: 25 };
    const { pixel } = await renderedPixels([image]);
    for (const [x, y] of [[101, 501], [198, 501], [101, 598], [198, 598]]) expect(pixel(x, y)).toEqual(white);
    expect(quadrantPoints.map(([x, y]) => pixel(x, y))).toEqual([red, green, blue, yellow]);
    expect(pixel(125, 501)).toEqual(red);
  });

  it('preserves image and border opacity and restores the graphics state for following annotations', async () => {
    const image = {
      ...quadrantImage(), opacity: 0.5, borderRadius: 20,
      borderWidth: 6, borderStyle: 'solid' as const, borderColor: '#FF00FF',
    };
    const rectangle = createRectangleAnnotation(1, [300, 300, 50, 50], '#FF0000', 0, '#FF0000');
    const { pixel } = await renderedPixels([image, rectangle]);
    const inside = pixel(125, 525);
    expect(inside[0]).toBe(255);
    expect(inside[1]).toBeGreaterThanOrEqual(127);
    expect(inside[1]).toBeLessThanOrEqual(128);
    expect(inside[2]).toBe(inside[1]);
    const border = pixel(98, 550);
    expect(border[0]).toBe(255);
    expect(border[1]).toBeGreaterThanOrEqual(127);
    expect(border[1]).toBeLessThanOrEqual(128);
    expect(border[2]).toBe(255);
    expect(pixel(325, 475)).toEqual(red);
  });

  it.each([
    { top: 0, right: 60, bottom: 0, left: 40 },
    { top: -1, right: 0, bottom: 0, left: 0 },
    { top: 100, right: 0, bottom: 0, left: 0 },
  ])('rejects invalid crop percentages rather than exporting the uncropped original', async cropBounds => {
    const image = { ...quadrantImage(), cropBounds };
    await expect(serializeAnnotationsToPDF(await blankPDF(), new Map([[1, [image]]])))
      .rejects.toThrow('crop must leave a nonempty visible area');
  });
});
