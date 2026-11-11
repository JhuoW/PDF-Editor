/** Zoom limits and gesture conversion shared by the viewer and its tests. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
// Chromium and Safari report a trackpad pinch as Ctrl+wheel events whose deltas
// satisfy scale = exp(-deltaY / 100); following that keeps the page under the fingers.
const PINCH_DELTA_SCALE = 100;
// A held Ctrl key with a 100-pixel mouse wheel notch changes zoom by 25%.
const WHEEL_DELTA_SCALE = 100 / Math.log(1.25);

/** Converts one Ctrl+wheel event into a multiplicative zoom factor. */
export function wheelZoomFactor(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, ctrlKeyHeld: boolean, pageHeight = 800) {
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? pageHeight : 1;
  return Math.exp(-(event.deltaY * unit) / (ctrlKeyHeld ? WHEEL_DELTA_SCALE : PINCH_DELTA_SCALE));
}
