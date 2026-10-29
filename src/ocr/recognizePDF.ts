import type { Page as RecognizedPage } from 'tesseract.js';
import { loadMuPDF } from '../utils/mupdf';
import { LocalOCRWorker } from './localOCRWorker';
import { appendInvisibleText } from './pdfTextLayer';
import { checkAborted } from './types';
import type { OCROptions, OCRPageResult, OCRProgress, OCRWord } from './types';
export type { OCRLanguage, OCROptions, OCRPageResult, OCRProgress } from './types';

const DPI = 200;
const MAX_SIDE = 4096;
const MAX_PIXELS = 8_000_000;
const normalizedText = (text: string) => text.normalize('NFC').replace(/\s+/gu, '');
const yieldToUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function recognizedWords(result: RecognizedPage, width: number, height: number): OCRWord[] {
  if (!result || typeof result.text !== 'string') throw new Error('OCR returned an invalid recognition result.');
  const words = result.blocks?.flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words))) ?? [];
  const output: OCRWord[] = [];
  for (const word of words) {
    if (typeof word.text !== 'string') throw new Error('OCR returned an invalid word.');
    const text = word.text.trim();
    if (!text) continue;
    const { x0, y0, x1, y1 } = word.bbox ?? {};
    if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > width || y1 > height || x1 <= x0 || y1 <= y0) {
      throw new Error('OCR returned text outside its page image; no PDF was changed.');
    }
    output.push({ text, bbox: { x0, y0, x1, y1 } });
  }
  if (normalizedText(output.map(word => word.text).join('')) !== normalizedText(result.text)) {
    throw new Error('OCR did not return positions for all recognized text; no PDF was changed.');
  }
  return output;
}

/** Recognize locally, preserving original page content and adding invisible text. */
export async function recognizePDF(data: ArrayBuffer, options: OCROptions = {}): Promise<{ data: Uint8Array; pages: OCRPageResult[] }> {
  checkAborted(options.signal);
  const language = options.language ?? 'eng';
  if (language !== 'eng' && language !== 'chi_sim+eng') throw new Error('Unsupported OCR language. Choose English or Chinese + English.');
  const engine = await loadMuPDF();
  checkAborted(options.signal);
  const document = new engine.PDFDocument(data);
  let worker: LocalOCRWorker | undefined;
  try {
    if (document.needsPassword()) throw new Error('Unlock this PDF before running OCR.');
    if (document.wasRepaired()) throw new Error('This PDF is damaged and cannot be safely updated with OCR.');
    const count = document.countPages();
    const pageNumbers = options.pages === undefined ? Array.from({ length: count }, (_, index) => index + 1) : [...new Set(options.pages)].sort((a, b) => a - b);
    if (pageNumbers.length === 0 || pageNumbers.some(page => !Number.isInteger(page) || page < 1 || page > count)) throw new Error('Select at least one valid PDF page for OCR.');
    const pages: OCRPageResult[] = [];
    let phase: OCRProgress['phase'] = 'initializing';
    let currentPage: number | null = null;
    let changed = false;
    let lastProgress = 0;
    const report = (status: string, pageProgress: number) => {
      const progress = Math.max(lastProgress, Math.min(1, (pages.length + pageProgress) / pageNumbers.length));
      lastProgress = progress;
      options.onProgress?.({ phase, pageNumber: currentPage, completedPages: pages.length, totalPages: pageNumbers.length, progress, status });
    };
    for (const pageNumber of pageNumbers) {
      currentPage = pageNumber;
      await yieldToUI();
      checkAborted(options.signal);
      const page = document.loadPage(pageNumber - 1);
      try {
        if (options.skipExistingText !== false) {
          const display = page.toDisplayList(false);
          try {
            const text = display.toStructuredText('');
            try {
              if (text.asText().trim()) {
                pages.push({ pageNumber, status: 'skipped-existing-text', wordCount: 0, text: '', confidence: null });
                phase = 'rendering'; report(`Page ${pageNumber} already contains text`, 0);
                continue;
              }
            } finally { text.destroy(); }
          } finally { display.destroy(); }
        }
        if (!worker) {
          phase = 'initializing'; report('Loading local OCR engine', 0);
          worker = new LocalOCRWorker(options.signal, progress => report(progress.status, phase === 'recognizing' ? 0.15 + progress.progress * 0.75 : progress.progress * 0.05));
          await worker.initialize(language);
          checkAborted(options.signal);
        }
        phase = 'rendering'; report(`Rendering page ${pageNumber}`, 0.1);
        await yieldToUI();
        checkAborted(options.signal);
        const bounds = page.getBounds();
        const width = bounds[2] - bounds[0];
        const height = bounds[3] - bounds[1];
        if (![...bounds, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error(`Page ${pageNumber} has invalid dimensions.`);
        const scale = Math.min(DPI / 72, (MAX_SIDE - 2) / width, (MAX_SIDE - 2) / height, Math.sqrt((MAX_PIXELS - MAX_SIDE * 4) / (width * height)));
        const pixmap = page.toPixmap(engine.Matrix.scale(scale, scale), engine.ColorSpace.DeviceRGB, false, false);
        let raster: { scale: number; x: number; y: number; width: number; height: number };
        let png: Uint8Array;
        try {
          raster = { scale, x: pixmap.getX(), y: pixmap.getY(), width: pixmap.getWidth(), height: pixmap.getHeight() };
          if (raster.width > MAX_SIDE || raster.height > MAX_SIDE || raster.width * raster.height > MAX_PIXELS) throw new Error(`Page ${pageNumber} exceeds the OCR image limit.`);
          png = new Uint8Array(pixmap.asPNG());
        } finally { pixmap.destroy(); }
        checkAborted(options.signal);
        phase = 'recognizing'; report(`Recognizing page ${pageNumber}`, 0.15);
        const result = await worker.recognize(png);
        await yieldToUI();
        checkAborted(options.signal);
        const words = recognizedWords(result, raster.width, raster.height);
        phase = 'writing'; report(`Adding searchable text to page ${pageNumber}`, 0.9);
        if (words.length > 0) {
          appendInvisibleText(engine, document, page, words, raster);
          changed = true;
        }
        pages.push({ pageNumber, status: words.length ? 'recognized' : 'no-text', wordCount: words.length, text: result.text, confidence: Number.isFinite(result.confidence) ? result.confidence : null });
        report(`Finished page ${pageNumber}`, 0);
      } finally { page.destroy(); }
    }
    await yieldToUI();
    checkAborted(options.signal);
    phase = 'writing'; currentPage = null;
    report('Saving searchable PDF', 0);
    let result: Uint8Array;
    if (!changed) result = new Uint8Array(data.slice(0));
    else {
      // Full save preserves the catalog and original object numbers, including
      // widget IDs, while discarding unreachable intermediary resources.
      const saved = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
      try { result = new Uint8Array(saved.asUint8Array()); }
      finally { saved.destroy(); }
    }
    await yieldToUI();
    checkAborted(options.signal);
    return { data: result, pages };
  } finally {
    worker?.terminate();
    document.destroy();
  }
}
