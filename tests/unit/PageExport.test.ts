import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, degrees, rgb } from 'pdf-lib';
import * as mupdf from 'mupdf';
import { unzipSync } from 'fflate';
import { exportPDFPages, parseExportPageRange, PAGE_EXPORT_LIMITS } from '../../src/core/PageExport';
import { updateFormFieldValues } from '../../src/forms/FormFieldExtractor';

const settings = { format: 'png' as const, range: '', dpi: 150 as const, quality: 85, fileName: 'pages.pdf' };
async function fixture() {
  const pdf = await PDFDocument.create(), first = pdf.addPage([72, 144]);
  first.drawRectangle({ x: 0, y: 0, width: 72, height: 144, color: rgb(1, 0, 0) });
  first.drawText('FIRST', { x: 5, y: 80, size: 10 });
  const second = pdf.addPage([100, 200]); second.setCropBox(10, 20, 72, 144); second.setRotation(degrees(90));
  second.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  second.drawRectangle({ x: 10, y: 20, width: 72, height: 144, color: rgb(0, 1, 0) });
  second.drawText('SECOND', { x: 15, y: 100, size: 10 });
  return new Uint8Array(await pdf.save());
}
function inspectImage(bytes: Uint8Array) {
  const image = new mupdf.Image(bytes), pixmap = image.toPixmap();
  try { return { width: pixmap.getWidth(), height: pixmap.getHeight(), pixel: [...pixmap.getPixels().slice(0, 3)] }; }
  finally { pixmap.destroy(); image.destroy(); }
}

describe('page export', () => {
  it('parses ordered page ranges, deduplicates, and rejects malformed or out-of-range pages', () => {
    expect(parseExportPageRange('3, 1-2, 3', 3)).toEqual([3, 1, 2]);
    expect(parseExportPageRange('', 3)).toEqual([1, 2, 3]);
    expect(parseExportPageRange('３，１—２、３；２', 3)).toEqual([3, 1, 2]);
    for (const range of ['0', '4', '3-1', '1,,2', '1.5', '1-', '-2']) expect(() => parseExportPageRange(range, 3)).toThrow();
  });
  it('exports one selected cropped/rotated/UserUnit page as a correctly sized PNG at 300 dpi', async () => {
    const source = await fixture(), before = source.slice();
    const result = await exportPDFPages(source, { ...settings, range: '2', dpi: 300 });
    expect(result).toMatchObject({ fileName: 'pages-page-2.png', mimeType: 'image/png', pages: [2] });
    expect(inspectImage(result.data)).toEqual({ width: 1200, height: 600, pixel: [0, 255, 0] });
    expect(source).toEqual(before);
  });
  it('creates an ordered multi-page JPEG ZIP with only the selected pages and accurate colors', async () => {
    const result = await exportPDFPages(await fixture(), { ...settings, format: 'jpeg', range: '2,1,2', fileName: '../合同.pdf' });
    expect(result.fileName).not.toContain('/');
    expect(result.mimeType).toBe('application/zip');
    const files = Object.entries(unzipSync(result.data));
    expect(files.map(([name]) => name)).toEqual(['..-合同-page-2.jpg', '..-合同-page-1.jpg']);
    expect(inspectImage(files[0][1])).toMatchObject({ width: 600, height: 300 });
    expect(inspectImage(files[0][1]).pixel[1]).toBeGreaterThan(240);
    expect(inspectImage(files[1][1])).toMatchObject({ width: 150, height: 300 });
    expect(inspectImage(files[1][1]).pixel[0]).toBeGreaterThan(240);
  });
  it('extracts UTF-8 page text and visible Unicode form values without exporting unselected pages', async () => {
    const pdf = await PDFDocument.create(), first = pdf.addPage([400, 400]);
    first.drawText('PUBLIC PAGE', { x: 30, y: 300, size: 12 });
    pdf.addPage().drawText('NOT SELECTED');
    const field = pdf.getForm().createTextField('Name'); field.addToPage(first, { x: 30, y: 200, width: 300, height: 30 });
    const data = await updateFormFieldValues(new Uint8Array(await pdf.save()).buffer, new Map([['Name', '客户 中文 café']]));
    const output = await exportPDFPages(data, { ...settings, format: 'text', range: '1' });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(output.data);
    expect(text).toContain('PUBLIC PAGE'); expect(text).toContain('客户 中文 café'); expect(text).not.toContain('NOT SELECTED');
    expect(output).toMatchObject({ fileName: 'pages-pages.txt', pages: [1] });
  });
  it('rejects oversized raster pages before pixel allocation and enforces the total archive budget', async () => {
    const huge = await PDFDocument.create(); huge.addPage([14_400, 14_400]);
    await expect(exportPDFPages(await huge.save(), settings)).rejects.toThrow('40 megapixel');
    const previous = PAGE_EXPORT_LIMITS.outputBytes;
    PAGE_EXPORT_LIMITS.outputBytes = 100;
    try { await expect(exportPDFPages(await fixture(), settings)).rejects.toThrow('128 MB'); }
    finally { PAGE_EXPORT_LIMITS.outputBytes = previous; }
  });
  it('cancels before another page is rendered and destroys the document', async () => {
    const controller = new AbortController(), progress: number[] = [];
    const destroy = vi.spyOn(mupdf.PDFDocument.prototype, 'destroy');
    try {
      await expect(exportPDFPages(await fixture(), settings, { signal: controller.signal, onProgress: value => {
        progress.push(value.completed); if (value.completed === 1) controller.abort();
      } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(progress).toEqual([0, 1]); expect(destroy).toHaveBeenCalled();
    } finally { destroy.mockRestore(); }
  });
});
