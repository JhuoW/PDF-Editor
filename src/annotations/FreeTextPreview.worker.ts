import { createFreeTextAppearance } from './FreeTextAppearance';
import type { FreeTextAnnotation } from './types';
import { loadMuPDF } from '../utils/mupdf';
import { boundedRaster } from '../utils/rasterBudget';
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; annotation: FreeTextAnnotation; scale: number }>) => {
  const request = event.data;
  queue = queue.catch(() => {}).then(async () => {
    try {
      const result = await createFreeTextAppearance(request.annotation), engine = await loadMuPDF(), document = new engine.PDFDocument(result.bytes);
      try {
        const page = document.loadPage(0), raster = boundedRaster(result.width, result.height, request.scale);
        try {
          const pixmap = page.toPixmap(engine.Matrix.scale(raster.scale, raster.scale), engine.ColorSpace.DeviceRGB, true, true);
          try {
            const png = new Uint8Array(pixmap.asPNG());
            self.postMessage({ id: request.id, png, width: result.width, height: result.height, contentHeight: result.contentHeight }, { transfer: [png.buffer] });
          } finally { pixmap.destroy(); }
        } finally { page.destroy(); }
      } finally { document.destroy(); }
    } catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
