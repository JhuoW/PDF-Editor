import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { cropPDFPages } from '../../src/core/PageManagement';
import { capturePageCrop, displayPageCrop, normalizePageCrop, pageCropMargins } from '../../src/components/PDFViewer/pageCropGeometry';
import { inverseMatrix, type ImageMatrix } from '../../src/editing/imageMatrix';

function viewport(rotation: number, scale = 1) {
  const unit = 2 * scale, matrices: Record<number, ImageMatrix> = {
    0: [unit, 0, 0, -unit, -20 * unit, 430 * unit],
    90: [0, unit, unit, 0, -30 * unit, -20 * unit],
    180: [-unit, 0, 0, unit, 320 * unit, -30 * unit],
    270: [0, -unit, -unit, 0, 430 * unit, 320 * unit],
  };
  const matrix = matrices[rotation], inverse = inverseMatrix(matrix);
  const point = (x: number, y: number, m: ImageMatrix) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return { width: (rotation % 180 ? 400 : 300) * unit, height: (rotation % 180 ? 300 : 400) * unit,
    convertToPdfPoint: (x: number, y: number) => point(x, y, inverse), convertToViewportPoint: (x: number, y: number) => point(x, y, matrix) };
}

describe('visual page cropping geometry', () => {
  for (const intrinsic of [0, 90, 180, 270]) it(`keeps the selected PDF content through zoom and view rotation on an intrinsic ${intrinsic}° cropped UserUnit page`, async () => {
    const native = viewport(intrinsic), selection = { x: .1, y: .2, width: .6, height: .5 };
    for (const rotation of [0, 90, 180, 270]) for (const zoom of [.25, 1, 3]) {
      const display = viewport(rotation, zoom), drawn = displayPageCrop(selection, native, display), captured = capturePageCrop(drawn, display, native);
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(captured[key]).toBeCloseTo(selection[key], 10);
    }
    const source = await PDFDocument.create(), page = source.addPage([400, 500]);
    page.setCropBox(20, 30, 300, 400); page.setRotation(degrees(intrinsic)); page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const result = await cropPDFPages(new Uint8Array(await source.save()).buffer, [1], pageCropMargins(selection, native));
    const cropped = (await PDFDocument.load(result)).getPage(0).getCropBox();
    const corners = [native.convertToPdfPoint(selection.x * native.width, selection.y * native.height),
      native.convertToPdfPoint((selection.x + selection.width) * native.width, (selection.y + selection.height) * native.height)];
    expect(cropped.x).toBeCloseTo(Math.min(corners[0][0], corners[1][0]), 6);
    expect(cropped.y).toBeCloseTo(Math.min(corners[0][1], corners[1][1]), 6);
    expect(cropped.width).toBeCloseTo(Math.abs(corners[0][0] - corners[1][0]), 6);
    expect(cropped.height).toBeCloseTo(Math.abs(corners[0][1] - corners[1][1]), 6);
  });
  it('clips a drawn rectangle to the visible page bounds', () => {
    expect(normalizePageCrop({ x: -20, y: 10, width: 150, height: 300 }, { width: 100, height: 200 })).toEqual({ x: 0, y: .05, width: 1, height: .95 });
  });
});
