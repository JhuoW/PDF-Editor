import { loadMuPDF } from '../utils/mupdf';

function checkConversionCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

export const PAGE_EXPORT_LIMITS = { inputBytes: 256 * 1024 * 1024, pagePixels: 40_000_000, dimension: 16_384, outputBytes: 128 * 1024 * 1024 };
export interface PageExportSettings { format: 'png' | 'jpeg' | 'text'; range: string; dpi: 150 | 300; quality: number; fileName: string }
export interface PageExportProgress { completed: number; total: number; phase: 'pages' | 'archive' }
export interface PageExportResult { data: Uint8Array; fileName: string; mimeType: string; pages: number[] }
export interface PageExportControl { signal?: AbortSignal; onProgress?: (progress: PageExportProgress) => void }

export function parseExportPageRange(range: string, totalPages: number): number[] {
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new Error('The PDF has no readable pages.');
  if (!range.trim() || range.trim().toLowerCase() === 'all') return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const part of range.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('Use page numbers and ranges such as 1-3, 5.');
    const start = Number(match[1]), end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start || end > totalPages || !Number.isSafeInteger(end)) throw new Error(`Page ranges must be between 1 and ${totalPages}, with the smaller page first.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages];
}

export async function exportPDFPages(data: Uint8Array | ArrayBuffer, settings: PageExportSettings, control: PageExportControl = {}): Promise<PageExportResult> {
  checkConversionCancelled(control.signal);
  if (data.byteLength === 0 || data.byteLength > PAGE_EXPORT_LIMITS.inputBytes) throw new Error('Page export accepts PDFs up to 256 MB.');
  if (!['png', 'jpeg', 'text'].includes(settings.format) || ![150, 300].includes(settings.dpi)
    || !Number.isInteger(settings.quality) || settings.quality < 1 || settings.quality > 100) throw new Error('Choose PNG, JPEG, or text, 150 or 300 dpi, and a JPEG quality from 1 to 100.');
  const engine = await loadMuPDF(); checkConversionCancelled(control.signal);
  const document = new engine.PDFDocument(data);
  try {
    if (document.needsPassword()) throw new Error('Unlock the PDF before exporting pages.');
    const pages = parseExportPageRange(settings.range, document.countPages());
    const stem = Array.from(settings.fileName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-'),
      character => character.charCodeAt(0) < 32 ? '-' : character).join('').trim() || 'document';
    const files: Record<string, Uint8Array> = {};
    const textParts: string[] = [];
    let totalBytes = 0, hasText = false;
    control.onProgress?.({ completed: 0, total: pages.length, phase: 'pages' });
    for (const [index, number] of pages.entries()) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); checkConversionCancelled(control.signal);
      const page = document.loadPage(number - 1);
      try {
        if (settings.format === 'text') {
          const display = page.toDisplayList(true);
          try {
            const text = display.toStructuredText('');
            try {
              const value = text.asText(); hasText ||= value.trim().length > 0;
              textParts.push(`--- Page ${number} ---\n${value}`);
              totalBytes += new TextEncoder().encode(textParts.at(-1)!).length + 2;
            } finally { text.destroy(); }
          } finally { display.destroy(); }
        } else {
          const bounds = page.getBounds(), scale = settings.dpi / 72;
          const width = Math.ceil((bounds[2] - bounds[0]) * scale), height = Math.ceil((bounds[3] - bounds[1]) * scale);
          if (!Number.isFinite(width * height) || width < 1 || height < 1 || width > PAGE_EXPORT_LIMITS.dimension || height > PAGE_EXPORT_LIMITS.dimension || width * height > PAGE_EXPORT_LIMITS.pagePixels) {
            throw new Error(`Page ${number} exceeds the 40 megapixel export limit at ${settings.dpi} dpi. Choose 150 dpi or a smaller page.`);
          }
          const pixmap = page.toPixmap(engine.Matrix.scale(scale, scale), engine.ColorSpace.DeviceRGB, false, true);
          try {
            pixmap.setResolution(settings.dpi, settings.dpi);
            const bytes = new Uint8Array(settings.format === 'png' ? pixmap.asPNG() : pixmap.asJPEG(settings.quality));
            files[`${stem}-page-${String(number).padStart(String(document.countPages()).length, '0')}.${settings.format === 'jpeg' ? 'jpg' : 'png'}`] = bytes;
            totalBytes += bytes.byteLength;
          } finally { pixmap.destroy(); }
        }
        if (totalBytes > PAGE_EXPORT_LIMITS.outputBytes) throw new Error('The selected pages exceed the 128 MB download limit. Export fewer pages or reduce image quality.');
      } finally { page.destroy(); }
      control.onProgress?.({ completed: index + 1, total: pages.length, phase: 'pages' });
    }
    checkConversionCancelled(control.signal);
    if (settings.format === 'text') {
      if (!hasText) throw new Error('No extractable text was found. Run OCR first, then export text.');
      return { data: new TextEncoder().encode(textParts.join('\n\n')), mimeType: 'text/plain;charset=utf-8', fileName: `${stem}-pages.txt`, pages };
    }
    const entries = Object.entries(files);
    if (entries.length === 1) return { data: entries[0][1], mimeType: settings.format === 'png' ? 'image/png' : 'image/jpeg', fileName: entries[0][0], pages };
    control.onProgress?.({ completed: pages.length, total: pages.length, phase: 'archive' });
    const { zipSync } = await import('fflate'); checkConversionCancelled(control.signal);
    // PNG/JPEG are already compressed; storing avoids unnecessary CPU/memory.
    const archive = zipSync(files, { level: 0 });
    if (archive.byteLength > PAGE_EXPORT_LIMITS.outputBytes) throw new Error('The ZIP exceeds 128 MB. Export fewer pages.');
    checkConversionCancelled(control.signal);
    return { data: archive, mimeType: 'application/zip', fileName: `${stem}-pages.zip`, pages };
  } finally { document.destroy(); }
}
