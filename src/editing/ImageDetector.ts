import type { PDFPageProxy } from 'pdfjs-dist';
import type { PDFImage } from './types';
import { identityMatrix, matrixBounds, multiplyMatrix, type ImageMatrix } from './imageMatrix';
import { decorationInstanceFromTag } from '../core/PageDecorationMarkers';
import { imageCropFromTag } from './ImageCropMarker';
import { imageCropUV } from './imageAppearance';
import type { TextRect } from './types';

/** Detect individual XObject draws, retaining a source-space transform for export. */
export async function detectImages(page: PDFPageProxy): Promise<PDFImage[]> {
  const images: PDFImage[] = [];
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const { OPS, AnnotationMode } = await import('pdfjs-dist');
  const operatorList = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  let transform = identityMatrix();
  const stack: ImageMatrix[] = [];
  let formDepth = 0;
  let unsupported = '';
  const markedContent: Array<string | undefined> = [];
  const crops: Array<TextRect | undefined> = [];
  const decoration = () => {
    for (let index = markedContent.length - 1; index >= 0; index--) if (markedContent[index]) return markedContent[index];
    return undefined;
  };
  const add = (name: string, matrix: ImageMatrix, width?: number, height?: number) => {
    const rawRect = matrixBounds(multiplyMatrix(viewport.transform, matrix)), crop = [...crops].reverse().find(Boolean);
    const uv = crop ? imageCropUV(crop) : undefined;
    const rect = uv ? matrixBounds(multiplyMatrix(multiplyMatrix(viewport.transform, matrix), [uv.width, 0, 0, uv.height, uv.x, uv.y])) : rawRect;
    images.push({
      id: `img-${crypto.randomUUID()}`, pageNumber: page.pageNumber, objectName: name,
      rect, originalRect: { ...rect },
      source: { occurrence: images.length, occurrenceCount: 0, transform: matrix, pixelWidth: width, pixelHeight: height, insideForm: formDepth > 0,
        ...(crop ? { cropRect: crop, rawRect } : {}),
        ...(decoration() ? { decorationInstance: decoration() } : {}) },
      ...(decoration() ? { unsupportedReason: 'Edit this image in Document → Watermarks, Headers & Backgrounds…' } : {}),
    });
  };
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];
    if (fn === OPS.beginMarkedContent || fn === OPS.beginMarkedContentProps) { markedContent.push(decorationInstanceFromTag(args[0])); crops.push(imageCropFromTag(args[0])); }
    else if (fn === OPS.endMarkedContent) { markedContent.pop(); crops.pop(); }
    else if (fn === OPS.save) stack.push([...transform]);
    else if (fn === OPS.restore) transform = stack.pop() ?? identityMatrix();
    else if (fn === OPS.transform) transform = multiplyMatrix(transform, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push([...transform]);
      if (args[0]) transform = multiplyMatrix(transform, args[0]);
      formDepth++;
    } else if (fn === OPS.paintFormXObjectEnd) {
      transform = stack.pop() ?? identityMatrix();
      formDepth--;
    } else if (fn === OPS.paintImageXObject) add(args[0], [...transform], args[1], args[2]);
    else if (fn === OPS.paintImageXObjectRepeat) {
      const [name, scaleX, scaleY, positions] = args;
      for (let p = 0; p < positions.length; p += 2) {
        add(name, multiplyMatrix(transform, [scaleX, 0, 0, scaleY, positions[p], positions[p + 1]]));
      }
    } else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintInlineImageXObjectGroup) {
      unsupported = 'Pages containing inline images cannot be edited yet.';
    } else if (fn === OPS.beginGroup) {
      // Group matrices and soft-mask images are not reliably addressable by the
      // public PDF.js operator list. Never guess which source draw was selected.
      unsupported = 'Images in transparency groups cannot be edited yet.';
    }
  }
  for (const image of images) {
    image.source!.occurrenceCount = images.length;
    if (unsupported) image.unsupportedReason = unsupported;
  }
  return images;
}

export function findImageAtPoint(images: PDFImage[], x: number, y: number): PDFImage | null {
  for (let index = images.length - 1; index >= 0; index--) {
    const { rect } = images[index];
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return images[index];
  }
  return null;
}

export function imageOverlapsRect(image: PDFImage, rect: PDFImage['rect']): boolean {
  const a = image.rect;
  return !(a.x + a.width < rect.x || a.x > rect.x + rect.width || a.y + a.height < rect.y || a.y > rect.y + rect.height);
}
