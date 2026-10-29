import type { PendingImageData } from '../Toolbar/CombinedToolbar';
import { inspectPDFImage } from '../../core/ImagePDF';

export interface SignaturePoint { x: number; y: number }
export interface SignatureStroke { points: SignaturePoint[]; color: string; width: number }
export const SIGNATURE_PAD = { width: 800, height: 260 };
export const SIGNATURE_LIMITS = { bytes: 5 * 1024 * 1024, pixels: 12_000_000, dimension: 8192, outputDimension: 1600, points: 20_000, strokes: 200 };

export function paintSignature(context: CanvasRenderingContext2D, strokes: SignatureStroke[]) {
  context.lineJoin = 'round'; context.lineCap = 'round';
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.width;
    context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y);
    if (stroke.points.length === 1) { context.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, 2 * Math.PI); context.fill(); }
    else { for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y); context.stroke(); }
  }
}

function canvas(width: number, height: number) {
  const element = document.createElement('canvas'); element.width = width; element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error('Your browser could not create the signature image.');
  return { element, context };
}
function result(element: HTMLCanvasElement, filename: string): PendingImageData {
  const imageData = element.toDataURL('image/png');
  if (!imageData.startsWith('data:image/png;base64,')) throw new Error('Could not encode the signature image.');
  const encoded = imageData.slice(imageData.indexOf(',') + 1);
  const fileSize = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (fileSize > SIGNATURE_LIMITS.bytes) throw new Error('The signature image is too large. Choose a smaller image.');
  return { imageData, filename, originalWidth: element.width, originalHeight: element.height, mimeType: 'image/png', fileSize };
}

/** Crop only unused drawing space; the PNG keeps transparent pixels around the ink. */
export function createDrawnSignature(strokes: SignatureStroke[]): PendingImageData {
  if (!strokes.length || strokes.length > SIGNATURE_LIMITS.strokes) throw new Error('Draw your signature before placing it.');
  const points = strokes.flatMap(stroke => stroke.points);
  if (!points.length || points.length > SIGNATURE_LIMITS.points || strokes.some(stroke => !/^#[0-9a-f]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 10)
    || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > SIGNATURE_PAD.width || point.y > SIGNATURE_PAD.height)) {
    throw new Error('The signature drawing is invalid or too detailed. Clear it and draw again.');
  }
  const padding = 8, left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) - padding));
  const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) - padding));
  const right = Math.min(SIGNATURE_PAD.width, Math.ceil(Math.max(...points.map(point => point.x)) + padding));
  const bottom = Math.min(SIGNATURE_PAD.height, Math.ceil(Math.max(...points.map(point => point.y)) + padding));
  const { element, context } = canvas(Math.max(1, right - left) * 2, Math.max(1, bottom - top) * 2);
  context.scale(2, 2); context.translate(-left, -top); paintSignature(context, strokes);
  return result(element, 'handwritten-signature.png');
}

/** Validate encoded dimensions before decoding; normalize EXIF orientation and keep alpha. */
export async function readSignatureImage(file: File, removeWhite: boolean, signal: AbortSignal): Promise<PendingImageData> {
  signal.throwIfAborted();
  if (!file.size || file.size > SIGNATURE_LIMITS.bytes) throw new Error('Choose a PNG or JPEG signature between 1 byte and 5 MB.');
  const data = new Uint8Array(await file.arrayBuffer()); signal.throwIfAborted();
  const info = inspectPDFImage({ name: file.name, data });
  if (info.width > SIGNATURE_LIMITS.dimension || info.height > SIGNATURE_LIMITS.dimension || info.width * info.height > SIGNATURE_LIMITS.pixels) {
    throw new Error('Signature images must be at most 12 megapixels and 8,192 pixels on either side.');
  }
  const bitmap = await createImageBitmap(new Blob([data], { type: info.format === 'png' ? 'image/png' : 'image/jpeg' }), { imageOrientation: 'from-image' });
  try {
    signal.throwIfAborted();
    const ratio = Math.min(1, SIGNATURE_LIMITS.outputDimension / Math.max(bitmap.width, bitmap.height));
    const { element, context } = canvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
    context.drawImage(bitmap, 0, 0, element.width, element.height);
    const pixels = context.getImageData(0, 0, element.width, element.height);
    let visible = false;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      if (removeWhite) pixels.data[offset + 3] *= Math.min(1, (255 - Math.min(pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2])) / 20);
      if (pixels.data[offset + 3]) visible = true;
    }
    if (!visible) throw new Error('The image has no visible signature. Choose another image or keep its background.');
    if (removeWhite) context.putImageData(pixels, 0, 0);
    signal.throwIfAborted();
    return result(element, `${file.name.replace(/\.[^.]+$/, '') || 'uploaded'}-signature.png`);
  } finally { bitmap.close(); }
}
