import { describe, expect, it } from 'vitest';
import { moveObjectRect, resizeObjectRect } from '../../src/editing/objectGeometry';

const rect = { x: 30, y: 40, width: 100, height: 50 }, bounds = { width: 400, height: 500 };
describe('object transform geometry', () => {
  it('keeps moved objects inside the visible page without changing their size', () => {
    expect(moveObjectRect(rect, -100, 800, bounds)).toEqual({ x: 0, y: 450, width: 100, height: 50 });
  });
  it('does not relocate a partly clipped object on selection or when moving along its other axis', () => {
    const clipped = { x: -20, y: 40, width: 100, height: 50 };
    expect(moveObjectRect(clipped, 0, 0, bounds)).toEqual(clipped);
    expect(moveObjectRect(clipped, 0, 5, bounds)).toEqual({ ...clipped, y: 45 });
    expect(moveObjectRect(clipped, 5, 0, bounds).x).toBe(-15);
    expect(moveObjectRect(clipped, -5, 0, bounds).x).toBe(-20);
    const oversized = { x: -40, y: -30, width: 500, height: 600 };
    expect(moveObjectRect(oversized, 0, 0, bounds)).toEqual(oversized);
    expect(moveObjectRect(oversized, -20, -20, bounds)).toEqual({ ...oversized, x: -60, y: -50 });
  });
  it('resizes partly clipped objects from their current size without snapping or flipping', () => {
    const clipped = { x: -20, y: -10, width: 100, height: 50 };
    expect(resizeObjectRect(clipped, 'nw', 0, 0, bounds, true)).toEqual(clipped);
    expect(resizeObjectRect(clipped, 'w', 5, 0, bounds, false)).toEqual({ ...clipped, x: -15, width: 95 });
    expect(resizeObjectRect(clipped, 'nw', 10, 5, bounds, true)).toEqual({ x: -10, y: -5, width: 90, height: 45 });
    const beyond = { x: 410, y: 510, width: 100, height: 50 };
    expect(resizeObjectRect(beyond, 'se', -10, -5, bounds, true)).toEqual({ ...beyond, width: 90, height: 45 });
  });
  it('preserves aspect ratio and the opposite corner while growing and shrinking', () => {
    expect(resizeObjectRect(rect, 'se', 40, 0, bounds, true)).toEqual({ x: 30, y: 40, width: 140, height: 70 });
    expect(resizeObjectRect(rect, 'nw', 20, 0, bounds, true)).toEqual({ x: 50, y: 50, width: 80, height: 40 });
  });
  it('stops a proportional corner at the first page boundary', () => {
    const result = resizeObjectRect(rect, 'nw', -1000, -1000, bounds, true);
    expect(result.x).toBeCloseTo(0); expect(result.y).toBeCloseTo(25);
    expect(result.width / result.height).toBeCloseTo(2);
    expect(result.x + result.width).toBeCloseTo(130); expect(result.y + result.height).toBeCloseTo(90);
  });
  it('allows free corner resizing and independent side resizing', () => {
    expect(resizeObjectRect(rect, 'se', 40, 5, bounds, false)).toEqual({ x: 30, y: 40, width: 140, height: 55 });
    expect(resizeObjectRect(rect, 'e', 40, 100, bounds, false)).toEqual({ x: 30, y: 40, width: 140, height: 50 });
  });
  it('prevents a handle crossing its fixed anchor or producing zero dimensions', () => {
    expect(resizeObjectRect(rect, 'nw', 900, 900, bounds, false)).toEqual({ x: 126, y: 86, width: 4, height: 4 });
    const proportional = resizeObjectRect(rect, 'se', -900, -900, bounds, true);
    expect(proportional.width).toBe(8); expect(proportional.height).toBe(4);
  });
});
