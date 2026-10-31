/** Transform text baselines with the page viewport, including CropBox, Rotate and UserUnit. */
export function textLayerGeometry(item: { transform: number[]; width: number; height: number },
  viewport: { transform: number[] }, style?: { ascent?: number; descent?: number; vertical?: boolean }) {
  const a = viewport.transform, b = item.transform;
  const tx = [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  const angle = Math.atan2(tx[1], tx[0]) + (style?.vertical ? Math.PI / 2 : 0);
  const height = Math.hypot(tx[2], tx[3]);
  const ascent = height * (style?.ascent ?? (style?.descent !== undefined ? 1 + style.descent : .8));
  return { left: tx[4] + ascent * Math.sin(angle), top: tx[5] - ascent * Math.cos(angle), height, angle,
    width: (style?.vertical ? item.height : item.width) * Math.hypot(a[0], a[1]) };
}
