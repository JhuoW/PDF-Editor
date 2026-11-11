import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, wheelZoomFactor } from '../../src/components/PDFViewer/zoomGesture';

describe('wheel and pinch zoom factors', () => {
  it('follows the browser pinch scale for trackpad gestures', () => {
    // Chromium/Safari report pinch-out as negative deltaY with a synthetic Ctrl key.
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }, false)).toBeCloseTo(Math.E, 6);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, false)).toBeCloseTo(1 / Math.E, 6);
    // Opposite gestures cancel out instead of drifting.
    expect(wheelZoomFactor({ deltaY: -37, deltaMode: 0 }, false) * wheelZoomFactor({ deltaY: 37, deltaMode: 0 }, false)).toBeCloseTo(1, 10);
  });

  it('changes zoom by 25% per mouse wheel notch while Ctrl is physically held', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }, true)).toBeCloseTo(1.25, 6);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, true)).toBeCloseTo(0.8, 6);
  });

  it('normalizes line and page delta modes', () => {
    expect(wheelZoomFactor({ deltaY: -2.5, deltaMode: 1 }, true)).toBeCloseTo(1.25, 6);
    expect(wheelZoomFactor({ deltaY: -0.125, deltaMode: 2 }, true, 800)).toBeCloseTo(1.25, 6);
  });

  it('keeps the documented zoom range', () => {
    expect(MIN_ZOOM).toBe(0.25);
    expect(MAX_ZOOM).toBe(4);
  });
});
