/** Load the local WASM engine only when a PDF transformation needs it. */
let engine: Promise<typeof import('mupdf')> | undefined;

export function loadMuPDF(): Promise<typeof import('mupdf')> {
  engine ??= import('mupdf');
  return engine;
}

function readBox(object: import('mupdf').PDFObject): number[] | null {
  if (!object.isArray() || object.length !== 4) return null;
  const result: number[] = [];
  for (let index = 0; index < 4; index++) {
    const value = object.get(index);
    try {
      if (!value.isNumber()) return null;
      result.push(value.asNumber());
    } finally { value.destroy(); }
  }
  if (!result.every(Number.isFinite)) return null;
  return [Math.min(result[0], result[2]), Math.min(result[1], result[3]),
    Math.max(result[0], result[2]), Math.max(result[1], result[3])];
}

function assertCompatiblePageBoxes(page: import('mupdf').PDFPage) {
  const object = page.getObject();
  try {
    const mediaObject = object.getInheritable('MediaBox');
    try {
      const cropObject = object.getInheritable('CropBox');
      try {
        const media = readBox(mediaObject);
        const crop = readBox(cropObject);
        // PDF.js falls back to MediaBox here, whereas MuPDF can fall back to
        // US Letter. Refuse ambiguous coordinates instead of deleting elsewhere.
        if (media && crop && (Math.max(media[0], crop[0]) >= Math.min(media[2], crop[2]) ||
          Math.max(media[1], crop[1]) >= Math.min(media[3], crop[3]))) {
          throw new Error('Cannot remove content from a PDF with a CropBox outside its MediaBox');
        }
      } finally { cropObject.destroy(); }
    } finally { mediaObject.destroy(); }
  } finally { object.destroy(); }
}

/** A thin strip through a source text row, in MuPDF page space. MuPDF removes each glyph
 * whose whole font box touches a redaction, and font boxes of neighboring rows overlap:
 * a row's full height also deletes the row above. A strip inside the x-height reaches
 * every glyph of its own row (punctuation included), and text outside the page too. */
export function toMuPDFTextRowQuad(
  mupdf: Awaited<ReturnType<typeof loadMuPDF>>,
  page: import('mupdf').PDFPage,
  row: { x: number; width: number; baseline: number; size: number },
): import('mupdf').Quad {
  assertCompatiblePageBoxes(page);
  const transform = page.getTransform();
  const crop = mupdf.Rect.transform(page.getBounds(), mupdf.Matrix.invert(transform));
  const unit = Math.hypot(transform[0], transform[1]);
  const top = row.baseline - row.size * .305, bottom = row.baseline - row.size * .295;
  const point = (x: number, y: number) => {
    const px = crop[0] + x / unit, py = crop[3] - y / unit;
    return [px * transform[0] + py * transform[2] + transform[4], px * transform[1] + py * transform[3] + transform[5]];
  };
  const a = row.x, b = row.x + row.width;
  return [...point(a, top), ...point(b, top), ...point(a, bottom), ...point(b, bottom)] as import('mupdf').Quad;
}

/** Map PDF.js scale=1, unrotated, CropBox-relative top-left coordinates to MuPDF page space. */
export function toMuPDFPageRect(
  mupdf: Awaited<ReturnType<typeof loadMuPDF>>,
  page: import('mupdf').PDFPage,
  rect: { x: number; y: number; width: number; height: number },
): import('mupdf').Rect {
  assertCompatiblePageBoxes(page);
  const transform = page.getTransform(); // Native PDF user space -> MuPDF page space.
  const crop = mupdf.Rect.transform(page.getBounds(), mupdf.Matrix.invert(transform));
  const unit = Math.hypot(transform[0], transform[1]);
  const width = (crop[2] - crop[0]) * unit;
  const height = (crop[3] - crop[1]) * unit;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width);
  const y1 = Math.min(height, rect.y + rect.height);
  if (![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite) || !Number.isFinite(unit) || unit <= 0 || x1 <= x0 || y1 <= y0) {
    throw new Error('Content-removal area is invalid or outside the visible page');
  }
  const pdfRect: import('mupdf').Rect = [crop[0] + x0 / unit, crop[3] - y1 / unit, crop[0] + x1 / unit, crop[3] - y0 / unit];
  return mupdf.Rect.transform(pdfRect, transform);
}
