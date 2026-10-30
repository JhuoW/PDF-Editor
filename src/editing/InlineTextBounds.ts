import type { TextBlock, TextRect } from './types';
import type { PDFPage, Rect } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';

/** Read painted content so automatic growth also respects images and vectors. */
export function readInlineTextBounds(engine: Awaited<ReturnType<typeof loadMuPDF>>, page: PDFPage, block: TextBlock, width: number, height: number): TextRect {
  const obstacles: TextRect[] = [], inverse = engine.Matrix.invert(page.getTransform());
  const crop = engine.Rect.transform(page.getBounds(), inverse), unit = Math.hypot(...page.getTransform().slice(0, 2));
  const convert = (bounds: Rect): TextRect => {
    const rect = engine.Rect.transform(bounds, inverse);
    return { x: (rect[0] - crop[0]) * unit, y: (crop[3] - rect[3]) * unit, width: (rect[2] - rect[0]) * unit, height: (rect[3] - rect[1]) * unit };
  };
  const structured = page.toStructuredText('');
  try {
    structured.walk({ onChar(_character, _origin, font, _size, quad) {
      try {
        const rect = convert([Math.min(quad[0], quad[2], quad[4], quad[6]), Math.min(quad[1], quad[3], quad[5], quad[7]), Math.max(quad[0], quad[2], quad[4], quad[6]), Math.max(quad[1], quad[3], quad[5], quad[7])]);
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, source = block.rect;
        if (x < source.x || x > source.x + source.width || y < source.y || y > source.y + source.height) obstacles.push(rect);
      } finally { font.destroy(); }
    } });
  } finally { structured.destroy(); }
  const stroke = new engine.StrokeState({ lineWidth: 0, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 1 });
  const collect = (bounds: Rect) => { obstacles.push(convert(bounds)); };
  const device = new engine.Device({
    fillPath(path, _odd, matrix, color) { try { collect(path.getBounds(stroke, matrix)); } finally { path.destroy(); color.destroy(); } },
    strokePath(path, pen, matrix, color) { try { collect(path.getBounds(pen, matrix)); } finally { path.destroy(); pen.destroy(); color.destroy(); } },
    fillImage(image, matrix) { try { collect(engine.Rect.transform([0, 0, 1, 1], matrix)); } finally { image.destroy(); } },
    fillImageMask(image, matrix, color) { try { collect(engine.Rect.transform([0, 0, 1, 1], matrix)); } finally { image.destroy(); color.destroy(); } },
    fillShade(shade, matrix) { try { collect(engine.Rect.transform(shade.getBounds(), matrix)); } finally { shade.destroy(); } },
  });
  try { page.runPageContents(device, engine.Matrix.identity); device.close(); }
  finally { device.destroy(); stroke.destroy(); }
  return inlineAvailableRect(block, [block], width, height, obstacles);
}

/** Grow only into clear space; retain the original source removal rectangle. */
export function inlineAvailableRect(block: TextBlock, blocks: TextBlock[], width: number, height: number, artwork: TextRect[] = []): TextRect {
  const source = block.rect, gap = Math.min(4, block.style.fontSize * .25);
  const obstacles = [...blocks.filter(item => item.id !== block.id).map(item => item.rect), ...artwork];
  // Preserve paragraph widths and centered/right-aligned text. A single left-
  // aligned line can use clear space on its right before wrapping.
  let right = block.lines.length === 1 && block.style.alignment === 'left' ? width - Math.min(source.x, 24) : source.x + source.width;
  for (const rect of obstacles) {
    if (rect.x >= source.x + source.width - .1 && rect.y < source.y + source.height && rect.y + rect.height > source.y) right = Math.min(right, rect.x - gap);
  }
  right = Math.max(source.x + source.width, right);
  let bottom = height - Math.min(source.y, 24);
  for (const rect of obstacles) {
    if (rect.y >= source.y + source.height - .1 && rect.x < right && rect.x + rect.width > source.x) bottom = Math.min(bottom, rect.y - gap);
  }
  return { ...source, width: right - source.x, height: Math.max(source.height, bottom - source.y) };
}
