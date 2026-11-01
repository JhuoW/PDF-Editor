import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPageDecorations } from '../../src/core/PageDecorations';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import { prepareTextEditLayout } from '../../src/editing/TextEditApplier';
import type { PDFImage, TextBlock } from '../../src/editing/types';

async function fixture(imagePosition?: { x: number; y: number }) {
  const document = await PDFDocument.create(), page = document.addPage([400, 500]);
  const font = await document.embedFont(StandardFonts.Courier), rows = ['alpha beta gamma', 'delta epsilon'];
  rows.forEach((text, index) => page.drawText(text, { x: 40, y: 420 - index * 14, size: 11, font }));
  const images: PDFImage[] = [];
  if (imagePosition) {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
    let png: Uint8Array;
    try { pixmap.clear(80); png = new Uint8Array(pixmap.asPNG()); } finally { pixmap.destroy(); }
    const rect = { ...imagePosition, width: 60, height: 30 };
    page.drawImage(await document.embedPng(png), { x: rect.x, y: 500 - rect.y - rect.height, width: rect.width, height: rect.height });
    images.push({ id: 'picture', pageNumber: 1, objectName: 'picture', rect, originalRect: { ...rect },
      source: { occurrence: 0, occurrenceCount: 1, insideForm: false, pixelWidth: 4, pixelHeight: 4,
        transform: [60, 0, 0, 30, rect.x, 500 - rect.y - 30] } });
  }
  const block: TextBlock = { id: 'paragraph', kind: 'paragraph', pageNumber: 1, text: rows.join('\n'), editable: true,
    rect: { x: 40, y: 69, width: 105.6, height: 25 },
    lines: rows.map((text, index) => ({ text, x: 40, y: 69 + index * 14, width: font.widthOfTextAtSize(text, 11), height: 11, baseline: 80 + index * 14, items: [] })),
    style: { fontName: 'Courier', fontSize: 11, alignment: 'left', lineHeight: 14 / 11 } };
  const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [block]); workspace.editing.images.set(1, images);
  workspace.editing.textEdits = [{ blockId: block.id, originalText: block.text, newText: 'alpha beta gamma delta epsilon '.repeat(5), timestamp: 1,
    layout: { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' } }];
  const context = { blocks: [block], edits: workspace.editing.textEdits, images, imageEdits: workspace.editing.imageEdits };
  return { data: new Uint8Array(await document.save()).buffer, block, workspace, context };
}

describe('advanced layout measurement uses the same page artwork as export', () => {
  it('ignores passive managed watermarks during paragraph growth', async () => {
    const { data, block, workspace, context } = await fixture();
    const marked = await applyPageDecorations(data, [{ type: 'create', definition: {
      kind: 'watermark', name: 'Managed watermark', pages: [1], angle: 0, opacity: .2, layer: 'background',
      position: { anchor: 'top-left', offsetX: 40, offsetY: 120 },
      content: { type: 'text', text: 'MANAGED MARK', fontFamily: 'Helvetica', fontSize: 12, color: '#999999' },
    } }]);
    const exported = await exportWorkspacePDF(new Uint8Array(marked).buffer, workspace);
    expect(exported.byteLength).toBeGreaterThan(0);
    const measured = await prepareTextEditLayout(marked, block, context.edits[0], {}, context);
    expect(measured.layout.fits).toBe(true);
  });
  it('allows text growth into space released by an image deletion draft', async () => {
    const { data, block, workspace, context } = await fixture({ x: 40, y: 120 });
    context.imageEdits.push({ type: 'delete', imageId: 'picture', timestamp: 1 });
    const exported = await exportWorkspacePDF(data, workspace);
    expect(exported.byteLength).toBeGreaterThan(0);
    const measured = await prepareTextEditLayout(data, block, context.edits[0], {}, context);
    expect(measured.layout.fits).toBe(true);
  });
  it('detects a conflict at an image draft destination before export', async () => {
    const { data, block, workspace, context } = await fixture({ x: 280, y: 320 });
    context.imageEdits.push({ type: 'move', imageId: 'picture', timestamp: 1, newRect: { x: 40, y: 120, width: 60, height: 30 } });
    await expect(exportWorkspacePDF(data, workspace)).rejects.toThrow(/image, drawing/);
    const measured = await prepareTextEditLayout(data, block, context.edits[0], {}, context);
    expect(measured.layout.fits).toBe(false);
    expect(measured.layout.overflow).toContain('image, drawing');
  });
});
