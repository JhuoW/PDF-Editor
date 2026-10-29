import { PDFDocument } from 'pdf-lib';
import * as mupdf from 'mupdf';

/** A genuine scanned page: no fonts or text content remain in the returned PDF. */
export async function createScannedPDF(chinese = false): Promise<Uint8Array> {
  const output = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(output, 'pdf', '');
  const latin = new mupdf.Font('Helvetica');
  const cjk = new mupdf.Font('zh-Hans');
  let rendered: mupdf.PDFDocument | undefined;
  try {
    const device = writer.beginPage([0, 0, 520, 260]);
    const text = new mupdf.Text();
    try {
      text.showString(latin, [24, 0, 0, -24, 30, 70], 'SEARCHABLE SCANNED DOCUMENT');
      text.showString(latin, [24, 0, 0, -24, 30, 120], 'Invoice number 739251');
      if (chinese) text.showString(cjk, [28, 0, 0, -28, 30, 175], '中文识别测试');
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
      device.close();
    } finally { text.destroy(); device.destroy(); }
    writer.endPage();
    writer.close();
    rendered = new mupdf.PDFDocument(output);
    const page = rendered.loadPage(0);
    const pixels = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, false);
    try {
      const document = await PDFDocument.create();
      const image = await document.embedPng(new Uint8Array(pixels.asPNG()));
      document.addPage([520, 260]).drawImage(image, { x: 0, y: 0, width: 520, height: 260 });
      return document.save();
    } finally { pixels.destroy(); page.destroy(); }
  } finally { rendered?.destroy(); latin.destroy(); cjk.destroy(); writer.destroy(); output.destroy(); }
}
