import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPageDecorations, inspectPageDecorations } from '../../src/core/PageDecorations';
import { inspectDecorationDocument } from '../../src/core/PageDecorationManifest';
import { PAGE_DECORATION_MARKERS } from '../../src/core/PageDecorationMarkers';
import type { WatermarkDecoration } from '../../src/core/PageDecorationTypes';
import { preservePageDecorations } from '../../src/core/PreservePageDecorations';
import { applyWorkspaceContent } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { applySecureRedactions } from '../../src/editing/SecureRedaction';
import { reorderPages, deletePages, splitPDF, mergePDFs } from '../../src/core/PDFManipulator';
import type { PDFImage, TextBlock } from '../../src/editing/types';

const buffer = (data: Uint8Array): ArrayBuffer => new Uint8Array(data).buffer;
const watermark = (pages = [1]): WatermarkDecoration => ({ kind: 'watermark', name: 'Review', pages, opacity: 0.7,
  angle: 0, layer: 'foreground', position: { anchor: 'center', offsetX: 0, offsetY: 0 },
  content: { type: 'text', text: 'DECORATION_SECRET', fontFamily: 'Helvetica', fontSize: 18, color: '#CC0000' } });
function png(color: [number, number, number]) {
  const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
  try { const bytes = pixels.getPixels(); for (let offset = 0; offset < bytes.length; offset += 3) bytes.set(color, offset); return new Uint8Array(pixels.asPNG()); }
  finally { pixels.destroy(); }
}
async function fixture(count = 1) {
  const pdf = await PDFDocument.create(); pdf.setTitle('Original document');
  const image = await pdf.embedPng(png([255, 0, 0]));
  for (let index = 0; index < count; index++) {
    const page = pdf.addPage([400, 600]);
    page.drawText(`BODY PAGE ${index + 1}`, { x: 30, y: 520, size: 12 });
    page.drawImage(image, { x: 30, y: 100, width: 50, height: 40 });
  }
  const field = pdf.getForm().createTextField('Preserved'); field.setText('Form value');
  field.addToPage(pdf.getPage(0), { x: 30, y: 30, width: 150, height: 25 });
  return buffer(await pdf.save());
}
function render(data: Uint8Array | ArrayBuffer, index = 0) {
  const pdf = new mupdf.PDFDocument(data), page = pdf.loadPage(index);
  const text = page.toStructuredText(''), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
  try { return { text: text.asText(), pixels: new Uint8Array(pixmap.getPixels()), width: pixmap.getWidth() }; }
  finally { pixmap.destroy(); text.destroy(); page.destroy(); pdf.destroy(); }
}
function bodyBlock(): TextBlock {
  return { id: 'body', pageNumber: 1, text: 'BODY PAGE 1', editable: true,
    rect: { x: 30, y: 60, width: 220, height: 40 },
    lines: [{ items: [], text: 'BODY PAGE 1', x: 30, y: 68, width: 90, height: 12, baseline: 80 }],
    style: { fontName: 'Helvetica', fontSize: 12, alignment: 'left', lineHeight: 1.2 } };
}
async function stringsInPDF(data: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(data), seen = new Set<PDFObject>(), values: string[] = [];
  const visit = (object: PDFObject) => {
    object = pdf.context.lookup(object); if (!object || seen.has(object)) return; seen.add(object);
    if (object instanceof PDFString || object instanceof PDFHexString) values.push(object.decodeText());
    else if (object instanceof PDFDict) for (const [, value] of object.entries()) visit(value);
    else if (object instanceof PDFArray) for (const value of object.asArray()) visit(value);
    else if (object instanceof PDFRawStream) { visit(object.dict); values.push(new TextDecoder().decode(decodePDFRawStream(object).decode())); }
  };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) visit(object);
  return values.join('\n');
}
function externallyRewriteMark(data: Uint8Array, name: string) {
  const pdf = new mupdf.PDFDocument(data);
  try {
    for (let index = 0; index < pdf.countPages(); index++) {
      const page = pdf.loadPage(index), object = page.getObject(), contents = object.get('Contents');
      try {
        for (let streamIndex = 0; streamIndex < contents.length; streamIndex++) {
          const stream = contents.get(streamIndex), metadata = stream.get(PAGE_DECORATION_MARKERS.manifest);
          try {
            if (metadata.isString() && JSON.parse(metadata.asString()).definition.name === name) {
              const body = stream.readStream();
              try { stream.writeStream(`${body.asString()}\n% external rewrite\n`); } finally { body.destroy(); }
            }
          } finally { metadata.destroy(); stream.destroy(); }
        }
      } finally { contents.destroy(); object.destroy(); page.destroy(); }
    }
    const saved = pdf.saveToBuffer('garbage=1,compress');
    try { return new Uint8Array(saved.asUint8Array()); } finally { saved.destroy(); }
  } finally { pdf.destroy(); }
}

describe('page decorations across editing and page operations', () => {
  it('keeps marks editable after an original-body text replacement and can then remove them cleanly', async () => {
    const source = await fixture(), marked = await applyPageDecorations(source, [{ type: 'create', definition: watermark() }]);
    const item = (await inspectPageDecorations(buffer(marked))).decorations[0];
    const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [bodyBlock()]);
    workspace.editing.textEdits.push({ blockId: 'body', originalText: 'BODY PAGE 1', newText: 'UPDATED BODY', timestamp: 1 });
    const edited = await applyWorkspaceContent(buffer(marked), workspace);
    expect(render(edited).text).toContain('UPDATED BODY'); expect(render(edited).text).not.toContain('BODY PAGE 1');
    expect(render(edited).text).toContain('DECORATION_SECRET');
    expect((await inspectPageDecorations(buffer(edited))).decorations[0]).toMatchObject({ id: item.id, managed: true });
    expect((await PDFDocument.load(edited)).getForm().getTextField('Preserved').getText()).toBe('Form value');
    const removed = await applyPageDecorations(buffer(edited), [{ type: 'remove', id: item.id }]);
    expect(render(removed).text).toContain('UPDATED BODY'); expect(render(removed).text).not.toContain('DECORATION_SECRET');
    expect(await stringsInPDF(removed)).not.toContain('DECORATION_SECRET');
  });

  it('reuses intact graphics-state boundaries after an identity body transform', async () => {
    const original = await fixture(), marked = await applyPageDecorations(original, [{ type: 'create', definition: watermark() }]);
    const item = (await inspectPageDecorations(buffer(marked))).decorations[0];
    const preserved = await preservePageDecorations(buffer(marked), new Set([1]), async body => new Uint8Array(body));
    expect(render(preserved).pixels).toEqual(render(marked).pixels);
    const removed = await applyPageDecorations(buffer(preserved), [{ type: 'remove', id: item.id }]);
    expect(render(removed).pixels).toEqual(render(original).pixels);
  });

  it.each([false, true])('rejects body editing when an unmanaged mark could be erased or reordered (mixed=%s)', async mixed => {
    const definition = watermark(); definition.position = { anchor: 'top-left', offsetX: 30, offsetY: 60 };
    const marked = await applyPageDecorations(await fixture(), [
      { type: 'create', definition },
      ...(mixed ? [{ type: 'create' as const, definition: { ...watermark(), name: 'Intact' } }] : []),
    ]);
    const unsafe = externallyRewriteMark(marked, 'Review'), before = new Uint8Array(unsafe);
    expect((await inspectPageDecorations(buffer(unsafe))).decorations.find(item => item.definition.name === 'Review')!.managed).toBe(false);
    const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [bodyBlock()]);
    workspace.editing.textEdits.push({ blockId: 'body', originalText: 'BODY PAGE 1', newText: 'UPDATED BODY', timestamp: 1 });
    await expect(applyWorkspaceContent(buffer(unsafe), workspace)).rejects.toThrow('missing or changed editing metadata');
    expect(unsafe).toEqual(before); expect(render(unsafe).text).toContain('DECORATION_SECRET');
    expect(workspace.editing.textEdits).toHaveLength(1);
  });

  it('allows editing another page when the unmanaged decoration is elsewhere', async () => {
    const marked = await applyPageDecorations(await fixture(2), [{ type: 'create', definition: watermark([2]) }]);
    const unsafe = externallyRewriteMark(marked, 'Review');
    const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [bodyBlock()]);
    workspace.editing.textEdits.push({ blockId: 'body', originalText: 'BODY PAGE 1', newText: 'UPDATED BODY', timestamp: 1 });
    const edited = await applyWorkspaceContent(buffer(unsafe), workspace);
    expect(render(edited).text).toContain('UPDATED BODY');
    expect(render(edited, 1).pixels).toEqual(render(unsafe, 1).pixels);
  });

  it('rebases body image occurrences around background and foreground image marks without changing them', async () => {
    const original = await fixture();
    const blue = png([0, 0, 255]);
    const definition = watermark(); definition.content = { type: 'image', name: 'watermark.png', data: blue, width: 60, height: 60 };
    const marked = await applyPageDecorations(original, [
      { type: 'create', definition: { kind: 'background', name: 'Paper', pages: [1], opacity: 0.2, fill: { type: 'image', name: 'paper.png', data: blue, fit: 'cover' } } },
      { type: 'create', definition },
    ]);
    const native = new mupdf.PDFDocument(marked);
    const { records } = await inspectDecorationDocument(native); native.destroy();
    const background = records.find(record => record.manifest.layer === 'background')!.manifest.instanceId;
    const foreground = records.find(record => record.manifest.layer === 'foreground')!.manifest.instanceId;
    const image = (id: string, occurrence: number, decorationInstance?: string): PDFImage => ({ id, pageNumber: 1, objectName: id,
      rect: { x: 30, y: 460, width: 50, height: 40 }, originalRect: { x: 30, y: 460, width: 50, height: 40 },
      source: { occurrence, occurrenceCount: 3, transform: [50, 0, 0, 40, 30, 100], pixelWidth: 4, pixelHeight: 4, insideForm: !!decorationInstance, decorationInstance },
      ...(decorationInstance ? { unsupportedReason: 'Use the decorations settings.' } : {}),
    });
    const workspace = createWorkspace(); workspace.editing.images.set(1, [image('background', 0, background), image('body', 1), image('watermark', 2, foreground)]);
    workspace.editing.imageEdits.push({ type: 'replace', imageId: 'body', newImageData: buffer(png([0, 255, 0])), timestamp: 1 });
    const changed = await applyWorkspaceContent(buffer(marked), workspace);
    expect((await inspectPageDecorations(buffer(changed))).decorations.every(item => item.managed)).toBe(true);
    const before = render(marked), after = render(changed);
    for (let y = 0; y < 600; y++) for (let x = 0; x < 400; x++) {
      if (x >= 29 && x <= 81 && y >= 459 && y <= 501) continue;
      const offset = (y * 400 + x) * 3;
      if (after.pixels[offset] !== before.pixels[offset] || after.pixels[offset + 1] !== before.pixels[offset + 1] || after.pixels[offset + 2] !== before.pixels[offset + 2]) throw new Error(`An unrelated pixel changed at ${x},${y}`);
    }
    expect([...after.pixels.slice((470 * 400 + 40) * 3, (470 * 400 + 40) * 3 + 3)]).toEqual([0, 255, 0]);
    expect(workspace.editing.images.get(1)![1].source!.occurrence).toBe(1);
  });

  it('preserves managed page marks through reorder, deletion, split and merge', async () => {
    let data = await applyPageDecorations(await fixture(3), [{ type: 'create', definition: watermark([1, 3]) }]);
    data = await reorderPages(buffer(data), [3, 2, 1]);
    let item = (await inspectPageDecorations(buffer(data))).decorations[0];
    expect(item.managed).toBe(true); expect(item.needsRefresh).toBe(true);
    data = await deletePages(buffer(data), [2]);
    item = (await inspectPageDecorations(buffer(data))).decorations[0]; expect(item.managed).toBe(true);
    const parts = await splitPDF(buffer(data), { mode: 'every-n-pages', everyN: 1 });
    expect(parts).toHaveLength(2);
    const merged = await mergePDFs(parts.map(buffer));
    item = (await inspectPageDecorations(buffer(merged))).decorations[0]; expect(item.managed, item.reason).toBe(true);
    const removed = await applyPageDecorations(buffer(merged), [{ type: 'remove', id: item.id }]);
    expect(render(removed, 0).text).toContain('BODY PAGE 3'); expect(render(removed, 1).text).toContain('BODY PAGE 1');
    expect(render(removed, 0).text).not.toContain('DECORATION_SECRET');
  });

  it('does not restore redacted decoration text or its saved configuration', async () => {
    const marked = await applyPageDecorations(await fixture(), [{ type: 'create', definition: watermark() }]);
    const bounds = (await inspectPageDecorations(buffer(marked))).decorations[0].placements[0].bounds;
    const redacted = await applySecureRedactions(buffer(marked), [{ id: 'erase', pageNumber: 1, applied: false, overlayColor: '#000000',
      rect: { x: bounds.x - 1, y: bounds.y - 1, width: bounds.width + 2, height: bounds.height + 2 } }]);
    expect(render(redacted).text).not.toContain('DECORATION_SECRET'); expect(render(redacted).text).toContain('BODY PAGE 1');
    expect(await stringsInPDF(redacted)).not.toContain('DECORATION_SECRET');
    const document = new mupdf.PDFDocument(redacted);
    try {
      for (let index = 1; index < document.countObjects(); index++) {
        const object = document.newIndirect(index), subtype = object.get('Subtype');
        try {
          if (!object.isStream() || subtype.asName() !== 'Form') continue;
          const standalone = new mupdf.PDFDocument();
          try {
            const form = standalone.graftObject(object), pageRef = standalone.addPage([0, 0, 1000, 1000], 0, { XObject: { Mark: form } }, '/Mark Do');
            standalone.insertPage(-1, pageRef); const page = standalone.loadPage(0), text = page.toStructuredText('');
            try { expect(text.asText()).not.toContain('DECORATION_SECRET'); }
            finally { text.destroy(); page.destroy(); pageRef.destroy(); form.destroy(); }
          } finally { standalone.destroy(); }
        } finally { subtype.destroy(); object.destroy(); }
      }
    } finally { document.destroy(); }
  });
});
