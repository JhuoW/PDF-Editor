// Image data passed when inserting an image
export interface PendingImageData {
  imageData: string; // Base64 data URL
  originalWidth: number;
  originalHeight: number;
  filename: string;
  fileSize: number;
  mimeType: string;
}

export function readInsertImage(file: File, signal: AbortSignal): Promise<PendingImageData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let image: HTMLImageElement | null = null, settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = null; reader.onerror = null; reader.onabort = null;
      if (image) { image.onload = null; image.onerror = null; }
    };
    const fail = (cause: Error) => { if (settled) return; settled = true; cleanup(); reject(cause); };
    const abort = () => {
      fail(new DOMException('Image loading cancelled.', 'AbortError'));
      if (reader.readyState === 1) reader.abort();
      if (image) image.src = '';
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    reader.onload = () => {
      if (settled || signal.aborted) return;
      const data = reader.result;
      if (typeof data !== 'string') { fail(new Error(`Could not read image: ${file.name}`)); return; }
      image = new Image();
      image.onload = async () => {
        if (settled || signal.aborted || !image) return;
        const width = image.naturalWidth, height = image.naturalHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 40_000_000) { fail(new Error(`Image ${file.name} must have valid dimensions within 40 million pixels.`)); return; }
        try {
          let imageData = data, fileSize = file.size;
          let mimeType = /^data:([^;,]+)/i.exec(data)?.[1].toLowerCase() ?? file.type;
          let convert = !['image/png', 'image/jpeg', 'image/jpg'].includes(mimeType);
          if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
            const { inspectPDFImage } = await import('../core/ImagePDF');
            if (settled || signal.aborted) return;
            const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), char => char.charCodeAt(0));
            convert = inspectPDFImage({ name: file.name, data: bytes }).orientation !== 1;
          }
          if (convert) {
            // Browsers apply EXIF while drawing an image; raw PDF JPEG embedding
            // does not. Canonical PNG pixels also make WebP/GIF/BMP/SVG exportable.
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            try {
              const context = canvas.getContext('2d'); if (!context) throw new Error('Could not prepare the image for PDF export.');
              context.drawImage(image, 0, 0, width, height);
              imageData = canvas.toDataURL('image/png');
              if (!imageData.startsWith('data:image/png;base64,')) throw new Error('Could not encode the image for PDF export.');
              const encoded = imageData.slice(imageData.indexOf(',') + 1);
              fileSize = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
              if (fileSize > 20 * 1024 * 1024) throw new Error(`Prepared image ${file.name} exceeds 20 MB. Choose a smaller image.`);
              mimeType = 'image/png';
            } finally { canvas.width = 0; canvas.height = 0; }
          }
          if (settled || signal.aborted) return;
          settled = true; cleanup(); resolve({ imageData, originalWidth: width, originalHeight: height, filename: file.name, fileSize, mimeType });
        } catch (cause) { fail(cause instanceof Error ? cause : new Error(`Could not prepare image: ${file.name}`)); }
      };
      image.onerror = () => fail(new Error(`Could not decode image: ${file.name}`));
      image.src = data;
    };
    reader.onerror = () => fail(new Error(`Could not read image: ${file.name}`));
    reader.onabort = () => fail(new DOMException('Image loading cancelled.', 'AbortError'));
    try { reader.readAsDataURL(file); } catch (cause) { fail(cause instanceof Error ? cause : new Error(`Could not read image: ${file.name}`)); }
  });
}
