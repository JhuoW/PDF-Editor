import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';

export const IMAGE_LIMITS = { files: 100, bytesPerFile: 40 * 1024 * 1024, totalBytes: 150 * 1024 * 1024, pixelsPerFile: 40_000_000, totalPixels: 80_000_000, dimension: 16_384 };
export interface PDFImageInput { name: string; data: Uint8Array | ArrayBuffer }
export interface ImageInfo { format: 'png' | 'jpeg'; width: number; height: number; orientation: number }
export interface ImagePDFOptions {
  pageSize: 'image' | 'a4' | 'letter'; orientation: 'portrait' | 'landscape'; margin: number;
  signal?: AbortSignal; onProgress?: (completed: number, total: number) => void;
}
export function checkConversionCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Conversion cancelled', 'AbortError');
}
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const bytesOf = (data: Uint8Array | ArrayBuffer) => data instanceof Uint8Array ? data : new Uint8Array(data);
function dimensions(info: ImageInfo): ImageInfo {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1
    || info.width > IMAGE_LIMITS.dimension || info.height > IMAGE_LIMITS.dimension || info.width * info.height > IMAGE_LIMITS.pixelsPerFile) {
    throw new Error('Each image must be at most 40 megapixels and 16,384 pixels on either side.');
  }
  return info;
}
function exifOrientation(data: Uint8Array): number | undefined {
  if (data.length < 14 || String.fromCharCode(...data.subarray(0, 6)) !== 'Exif\0\0') return undefined;
  const view = new DataView(data.buffer, data.byteOffset + 6, data.byteLength - 6);
  const little = view.getUint16(0) === 0x4949;
  if ((!little && view.getUint16(0) !== 0x4d4d) || view.getUint16(2, little) !== 42) return undefined;
  const start = view.getUint32(4, little);
  if (start + 2 > view.byteLength) return undefined;
  const count = view.getUint16(start, little);
  for (let index = 0; index < count; index++) {
    const offset = start + 2 + index * 12;
    if (offset + 12 > view.byteLength) return undefined;
    if (view.getUint16(offset, little) === 0x112 && view.getUint16(offset + 2, little) === 3 && view.getUint32(offset + 4, little) === 1) {
      const orientation = view.getUint16(offset + 8, little);
      return orientation >= 1 && orientation <= 8 ? orientation : undefined;
    }
  }
  return undefined;
}

/** Inspect dimensions before a decoder can allocate pixels for an oversized image. */
export function inspectPDFImage(input: PDFImageInput): ImageInfo {
  const data = bytesOf(input.data);
  if (!data.length || data.length > IMAGE_LIMITS.bytesPerFile) throw new Error(`"${input.name}": images must be between 1 byte and 40 MB.`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error(`"${input.name}": invalid PNG header.`);
    const info = dimensions({ format: 'png', width: view.getUint32(16), height: view.getUint32(20), orientation: 1 });
    let imageData = false, ended = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = view.getUint32(offset), type = view.getUint32(offset + 4);
      if (length > data.length - offset - 12) throw new Error(`"${input.name}": truncated PNG.`);
      if (type === 0x6163544c) throw new Error('Animated PNG is not supported. Choose a still PNG or JPEG.');
      if (type === 0x49444154) imageData = true;
      if (type === 0x49454e44) { ended = length === 0; break; }
      offset += length + 12;
    }
    if (!ended || !imageData) throw new Error(`"${input.name}": incomplete PNG.`);
    return info;
  }
  if (data.length >= 4 && view.getUint16(0) === 0xffd8) {
    let orientation = 1, info: ImageInfo | undefined, scan = false, ended = false;
    for (let offset = 2; offset + 1 < data.length;) {
      if (data[offset++] !== 0xff) throw new Error(`"${input.name}": invalid JPEG marker.`);
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9) { ended = true; break; }
      if (marker === 0xd8) throw new Error(`"${input.name}": unexpected JPEG start marker.`);
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || length > data.length - offset) throw new Error(`"${input.name}": truncated JPEG.`);
      if (marker === 0xe1) orientation = exifOrientation(data.subarray(offset + 2, offset + length)) ?? orientation;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || data[offset + 2] !== 8 || ![1, 3, 4].includes(data[offset + 7]) || length !== 8 + 3 * data[offset + 7]) throw new Error('This JPEG encoding is not supported. Use an 8-bit PNG or JPEG.');
        info = dimensions({ format: 'jpeg', height: view.getUint16(offset + 3), width: view.getUint16(offset + 5), orientation });
      }
      offset += length;
      if (marker === 0xda) {
        const componentCount = data[offset - length + 2];
        if (!info || componentCount < 1 || componentCount > 4 || length !== 6 + 2 * componentCount) throw new Error(`"${input.name}": invalid JPEG scan header.`);
        let payload = 0;
        while (offset < data.length) {
          if (data[offset] !== 0xff) { offset++; payload++; continue; }
          const boundary = offset++;
          while (data[offset] === 0xff) offset++;
          const code = data[offset];
          if (code === 0x00) { payload++; offset++; continue; }
          if (code >= 0xd0 && code <= 0xd7) { offset++; continue; }
          // The next marker terminates this scan. Parse it normally so an EOI
          // byte sequence inside metadata can never masquerade as the file end.
          offset = boundary; break;
        }
        if (!payload) throw new Error(`"${input.name}": JPEG scan has no encoded image data.`);
        scan = true;
      }
    }
    if (!info || !scan || !ended) throw new Error(`"${input.name}": incomplete or unsupported JPEG.`);
    return { ...info, orientation };
  }
  throw new Error(`"${input.name}": only still PNG and JPEG images are supported.`);
}

export function validateImageCollection(images: PDFImageInput[]): ImageInfo[] {
  if (!images.length || images.length > IMAGE_LIMITS.files) throw new Error('Choose between 1 and 100 PNG or JPEG images.');
  const information = images.map(inspectPDFImage);
  if (images.reduce((sum, image) => sum + bytesOf(image.data).byteLength, 0) > IMAGE_LIMITS.totalBytes
    || information.reduce((sum, image) => sum + image.width * image.height, 0) > IMAGE_LIMITS.totalPixels) {
    throw new Error('This selection exceeds the 150 MB or 80 megapixel total limit. Create smaller PDFs.');
  }
  return information;
}

export async function createPDFFromImages(images: PDFImageInput[], options: ImagePDFOptions): Promise<Uint8Array> {
  checkConversionCancelled(options.signal);
  const information = validateImageCollection(images);
  if (!['image', 'a4', 'letter'].includes(options.pageSize) || !['portrait', 'landscape'].includes(options.orientation)
    || !Number.isFinite(options.margin) || options.margin < 0 || options.margin > 144) throw new Error('Choose a valid paper size, orientation, and margin between 0 and 50.8 mm.');
  const document = await PDFDocument.create();
  const transforms = [[1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
    [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0]];
  options.onProgress?.(0, images.length);
  for (const [index, source] of images.entries()) {
    await yieldTask(); checkConversionCancelled(options.signal);
    const info = information[index], swapped = info.orientation >= 5;
    const imageWidth = swapped ? info.height : info.width, imageHeight = swapped ? info.width : info.height;
    const bytes = new Uint8Array(bytesOf(source.data));
    // The browser decoder validates compressed JPEG payloads before embedding.
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: info.format === 'png' ? 'image/png' : 'image/jpeg' }));
      bitmap.close(); checkConversionCancelled(options.signal);
    } else if (info.format === 'jpeg') {
      // pdf-lib embeds JPEG bytes without decoding. Validate pixels even when
      // the host has no native bitmap decoder; the engine remains lazy-loaded.
      const engine = await loadMuPDF(); checkConversionCancelled(options.signal);
      const image = new engine.Image(bytes);
      try { const pixmap = image.toPixmap(); pixmap.destroy(); }
      finally { image.destroy(); }
      checkConversionCancelled(options.signal);
    }
    let width: number, height: number;
    if (options.pageSize === 'image') { width = imageWidth + 2 * options.margin; height = imageHeight + 2 * options.margin; }
    else {
      [width, height] = options.pageSize === 'a4' ? [595.2756, 841.8898] : [612, 792];
      if (options.orientation === 'landscape') [width, height] = [height, width];
    }
    if (width > 14400 || height > 14400 || width <= 2 * options.margin || height <= 2 * options.margin) throw new Error('The page dimensions or margins leave no usable image area. Choose A4 or Letter, or smaller margins.');
    const factor = Math.min((width - 2 * options.margin) / imageWidth, (height - 2 * options.margin) / imageHeight);
    const drawWidth = imageWidth * factor, drawHeight = imageHeight * factor;
    const x = (width - drawWidth) / 2, y = (height - drawHeight) / 2;
    const embedded = info.format === 'png' ? await document.embedPng(bytes) : await document.embedJpg(bytes);
    const page = document.addPage([width, height]);
    const name = page.node.newXObject('Image', embedded.ref);
    const [a, b, c, d, e, f] = transforms[info.orientation - 1];
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a * drawWidth, b * drawHeight, c * drawWidth, d * drawHeight, x + e * drawWidth, y + f * drawHeight), drawObject(name), popGraphicsState());
    options.onProgress?.(index + 1, images.length);
  }
  checkConversionCancelled(options.signal);
  const result = await document.save();
  checkConversionCancelled(options.signal);
  return result;
}
