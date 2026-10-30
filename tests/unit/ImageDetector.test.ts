import { describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { detectImages } from '../../src/editing/ImageDetector';
import { imageCropTag } from '../../src/editing/ImageCropMarker';
const OPS = vi.hoisted(() => ({ save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6, paintImageXObjectRepeat: 7, paintInlineImageXObject: 8, paintInlineImageXObjectGroup: 9, beginGroup: 10, beginMarkedContent: 11, beginMarkedContentProps: 12, endMarkedContent: 13 }));
vi.mock('pdfjs-dist', () => ({ OPS, AnnotationMode: { DISABLE: 0 } }));
function page(operations: [number, unknown[]][]) {
  return { pageNumber: 1, getViewport: () => ({ transform: [2, 0, 0, -2, -40, 1160] }),
    getOperatorList: async () => ({ fnArray: operations.map(([op]) => op), argsArray: operations.map(([, args]) => args) }) } as unknown as PDFPageProxy;
}
describe('detectImages', () => {
  it.each(['string', 'name-object'])('retains editable crop bounds without losing raw source geometry (%s)', async format => {
    const crop = { x: .5, y: 0, width: .5, height: 1 }, tag = imageCropTag(crop);
    const [image] = await detectImages(page([
      [OPS.beginMarkedContent, [format === 'string' ? tag : { name: tag }]],
      [OPS.transform, [80, 0, 0, 60, 80, 420]], [OPS.paintImageXObject, ['original', 8, 8]], [OPS.endMarkedContent, []],
    ]));
    expect(image.rect).toEqual({ x: 200, y: 200, width: 80, height: 120 });
    expect(image.source?.rawRect).toEqual({ x: 120, y: 200, width: 160, height: 120 });
    expect(image.source?.cropRect).toEqual(crop); expect(image.source?.insideForm).toBe(false);
  });
  it('uses UUID identities and all four transformed corners including crop offsets and UserUnit', async () => {
    const source = page([[OPS.transform, [50, 10, -20, 60, 40, 480]], [OPS.paintImageXObject, ['name', 4, 4]]]);
    const first = (await detectImages(source))[0], second = (await detectImages(source))[0];
    expect(first.id).not.toBe(second.id);
    expect(first.rect).toEqual({ x: 0, y: 60, width: 140, height: 140 });
    expect(first.source).toEqual({ occurrence: 0, occurrenceCount: 1, transform: [50, 10, -20, 60, 40, 480], pixelWidth: 4, pixelHeight: 4, insideForm: false });
  });
  it('tracks form transforms and preserves per-occurrence identity for repeated XObjects', async () => {
    const images = await detectImages(page([
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 20, 400], [0, 0, 100, 100]]],
      [OPS.transform, [30, 0, 0, 30, 10, 10]], [OPS.paintImageXObject, ['shared', 4, 4]],
      [OPS.paintFormXObjectEnd, []], [OPS.paintImageXObjectRepeat, ['shared', 50, 50, [40, 480, 200, 480]]],
    ]));
    expect(images.map(image => image.source?.occurrence)).toEqual([0, 1, 2]);
    expect(images.map(image => image.source?.transform)).toEqual([[30, 0, 0, 30, 30, 410], [50, 0, 0, 50, 40, 480], [50, 0, 0, 50, 200, 480]]);
    expect(images.map(image => image.source?.insideForm)).toEqual([true, false, false]);
  });
  it('marks ambiguous inline/group pages unsupported rather than guessing source draws', async () => {
    const images = await detectImages(page([[OPS.paintInlineImageXObject, [{}]], [OPS.paintImageXObject, ['name', 4, 4]]]));
    expect(images[0].unsupportedReason).toContain('inline');
  });

  it.each(['string', 'name-object'])('keeps image occurrence identities while directing batch marks to their settings (%s)', async format => {
    const instance = '12345678-1234-1234-1234-123456789abc';
    const tag = `PDFEditorDecoration_${instance}`;
    const images = await detectImages(page([
      [OPS.beginMarkedContentProps, ['Artifact', null]],
      [OPS.beginMarkedContent, [format === 'string' ? tag : { name: tag }]],
      [OPS.beginMarkedContent, ['Span']], [OPS.paintImageXObject, ['watermark', 4, 4]],
      [OPS.endMarkedContent, []], [OPS.endMarkedContent, []], [OPS.endMarkedContent, []],
      [OPS.paintImageXObject, ['body', 4, 4]],
    ]));
    expect(images[0].source).toMatchObject({ occurrence: 0, occurrenceCount: 2, decorationInstance: instance });
    expect(images[0].unsupportedReason).toContain('Watermarks, Headers');
    expect(images[1].source).toMatchObject({ occurrence: 1, occurrenceCount: 2 });
    expect(images[1].source?.decorationInstance).toBeUndefined();
    expect(images[1].unsupportedReason).toBeUndefined();
  });
});
