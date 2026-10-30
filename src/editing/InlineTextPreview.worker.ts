import { prepareTextEditLayout, previewInlineTextEdits } from './TextEditApplier';
import { loadMuPDF } from '../utils/mupdf';
import type { InlineTextPreviewRequest } from './InlineTextPreviewClient';

let source: ArrayBuffer | undefined;
self.onmessage = async (event: MessageEvent<InlineTextPreviewRequest>) => {
  const request = event.data;
  try {
    if (request.data) source = request.data;
    if (!source) throw new Error('No PDF is available for text editing.');
    const blocks = new Map([[request.pageNumber, request.blocks]]);
    const active = request.blocks.find(block => block.id === request.activeId);
    const prepared = active ? await prepareTextEditLayout(source, active, request.edits.find(edit => edit.blockId === active.id)) : undefined;
    const bytes = await previewInlineTextEdits(source.slice(0), blocks, request.edits);
    const engine = await loadMuPDF();
    const availableRect = prepared?.availableRect;
    const document = new engine.PDFDocument(bytes);
    try {
      const page = document.loadPage(request.pageNumber - 1);
      try {
        const matrix = engine.Matrix.concat(engine.Matrix.scale(request.scale, request.scale), engine.Matrix.rotate(request.rotation));
        const pixmap = page.toPixmap(matrix, engine.ColorSpace.DeviceRGB, false, true);
        try {
          const png = new Uint8Array(pixmap.asPNG());
          self.postMessage({ id: request.id, activeId: request.activeId, png, prepared, bytes, availableRect }, { transfer: [png.buffer, bytes.buffer] });
        } finally { pixmap.destroy(); }
      } finally { page.destroy(); }
    } finally { document.destroy(); }
  } catch (cause) {
    self.postMessage({ id: request.id, activeId: request.activeId, error: cause instanceof Error ? cause.message : 'Could not update PDF text.' });
  }
};
