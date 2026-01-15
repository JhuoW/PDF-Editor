import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';

export interface RenderOptions {
  scale: number;
  rotation: number;
  canvasContext: CanvasRenderingContext2D;
}

export interface PageDimensions {
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/**
 * Calculate effective rotation combining page's embedded rotation with view rotation.
 * PDF.js's getViewport({ rotation }) treats rotation as an override, not an addition.
 * This function combines the page's embedded rotation with any additional view rotation.
 */
export function getEffectiveRotation(page: PDFPageProxy, viewRotation: number = 0): number {
  // page.rotate gives the page's embedded rotation in degrees (0, 90, 180, or 270)
  const pageRotation = page.rotate || 0;
  // Combine and normalize to 0-359
  return ((pageRotation + viewRotation) % 360 + 360) % 360;
}

export function getPageDimensions(
  page: PDFPageProxy,
  scale: number,
  viewRotation: number = 0
): PageDimensions {
  // Combine page's embedded rotation with view rotation
  const effectiveRotation = getEffectiveRotation(page, viewRotation);
  const viewport = page.getViewport({ scale, rotation: effectiveRotation });

  // For original dimensions, still use effective rotation to get correct aspect ratio
  const originalViewport = page.getViewport({ scale: 1, rotation: effectiveRotation });

  return {
    width: viewport.width,
    height: viewport.height,
    originalWidth: originalViewport.width,
    originalHeight: originalViewport.height,
  };
}

export async function renderPage(
  page: PDFPageProxy,
  options: RenderOptions
): Promise<void> {
  const { scale, rotation: viewRotation, canvasContext } = options;
  // Combine page's embedded rotation with view rotation
  const effectiveRotation = getEffectiveRotation(page, viewRotation);
  const viewport = page.getViewport({ scale, rotation: effectiveRotation });

  const canvas = canvasContext.canvas;
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const renderContext = {
    canvasContext,
    viewport,
    canvas,
  };

  const renderTask: RenderTask = page.render(renderContext);
  await renderTask.promise;
}

export function cancelRender(renderTask: RenderTask): void {
  renderTask.cancel();
}
