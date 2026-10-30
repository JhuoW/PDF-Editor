import { describe, expect, it } from 'vitest';
import { moveObjectRect, resizeObjectRect } from '../../src/editing/objectGeometry';

const rect = { x: 30, y: 40, width: 100, height: 50 }, bounds = { width: 400, height: 500 };
describe('object transform geometry', () => {
  it('keeps moved objects inside the visible page without changing their size', () => {
    expect(moveObjectRect(rect, -100, 800, bounds)).toEqual({ x: 0, y: 450, width: 100, height: 50 });
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
