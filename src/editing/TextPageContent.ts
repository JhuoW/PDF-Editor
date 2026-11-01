import type { Font, Matrix, Path, PDFPage, Rect, StrokeState, Text } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';
import type { TextBlock, TextRect } from './types';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface PaintedGlyph { rect: TextRect; x: number; baseline: number; size: number }
export interface TextPageContent { glyphs: PaintedGlyph[]; artwork: TextRect[] }

export function sourceTextRow(block: TextBlock, x: number, baseline: number, size: number) {
  // PDF.js can combine a slightly lowered tilde/math character into a normal
  // text item. Preserve that real offset without claiming a neighboring row.
  return block.lines.find(line => Math.abs(line.baseline - baseline) < Math.max(1, size * .25)
    && x >= line.x - .5 && x < line.x + line.width + .5);
}
/** Match the physical source row, not its font box or the whitespace between rows. */
export function belongsToTextBlock(glyph: PaintedGlyph, block: TextBlock): boolean {
  return !!sourceTextRow(block, glyph.x, glyph.baseline, glyph.size);
}

/** Read actual painted glyphs once per page, in the same coordinates as text layout. */
export function readTextPageContent(engine: Engine, page: PDFPage): TextPageContent {
  const glyphs: PaintedGlyph[] = [], artwork: TextRect[] = [];
  const transform = page.getTransform(), inverse = engine.Matrix.invert(transform);
  const crop = engine.Rect.transform(page.getBounds(), inverse), unit = Math.hypot(transform[0], transform[1]);
  const viewport: Matrix = [unit, 0, 0, -unit, -crop[0] * unit, crop[3] * unit];
  const unrotate = engine.Matrix.concat(inverse, viewport);
  const convert = (bounds: Rect): TextRect => {
    const rect = engine.Rect.transform(bounds, unrotate);
    return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
  };
  const intersect = (a: Rect, b: Rect): Rect => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const clips: Rect[] = [page.getBounds()], masks: Rect[] = [], groupAlpha = [1];
  const visible = (bounds: Rect) => {
    const rect = intersect(bounds, clips.at(-1)!);
    return !masks.length && groupAlpha.at(-1)! > 0 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1] ? convert(rect) : undefined;
  };
  const collect = (bounds: Rect) => { const rect = visible(bounds); if (rect) artwork.push(rect); };
  const clip = (bounds: Rect) => clips.push(intersect(bounds, clips.at(-1)!));
  const stroke = new engine.StrokeState({ lineWidth: 0, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 1 });
  const measured = new Map<string, Rect>(), fonts = new Map<number, Font>();
  const readText = (text: Text, matrix: Matrix, pen?: StrokeState) => {
    try {
      text.walk({ showGlyph(font, trm, gid, unicode, wmode) {
        if (gid < 0 || (unicode >= 0 && /\s/u.test(String.fromCodePoint(unicode)))) return;
        if (!fonts.has(font.pointer)) fonts.set(font.pointer, new engine.Font(font.pointer));
        const key = `${font.pointer}:${gid}:${wmode}`;
        let bounds = measured.get(key);
        if (!bounds) {
          const glyph = new engine.Text();
          try {
            // Measuring at 100pt matches TextLayoutSession and avoids treating
            // a font's ascender/descender box as painted superscript content.
            glyph.showGlyph(font, [100, 0, 0, 100, 0, 0], gid, unicode, wmode);
            bounds = glyph.getBounds(stroke, engine.Matrix.identity); measured.set(key, bounds);
          } finally { glyph.destroy(); }
        }
        const placed = engine.Matrix.concat(trm, matrix);
        const scale: Matrix = [placed[0] / 100, placed[1] / 100, placed[2] / 100, placed[3] / 100, placed[4], placed[5]];
        let painted = engine.Rect.transform(bounds, scale);
        if (pen) {
          const pad = pen.getLineWidth() * Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3])) / 2;
          painted = [painted[0] - pad, painted[1] - pad, painted[2] + pad, painted[3] + pad];
        }
        const rect = visible(painted);
        if (rect) {
          const physical = engine.Matrix.concat(placed, unrotate);
          glyphs.push({ rect, x: physical[4], baseline: physical[5], size: Math.hypot(physical[2], physical[3]) });
        }
      } });
    } finally { text.destroy(); }
  };
  const strokePath = (path: Path, pen: StrokeState, matrix: Matrix) => {
    // A table border or an unfilled rectangle occupies its edges, not its
    // entire bounding box. Keep disconnected subpaths separate as well.
    let x = 0, y = 0, startX = 0, startY = 0;
    const segment = (draw: (part: Path) => void) => {
      const part = new engine.Path();
      try { part.moveTo(x, y); draw(part); collect(part.getBounds(pen, matrix)); }
      finally { part.destroy(); }
    };
    const curve = (a: number, b: number, c: number, d: number, e: number, f: number, depth = 0) => {
      const length = Math.hypot(e - x, f - y);
      const distance = (px: number, py: number) => length ? Math.abs((e - x) * (y - py) - (x - px) * (f - y)) / length : Math.hypot(px - x, py - y);
      const scale = Math.max(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]));
      if (depth >= 12 || Math.max(distance(a, b), distance(c, d)) * scale < .2) {
        segment(part => part.curveTo(a, b, c, d, e, f)); x = e; y = f; return;
      }
      const ax = (x + a) / 2, ay = (y + b) / 2, bx = (a + c) / 2, by = (b + d) / 2, cx = (c + e) / 2, cy = (d + f) / 2;
      const dx = (ax + bx) / 2, dy = (ay + by) / 2, ex = (bx + cx) / 2, ey = (by + cy) / 2;
      const mx = (dx + ex) / 2, my = (dy + ey) / 2;
      curve(ax, ay, dx, dy, mx, my, depth + 1);
      curve(ex, ey, cx, cy, e, f, depth + 1);
    };
    path.walk({
      moveTo(a, b) { x = startX = a; y = startY = b; },
      lineTo(a, b) { segment(part => part.lineTo(a, b)); x = a; y = b; },
      curveTo: curve,
      closePath() { segment(part => part.lineTo(startX, startY)); x = startX; y = startY; },
    });
  };
  const device = new engine.Device({
    fillText(text, matrix, color, _values, alpha) { try { if (alpha > 0) readText(text, matrix); else text.destroy(); } finally { color.destroy(); } },
    strokeText(text, pen, matrix, color, _values, alpha) { try { if (alpha > 0) readText(text, matrix, pen); else text.destroy(); } finally { pen.destroy(); color.destroy(); } },
    fillPath(path, _odd, matrix, color, _values, alpha) { try { if (alpha > 0) collect(path.getBounds(stroke, matrix)); } finally { path.destroy(); color.destroy(); } },
    strokePath(path, pen, matrix, color, _values, alpha) { try { if (alpha > 0) strokePath(path, pen, matrix); } finally { path.destroy(); pen.destroy(); color.destroy(); } },
    fillImage(image, matrix, alpha) { try { if (alpha > 0) collect(engine.Rect.transform([0, 0, 1, 1], matrix)); } finally { image.destroy(); } },
    fillImageMask(image, matrix, color, _values, alpha) { try { if (alpha > 0) collect(engine.Rect.transform([0, 0, 1, 1], matrix)); } finally { image.destroy(); color.destroy(); } },
    fillShade(shade, matrix, alpha) { try { if (alpha > 0) collect(engine.Rect.transform(shade.getBounds(), matrix)); } finally { shade.destroy(); } },
    clipPath(path, _odd, matrix) { try { clip(path.getBounds(stroke, matrix)); } finally { path.destroy(); } },
    clipStrokePath(path, pen, matrix) { try { clip(path.getBounds(pen, matrix)); } finally { path.destroy(); pen.destroy(); } },
    clipText(text, matrix) { try { clip(text.getBounds(stroke, matrix)); } finally { text.destroy(); } },
    clipStrokeText(text, pen, matrix) { try { clip(text.getBounds(pen, matrix)); } finally { text.destroy(); pen.destroy(); } },
    clipImageMask(image, matrix) { try { clip(engine.Rect.transform([0, 0, 1, 1], matrix)); } finally { image.destroy(); } },
    popClip() { if (clips.length > 1) clips.pop(); },
    beginMask(bounds, _luminosity, color) { masks.push(bounds); color.destroy(); },
    endMask() { const bounds = masks.pop(); if (bounds) clip(bounds); },
    beginGroup(_bounds, color, _isolated, _knockout, _blend, alpha) { groupAlpha.push(groupAlpha.at(-1)! * alpha); color?.destroy(); },
    endGroup() { if (groupAlpha.length > 1) groupAlpha.pop(); },
    ignoreText(text) { text.destroy(); },
  });
  try { page.runPageContents(device, engine.Matrix.identity); device.close(); }
  finally { device.destroy(); stroke.destroy(); for (const font of fonts.values()) font.destroy(); }
  // Borrowed getWidgets() wrappers are cached by MuPDF. Read raw rectangles so
  // repeated measurements cannot invalidate the page's live form handles.
  const object = page.getObject(), annotations = object.get('Annots');
  try {
    if (annotations.isArray()) annotations.forEach(annotation => {
      const subtype = annotation.get('Subtype'), bounds = annotation.get('Rect'), flags = annotation.get('F');
      try {
        const rect = bounds.asJS();
        if (subtype.asName() === 'Widget' && !(flags.asNumber() & 35) && Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite)) {
          artwork.push({ x: (rect[0] - crop[0]) * unit, y: (crop[3] - rect[3]) * unit, width: (rect[2] - rect[0]) * unit, height: (rect[3] - rect[1]) * unit });
        }
      } finally { subtype.destroy(); bounds.destroy(); flags.destroy(); annotation.destroy(); }
    });
  } finally { annotations.destroy(); object.destroy(); }
  return { glyphs, artwork };
}
