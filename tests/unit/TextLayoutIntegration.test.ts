import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import { previewWorkspaceTextEdit } from '../../src/core/TextLayoutPreviewWorkspace';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { toMuPDFPageRect } from '../../src/utils/mupdf';
import type { TextBlock, TextEditOperation } from '../../src/editing/types';

const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
function inspect(data: ArrayBuffer | Uint8Array) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(0), text = page.toStructuredText('');
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  let images = 0;
  const device = new mupdf.Device({ fillImage(image) { images++; image.destroy(); } });
  try {
    const pixels = pixmap.getPixels();
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, blue = 0;
    for (let y = 0; y < pixmap.getHeight(); y++) for (let x = 0; x < pixmap.getWidth(); x++) {
      const index = y * pixmap.getStride() + x * 3, [red, green, b] = pixels.subarray(index, index + 3);
      if (green > 80 && green > red * 2 && green > b * 2) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      if (b > 150 && b > red * 2 && b > green * 2) blue++;
    }
    page.runPageContents(device, mupdf.Matrix.identity); device.close();
    return { text: text.asText(), green: [minX, minY, maxX, maxY], blue, images };
  } finally { device.destroy(); pixmap.destroy(); text.destroy(); page.destroy(); document.destroy(); }
}

async function fixture(rotation: number) {
  const document = await PDFDocument.create(), page = document.addPage([500, 700]);
  page.setCropBox(50, 70, 300, 450); page.setRotation(degrees(rotation)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false);
  let image;
  try { pixels.getPixels().set(new Uint8Array([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255])); image = await document.embedPng(pixels.asPNG()); }
  finally { pixels.destroy(); }
  // This image is beneath the original text, inside its removal rectangle.
  page.drawImage(image, { x: 80, y: 425, width: 110, height: 30 });
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  page.drawText('OLD SOURCE', { x: 80, y: 450, size: 12, font, color: rgb(.7, .1, .2) });
  // The expanded destination overlaps this independent text's position.
  page.drawText('PUBLIC NEIGHBOR', { x: 210, y: 320, size: 10 });
  return applyPageDecorations(buffer(await document.save()), [{ type: 'create', definition: {
    kind: 'watermark', name: 'Protected mark', pages: [1], opacity: .6, angle: 0, layer: 'foreground',
    position: { anchor: 'center', offsetX: 0, offsetY: 0 },
    content: { type: 'text', text: 'MANAGED MARK', fontFamily: 'Helvetica', fontSize: 16, color: '#bb0000' },
  } }]);
}

describe('text layout with current drafts and managed page decorations', () => {
  it.each([0, 90, 180, 270])('keeps neighbors, images and editable marks when text moves on CropBox/UserUnit2/Rotate%i', async rotation => {
    const source = await fixture(rotation), untouched = Buffer.from(source);
    const block: TextBlock = {
      id: 'source', pageNumber: 1, text: 'An earlier inline draft', editable: true,
      rect: { x: 60, y: 112, width: 250, height: 40 },
      lines: [{ items: [], text: 'OLD SOURCE', x: 60, y: 116, width: 180, height: 24, baseline: 140 }],
      style: { fontName: 'unknown', fontSize: 24, alignment: 'left', lineHeight: 1.2 },
    };
    const target = { x: 280, y: 300, width: 280, height: 150 };
    const edit: TextEditOperation = {
      blockId: block.id, originalText: 'OLD SOURCE', newText: 'Ag 中文（排版，测试。）多个汉字自动换行，标点保持。 Latin words for justified wrapping.', timestamp: 2,
      layout: { targetRect: target, fontName: 'Helvetica-Oblique', fontSize: 22, fontColor: '#008000', alignment: 'justify', lineHeight: 1.3 },
    };
    const style = await prepareTextEditLayout(buffer(source), block, { ...edit, layout: { targetRect: target } });
    expect(style.input).toMatchObject({ fontName: 'Helvetica-Bold', fontColor: '#b31a33' });
    const layout = (await prepareTextEditLayout(buffer(source), block, edit)).layout;
    expect(layout.fits).toBe(true); expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(line.text).not.toMatch(/^[，。、；：？！）》】]/u); expect(line.text).not.toMatch(/[（《【]$/u);
      if (!line.paragraphEnd) expect(line.width).toBeCloseTo(target.width, 3);
    }
    const workspace = createWorkspace();
    workspace.editing.textBlocks.set(1, [block]);
    workspace.editing.textEdits = [{ ...edit, newText: block.text, layout: undefined, timestamp: 1 }];
    const beforeWorkspace = structuredClone(workspace);
    const output = await previewWorkspaceTextEdit(buffer(source), workspace, edit), before = inspect(source), after = inspect(output);
    expect(after.text).not.toContain('OLD SOURCE'); expect(after.text).toContain('PUBLIC NEIGHBOR');
    expect(after.text).toContain('MANAGED MARK'); expect(after.text).toContain('中文');
    expect(after.images).toBe(before.images); expect(after.images).toBe(1); expect(after.blue).toBeGreaterThanOrEqual(before.blue);
    const native = new mupdf.PDFDocument(output), page = native.loadPage(0);
    try {
      const bounds = toMuPDFPageRect(mupdf, page, target);
      expect(after.green[0]).toBeGreaterThanOrEqual(bounds[0] - 1); expect(after.green[1]).toBeGreaterThanOrEqual(bounds[1] - 1);
      expect(after.green[2]).toBeGreaterThan(after.green[0]); expect(after.green[3]).toBeGreaterThan(after.green[1]);
      expect(after.green[2]).toBeLessThanOrEqual(bounds[2] + 1); expect(after.green[3]).toBeLessThanOrEqual(bounds[3] + 1);
    } finally { page.destroy(); native.destroy(); }
    const marks = await inspectPageDecorations(buffer(output));
    expect(marks.decorations).toHaveLength(1); expect(marks.decorations[0].managed).toBe(true);
    expect(workspace).toEqual(beforeWorkspace); expect(Buffer.from(source).equals(untouched)).toBe(true);
  });
});
