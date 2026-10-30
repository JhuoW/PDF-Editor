import { prepareTextEditLayout, previewInlineTextEdits } from './TextEditApplier';
import { applyImageEdits } from './ImageEditApplier';
import { loadMuPDF } from '../utils/mupdf';
import type { InlineTextPreviewRequest } from './InlineTextPreviewClient';
import type { Device, Matrix, PDFPage, PDFWidget, Rect } from 'mupdf';

// MuPDF skips unsigned signature widgets even when they have an existing /AP.
// Replay that vector appearance in the disposable preview document only.
function runSignatureAppearance(page: PDFPage, widget: PDFWidget, device: Device, identity: Matrix): boolean {
  const object = widget.getObject(), appearance = object.get('AP'), normal = appearance.get('N');
  try {
    if (!normal.isStream()) return false;
    const box = normal.get('BBox'), matrix = normal.get('Matrix'), resources = normal.get('Resources');
    try {
      const bounds = box.asJS() as Rect, transform = matrix.isArray() ? matrix.asJS() as Matrix : identity;
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
        || !Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite)) return false;
      const stream = normal.readStream();
      try {
        const contents = new Uint8Array(stream.asUint8Array());
        const proxy = page.createAnnotation('Square');
        try {
          proxy.setBorderWidth(0);
          proxy.setRect(widget.getBounds());
          proxy.setAppearance('N', null, transform, bounds, resources, contents);
          proxy.run(device, identity);
        } finally { page.deleteAnnotation(proxy); proxy.destroy(); }
      } finally { stream.destroy(); }
      return true;
    } finally { box.destroy(); matrix.destroy(); resources.destroy(); }
  } finally { normal.destroy(); appearance.destroy(); object.destroy(); }
}

let source: ArrayBuffer | undefined;
self.onmessage = async (event: MessageEvent<InlineTextPreviewRequest>) => {
  const request = event.data;
  try {
    if (request.data) source = request.data;
    if (!source) throw new Error('No PDF is available for text editing.');
    const blocks = new Map([[request.pageNumber, request.blocks]]);
    const active = request.blocks.find(block => block.id === request.activeId);
    // Match the export pipeline: image occurrences refer to the original page
    // stream and must be rewritten before text removal rebuilds that stream.
    const imageBytes = request.imageEdits?.length
      ? await applyImageEdits(source.slice(0), new Map([[request.pageNumber, request.images ?? []]]), request.imageEdits) : null;
    const data = imageBytes ? new Uint8Array(imageBytes).buffer : source.slice(0);
    const prepared = active ? await prepareTextEditLayout(data, active, request.edits.find(edit => edit.blockId === active.id)) : undefined;
    const bytes = await previewInlineTextEdits(data, blocks, request.edits);
    const engine = await loadMuPDF();
    const availableRect = prepared?.availableRect;
    const document = new engine.PDFDocument(bytes);
    try {
      const page = document.loadPage(request.pageNumber - 1);
      try {
        const matrix = engine.Matrix.concat(engine.Matrix.scale(request.scale, request.scale), engine.Matrix.rotate(request.rotation));
        // Keep non-widget annotations and passive widgets (including signature
        // artwork). Editable form values are owned by the live HTML controls.
        const pixmap = (() => {
          if (!request.htmlForms) return page.toPixmap(matrix, engine.ColorSpace.DeviceRGB, false, true);
          const display = new engine.DisplayList(page.getBounds());
          try {
            const device = new engine.DisplayListDevice(display);
            try {
              page.runPageContents(device, engine.Matrix.identity);
              page.runPageAnnots(device, engine.Matrix.identity);
              for (const widget of page.getWidgets()) {
                try {
                  const interactive = !(widget.getFieldFlags() & engine.PDFWidget.FIELD_IS_READ_ONLY)
                    && (widget.isText() || widget.isChoice() || widget.isCheckbox() || widget.isRadioButton());
                  if (!interactive && !(widget.getFlags() & (engine.PDFAnnotation.IS_INVISIBLE | engine.PDFAnnotation.IS_HIDDEN | engine.PDFAnnotation.IS_NO_VIEW))) {
                    if (widget.getFieldType() !== 'signature' || !runSignatureAppearance(page, widget, device, engine.Matrix.identity)) widget.run(device, engine.Matrix.identity);
                  }
                } finally { widget.destroy(); }
              }
              device.close();
            } finally { device.destroy(); }
            return display.toPixmap(matrix, engine.ColorSpace.DeviceRGB, false);
          } finally { display.destroy(); }
        })();
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
