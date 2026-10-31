/** Limit backing pixels only; CSS/PDF coordinates and export resolution stay intact. */
export const VIEW_RASTER_LIMITS = { pixels: 16_000_000, dimension: 8192 };
export function boundedRaster(width: number, height: number, requestedScale = 1) {
  if (![width, height, requestedScale].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Page dimensions must be finite and positive.');
  }
  const scale = Math.min(requestedScale, VIEW_RASTER_LIMITS.dimension / width,
    VIEW_RASTER_LIMITS.dimension / height, Math.sqrt(VIEW_RASTER_LIMITS.pixels / width / height));
  // Preserve the ordinary high-DPI rounding used by the viewer.
  const round = scale === requestedScale && Math.ceil(width * scale) * Math.ceil(height * scale) <= VIEW_RASTER_LIMITS.pixels ? Math.ceil : Math.floor;
  return { width: Math.max(1, round(width * scale)), height: Math.max(1, round(height * scale)), scale };
}
