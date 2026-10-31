import { afterEach, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { applyPageDecorations } from '../../src/core/PageDecorations';
import { exportWorkspacePDF } from '../../src/core/PDFExport';
import { createWorkspace } from '../../src/store/workspaceSnapshot';
import type { InlineTextPreviewRequest, InlineTextPreviewResult } from '../../src/editing/InlineTextPreviewClient';
import type { TextBlock } from '../../src/editing/types';

afterEach(() => vi.unstubAllGlobals());
function pixels(data: Uint8Array) {
  const document = new mupdf.PDFDocument(data), page = document.loadPage(0), pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  try { return new Uint8Array(pixmap.getPixels()); } finally { pixmap.destroy(); page.destroy(); document.destroy(); }
}
it('treats managed watermarks consistently in the actual preview worker and export during paragraph growth', async () => {
  const document = await PDFDocument.create(), page = document.addPage([400, 500]);
  const font = await document.embedFont(StandardFonts.Courier);
  page.drawText('alpha beta gamma', { x: 40, y: 420, size: 11, font });
  page.drawText('delta epsilon', { x: 40, y: 406, size: 11, font });
  const data = await applyPageDecorations(new Uint8Array(await document.save()).buffer, [{ type: 'create', definition: {
    kind: 'watermark', name: 'Managed watermark', pages: [1], angle: 0, opacity: .2, layer: 'background',
    position: { anchor: 'top-left', offsetX: 40, offsetY: 120 },
    content: { type: 'text', text: 'MANAGED MARK', fontFamily: 'Helvetica', fontSize: 12, color: '#999999' },
  } }]);
  const block: TextBlock = { id: 'paragraph', kind: 'paragraph', pageNumber: 1, text: 'alpha beta gamma\ndelta epsilon', editable: true,
    rect: { x: 40, y: 69, width: 105.6, height: 25 },
    lines: ['alpha beta gamma', 'delta epsilon'].map((text, index) => ({ text, x: 40, y: 69 + index * 14, width: font.widthOfTextAtSize(text, 11), height: 11, baseline: 80 + index * 14, items: [] })),
    style: { fontName: 'Courier', fontSize: 11, alignment: 'left', lineHeight: 14 / 11 } };
  const workspace = createWorkspace(); workspace.editing.textBlocks.set(1, [block]);
  workspace.editing.textEdits = [{ blockId: block.id, originalText: block.text, newText: 'alpha beta gamma delta epsilon '.repeat(5), timestamp: 1,
    layout: { keepBaseline: true, reflow: true, autoGrow: true, flow: 'paragraph' } }];
  const exported = await exportWorkspacePDF(new Uint8Array(data).buffer, workspace);
  let result: InlineTextPreviewResult | undefined;
  const worker = { onmessage: null as unknown as (event: { data: InlineTextPreviewRequest }) => Promise<void>, postMessage: (packet: InlineTextPreviewResult) => { result = packet; } };
  vi.stubGlobal('self', worker);
  await import('../../src/editing/InlineTextPreview.worker');
  await worker.onmessage({ data: { id: 1, data: new Uint8Array(data).buffer, pageNumber: 1, activeId: block.id, blocks: [block], edits: workspace.editing.textEdits, scale: 1, rotation: 0 } });
  expect(result?.error).toBeUndefined();
  expect(result?.prepared?.layout.fits).toBe(true);
  expect(result?.issues).toEqual([]);
  expect(pixels(result!.bytes!)).toEqual(pixels(exported));
});
