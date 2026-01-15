/**
 * Image Detection
 * Detects and extracts images from PDF pages
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import type { PDFImage } from './types';

/**
 * Detect images on a PDF page
 * This uses the page's operator list to find image drawing operations
 */
export async function detectImages(page: PDFPageProxy): Promise<PDFImage[]> {
  const images: PDFImage[] = [];
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const pageHeight = viewport.height;

  try {
    const operatorList = await page.getOperatorList();
    const { OPS } = await import('pdfjs-dist');

    let imageCounter = 0;
    let currentTransform: number[] = [1, 0, 0, 1, 0, 0];
    const transformStack: number[][] = [];

    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const fn = operatorList.fnArray[i];
      const args = operatorList.argsArray[i];

      // Track transform operations
      if (fn === OPS.save) {
        transformStack.push([...currentTransform]);
      } else if (fn === OPS.restore) {
        const prev = transformStack.pop();
        if (prev) currentTransform = prev;
      } else if (fn === OPS.transform) {
        currentTransform = multiplyTransforms(currentTransform, args as number[]);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        // Found an image
        const imageName = args[0] as string;

        // Calculate image bounds from transform
        // The transform maps a 1x1 unit square to the image position
        const [a, b, c, d, e, f] = currentTransform;

        // Width and height from transform matrix
        const width = Math.sqrt(a * a + b * b);
        const height = Math.sqrt(c * c + d * d);

        // Position (convert from PDF coordinates to top-left origin)
        const x = e;
        const y = pageHeight - f - height;

        images.push({
          id: `img-${page.pageNumber}-${imageCounter++}`,
          pageNumber: page.pageNumber,
          objectName: imageName,
          rect: { x, y, width, height },
          originalRect: { x, y, width, height },
        });
      }
    }
  } catch (err) {
    console.error('Failed to detect images:', err);
  }

  return images;
}

/**
 * Multiply two 2D transform matrices
 * Matrices are in the form [a, b, c, d, e, f]
 */
function multiplyTransforms(t1: number[], t2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = t1;
  const [a2, b2, c2, d2, e2, f2] = t2;

  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * Find image at a given point
 */
export function findImageAtPoint(
  images: PDFImage[],
  x: number,
  y: number
): PDFImage | null {
  // Search in reverse order (top-most image first)
  for (let i = images.length - 1; i >= 0; i--) {
    const img = images[i];
    const { rect } = img;
    if (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    ) {
      return img;
    }
  }
  return null;
}

/**
 * Check if an image overlaps with a rectangle
 */
export function imageOverlapsRect(
  image: PDFImage,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const imgRect = image.rect;
  return !(
    imgRect.x + imgRect.width < rect.x ||
    imgRect.x > rect.x + rect.width ||
    imgRect.y + imgRect.height < rect.y ||
    imgRect.y > rect.y + rect.height
  );
}
