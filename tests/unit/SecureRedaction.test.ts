import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applySecureRedactions } from '../../src/editing/SecureRedaction';
import { toMuPDFPageRect } from '../../src/utils/mupdf';
import type { RedactionArea, TextBlock } from '../../src/editing/types';
import { applyTextEdits } from '../../src/editing/TextEditApplier';

const secret = 'PRIVATE_ACCOUNT_671923';
const orphanSecret = 'UNREACHABLE_PRIVATE_SOURCE_732918';
const area = (rect: RedactionArea['rect'], pageNumber = 1): RedactionArea => ({
  id: 'selected-area', pageNumber, rect, overlayColor: '#000000', applied: false,
});

async function textPDF(rotation = 0, cropped = false, unit = 1) {
  const document = await PDFDocument.create();
  const page = document.addPage([600, 800]);
  if (cropped) page.setCropBox(50, 100, 300, 400);
  page.setRotation(degrees(rotation));
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
  const left = cropped ? 70 : 20;
  const top = cropped ? 500 : 800;
  page.drawText(secret, { x: left, y: top - 50, size: 14 });
  page.drawText('PUBLIC_CONTENT_REMAINS', { x: left, y: top - 250, size: 14 });
  document.setTitle('Metadata is intentionally outside page-content redaction scope');
  document.context.register(document.context.stream(orphanSecret));
  return new Uint8Array(await document.save({ useObjectStreams: false })).buffer;
}

function inspect(data: ArrayBuffer | Uint8Array) {
  const document = new mupdf.PDFDocument(data);
  const pages: string[] = [];
  const decodedStreams: string[] = [];
  const imagePixels: number[][] = [];
  let redactionAnnotations = 0;
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index);
      try {
        const text = page.toStructuredText('');
        try { pages.push(text.asText()); } finally { text.destroy(); }
        for (const annotation of page.getAnnotations()) {
          try { if (annotation.getType() === 'Redact') redactionAnnotations++; }
          finally { annotation.destroy(); }
        }
      } finally { page.destroy(); }
    }
    for (let index = 1; index < document.countObjects(); index++) {
      const object = document.newIndirect(index);
      try {
        if (!object.isStream()) continue;
        const stream = object.readStream();
        try { decodedStreams.push(new TextDecoder().decode(stream.asUint8Array())); }
        finally { stream.destroy(); }
        const subtype = object.get('Subtype');
        try {
          if (!subtype.isName() || subtype.asName() !== 'Image') continue;
          const image = document.loadImage(object);
          try {
            const pixmap = image.toPixmap();
            try { imagePixels.push(Array.from(pixmap.getPixels())); }
            finally { pixmap.destroy(); }
          } finally { image.destroy(); }
        } finally { subtype.destroy(); }
      } finally { object.destroy(); }
    }
    return { text: pages.join('\n'), decodedStreams, imagePixels, redactionAnnotations,
      versions: document.countVersions(), title: document.getMetaData('info:Title') };
  } finally { document.destroy(); }
}

function save(document: mupdf.PDFDocument, options = 'incremental=no') {
  const buffer = document.saveToBuffer(options);
  try { return new Uint8Array(buffer.asUint8Array()).buffer; }
  finally { buffer.destroy(); }
}

describe('applySecureRedactions with real PDFs', () => {
  it('removes selected text from extraction and every decoded stream while retaining outside text', async () => {
    const input = await textPDF();
    const before = new Uint8Array(input).slice();
    expect(inspect(input).text).toContain(secret);
    expect(new TextDecoder().decode(input)).toContain(orphanSecret);
    const output = await applySecureRedactions(input, [area({ x: 10, y: 20, width: 260, height: 60 })]);
    const result = inspect(output);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('PUBLIC_CONTENT_REMAINS');
    const allStreams = result.decodedStreams.join('\n');
    expect(allStreams).not.toContain(secret);
    expect(allStreams.toLowerCase()).not.toContain(Array.from(new TextEncoder().encode(secret), byte => byte.toString(16).padStart(2, '0')).join(''));
    expect(allStreams).not.toContain(orphanSecret);
    expect(new TextDecoder().decode(output)).not.toContain(orphanSecret);
    expect(result.title).toContain('outside page-content redaction scope');
    expect(result.redactionAnnotations).toBe(0);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
    expect(new Uint8Array(input)).toEqual(before);
  });

  it.each([0, 90, 180, 270])('maps CropBox offsets, UserUnit and embedded rotation %i correctly', async rotation => {
    const input = await textPDF(rotation, true, 2);
    const output = await applySecureRedactions(input, [area({ x: 20, y: 40, width: 520, height: 120 })]);
    const result = inspect(output);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('PUBLIC_CONTENT_REMAINS');
    const document = await PDFDocument.load(output);
    expect(document.getPage(0).getRotation().angle).toBe(rotation);
    expect(document.getPage(0).getCropBox()).toEqual({ x: 50, y: 100, width: 300, height: 400 });
  });

  it('rewrites an incremental source without retaining old revisions or unreachable original objects', async () => {
    const document = new mupdf.PDFDocument(await textPDF());
    let input: ArrayBuffer;
    try {
      document.setMetaData('info:Subject', 'second revision');
      input = save(document, 'incremental=yes');
    } finally { document.destroy(); }
    expect(inspect(input).versions).toBe(2);
    const output = await applySecureRedactions(input, [area({ x: 10, y: 20, width: 260, height: 60 })]);
    expect(inspect(output).versions).toBe(1);
    expect(new TextDecoder().decode(output).match(/%%EOF/g)).toHaveLength(1);
    expect(inspect(output).decodedStreams.join('\n')).not.toContain(orphanSecret);
    expect(inspect(output).text).not.toContain(secret);
  });

  it('does not apply a pre-existing redaction annotation outside the selected areas', async () => {
    const document = new mupdf.PDFDocument(await textPDF());
    const page = document.loadPage(0);
    const annotation = page.createAnnotation('Redact');
    let input: ArrayBuffer;
    try {
      annotation.setRect(toMuPDFPageRect(mupdf, page, { x: 10, y: 220, width: 280, height: 60 }));
      input = save(document);
    } finally { annotation.destroy(); page.destroy(); document.destroy(); }
    const output = await applySecureRedactions(input, [area({ x: 10, y: 20, width: 260, height: 60 })]);
    const result = inspect(output);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('PUBLIC_CONTENT_REMAINS');
    expect(result.redactionAnnotations).toBe(1);
    const flattened = await applySecureRedactions(input, [area({ x: 10, y: 20, width: 260, height: 60 })], { flattenInteractive: true });
    expect(inspect(flattened).text).toContain('PUBLIC_CONTENT_REMAINS');
    expect(inspect(flattened).redactionAnnotations).toBe(0);
  });

  it('removes covered image pixels from embedded image data, not just from the rendered appearance', async () => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 4], false);
    let png: Uint8Array;
    try {
      const pixels = pixmap.getPixels();
      for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) pixels.set(x < 4 ? [255, 0, 0] : [0, 0, 255], (y * 8 + x) * 3);
      png = new Uint8Array(pixmap.asPNG());
    } finally { pixmap.destroy(); }
    const document = await PDFDocument.create();
    const page = document.addPage([300, 400]);
    const image = await document.embedPng(png);
    page.drawImage(image, { x: 50, y: 150, width: 160, height: 80 });
    page.drawText('OUTSIDE', { x: 30, y: 300, size: 12 });
    const input = new Uint8Array(await document.save()).buffer;
    const output = await applySecureRedactions(input, [area({ x: 50, y: 170, width: 80, height: 80 })]);
    const result = inspect(output);
    expect(result.text).toContain('OUTSIDE');
    expect(result.imagePixels).toHaveLength(1);
    const pixels = result.imagePixels[0];
    // Inspect the image XObject independently of the black page fill.
    for (let y = 0; y < 4; y++) {
      expect(pixels.slice((y * 8) * 3, (y * 8 + 1) * 3)).toEqual([255, 255, 255]);
      expect(pixels.slice((y * 8 + 7) * 3, (y * 8 + 8) * 3)).toEqual([0, 0, 255]);
    }
    expect(result.imagePixels).not.toEqual(inspect(input).imagePixels);
  });

  it('flattens forms and annotations before removing their covered content when explicitly requested', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([600, 800]);
    page.drawText('PUBLIC_CONTENT_REMAINS', { x: 20, y: 500, size: 14 });
    const field = source.getForm().createTextField('field-name');
    field.setText('FORM_SECRET_82736');
    field.addToPage(page, { x: 20, y: 700, width: 250, height: 40 });
    const outsideField = source.getForm().createTextField('outside-field');
    outsideField.setText('OUTSIDE_FIELD_REMAINS');
    outsideField.addToPage(page, { x: 20, y: 400, width: 250, height: 40 });
    const document = new mupdf.PDFDocument(await source.save());
    const annotatedPage = document.loadPage(0);
    const annotation = annotatedPage.createAnnotation('FreeText');
    let input: ArrayBuffer;
    try {
      annotation.setRect([20, 150, 300, 190]);
      annotation.setContents('ANNOTATION_SECRET_28371');
      annotation.setDefaultAppearance('Helv', 14, [0]);
      annotation.update();
      input = save(document);
    } finally { annotation.destroy(); annotatedPage.destroy(); document.destroy(); }

    const output = await applySecureRedactions(input, [area({ x: 0, y: 20, width: 350, height: 200 })], { flattenInteractive: true });
    const result = inspect(output);
    expect(result.text).toContain('PUBLIC_CONTENT_REMAINS');
    expect(result.text).toContain('OUTSIDE_FIELD_REMAINS');
    expect(result.text).not.toContain('FORM_SECRET_82736');
    expect(result.text).not.toContain('ANNOTATION_SECRET_28371');
    const allContent = new TextDecoder().decode(output) + result.decodedStreams.join('\n');
    for (const sensitive of ['FORM_SECRET_82736', 'ANNOTATION_SECRET_28371']) {
      expect(allContent).not.toContain(sensitive);
      expect(allContent.toLowerCase()).not.toContain(Array.from(new TextEncoder().encode(sensitive), byte => byte.toString(16).padStart(2, '0')).join(''));
    }
    const reopened = await PDFDocument.load(output);
    expect(reopened.getForm().getFields()).toHaveLength(0);
    expect(reopened.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect((await PDFDocument.load(input)).getForm().getTextField('field-name').getText()).toBe('FORM_SECRET_82736');
  });

  it('preserves replacement text outside the area when removing content from a text-edited form PDF', async () => {
    const source = await PDFDocument.load(await textPDF());
    const field = source.getForm().createTextField('outside-form');
    field.setText('FORM_VALUE_REMAINS');
    field.addToPage(source.getPage(0), { x: 20, y: 300, width: 250, height: 30 });
    const blocks: TextBlock[] = [
      { id: 'private', text: secret, top: 20, baseline: 50 },
      { id: 'public', text: 'PUBLIC_CONTENT_REMAINS', top: 220, baseline: 250 },
    ].map(({ id, text, top, baseline }) => ({
      id, text, pageNumber: 1, editable: true,
      rect: { x: 20, y: top, width: 300, height: 60 },
      lines: [{ items: [], text, x: 20, y: top, width: 250, height: 14, baseline }],
      style: { fontName: 'Helvetica', fontSize: 14, alignment: 'left', lineHeight: 1.2 },
    }));
    const edited = await applyTextEdits(new Uint8Array(await source.save()).buffer, new Map([[1, blocks]]), [
      { blockId: 'private', originalText: secret, newText: 'EDITED_PRIVATE', timestamp: 1 },
      { blockId: 'public', originalText: 'PUBLIC_CONTENT_REMAINS', newText: 'EDITED_PUBLIC_REMAINS', timestamp: 1 },
    ]);
    expect(inspect(edited).text).toContain('EDITED_PRIVATE');
    expect(inspect(edited).text).toContain('EDITED_PUBLIC_REMAINS');
    const output = await applySecureRedactions(new Uint8Array(edited).buffer, [area({ x: 10, y: 15, width: 320, height: 70 })], { flattenInteractive: true });
    const result = inspect(output);
    expect(result.text).not.toContain('EDITED_PRIVATE');
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('EDITED_PUBLIC_REMAINS');
    expect(result.text).toContain('FORM_VALUE_REMAINS');
    expect((await PDFDocument.load(output)).getForm().getFields()).toHaveLength(0);
  });

  it('rejects a malformed CropBox whose fallback differs between the viewer and removal engine', async () => {
    const source = await PDFDocument.load(await textPDF());
    source.getPage(0).setCropBox(700, 900, 100, 100);
    const input = new Uint8Array(await source.save()).buffer;
    await expect(applySecureRedactions(input, [area({ x: 10, y: 20, width: 260, height: 60 })])).rejects.toThrow('CropBox');
  });

  it('fails instead of silently accepting invalid pages or areas', async () => {
    const input = await textPDF();
    await expect(applySecureRedactions(input, [area({ x: 0, y: 0, width: 10, height: 10 }, 2)])).rejects.toThrow('Invalid page');
    await expect(applySecureRedactions(input, [area({ x: NaN, y: 0, width: 10, height: 10 })])).rejects.toThrow('Invalid redaction');
    await expect(applySecureRedactions(input, [area({ x: 900, y: 0, width: 10, height: 10 })])).rejects.toThrow('outside');
    expect(inspect(input).text).toContain(secret);
  });

  it('returns an independent copy when no regions are selected', async () => {
    const input = await textPDF();
    const result = await applySecureRedactions(input, []);
    expect(result).toEqual(new Uint8Array(input));
    expect(result.buffer).not.toBe(input);
  });
});
