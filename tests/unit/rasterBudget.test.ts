import { expect, it } from 'vitest';
import { boundedRaster, VIEW_RASTER_LIMITS } from '../../src/utils/rasterBudget';

it('preserves ordinary fractional high-DPI geometry', () => {
  expect(boundedRaster(600.25, 800.25, 1.5)).toEqual({ width: 901, height: 1201, scale: 1.5 });
});
it.each([[14400, 14400, 4], [14400, 120, 4], [20, 14400, 8]])('bounds a large or narrow page %s × %s at %s without changing its aspect ratio', (width, height, requested) => {
  const result = boundedRaster(width, height, requested);
  expect(result.width * result.height).toBeLessThanOrEqual(VIEW_RASTER_LIMITS.pixels);
  expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(VIEW_RASTER_LIMITS.dimension);
  expect(Math.abs(result.width - width * result.scale)).toBeLessThan(1);
  expect(Math.abs(result.height - height * result.scale)).toBeLessThan(1);
});
it.each([0, -1, NaN, Infinity])('rejects invalid dimensions %s', width => expect(() => boundedRaster(width, 100)).toThrow());
