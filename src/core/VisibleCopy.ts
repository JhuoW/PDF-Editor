import type { PDFDocument, PDFObject } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';
import { DEFAULT_VISIBLE_COPY_SETTINGS, VISIBLE_COPY_LIMITS, type VisibleCopyControl, type VisibleCopyInspection, type VisibleCopyPageInfo, type VisibleCopyResult, type VisibleCopySettings, type VisibleCopyWarning } from './VisibleCopyTypes';
export * from './VisibleCopyTypes';

type Engine = typeof import('mupdf');
const cancel = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Visible copy cancelled', 'AbortError'); };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const pdfNumber = (value: number) => value.toFixed(8).replace(/\.?0+$/, '');
const standardFonts = new Set(['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats']);

function validateInput(data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings) {
  if (!data.byteLength || data.byteLength > VISIBLE_COPY_LIMITS.inputBytes) throw new Error('Visible copies accept PDFs between 1 byte and 256 MB.');
  if (![150, 300].includes(settings.dpi) || !['lossless', 'jpeg'].includes(settings.compression)
    || (settings.quality !== undefined && (!Number.isInteger(settings.quality) || settings.quality < 1 || settings.quality > 100))) {
    throw new Error('Choose 150 or 300 dpi, lossless or JPEG, and a JPEG quality between 1 and 100.');
  }
}

/** The engine log is global. Capture only one synchronous operation, never an await. */
function strict<T>(engine: Engine, operation: () => T, dispose?: (value: T) => void): T {
  const diagnostics: string[] = [];
  engine.setLog(message => { if (diagnostics.length < 3) diagnostics.push(message); });
  let value: T;
  try { value = operation(); }
  finally { engine.setLog(null); }
  if (diagnostics.length) {
    dispose?.(value);
    throw new Error(`The PDF renderer reported a problem. No visible copy was created: ${diagnostics.join('; ').slice(0, 600)}`);
  }
  return value;
}
function open(engine: Engine, data: Uint8Array | ArrayBuffer) {
  const document = strict(engine, () => new engine.PDFDocument(data), value => value.destroy());
  try {
    return strict(engine, () => {
      if (document.needsPassword()) throw new Error('Unlock this PDF before creating a visible copy.');
      if (document.wasRepaired()) throw new Error('This PDF required repair. Its complete visible appearance cannot be verified.');
      const trailer = document.getTrailer(), xfa = trailer.get('Root', 'AcroForm', 'XFA');
      try { if (!xfa.isNull()) throw new Error('Dynamic XFA form appearance cannot be rendered reliably for a visible copy.'); }
      finally { xfa.destroy(); trailer.destroy(); }
      if (document.countPages() < 1 || document.countPages() > VISIBLE_COPY_LIMITS.pages) throw new Error('Visible copies support between 1 and 2,000 pages.');
      return document;
    });
  } catch (cause) { document.destroy(); throw cause; }
}

function fontWarnings(pageObject: PDFObject, pageNumber: number, warnings: VisibleCopyWarning[], seenWarnings: Set<string>) {
  const visited = new Set<number>();
  const walk = (object: PDFObject, depth = 0) => {
    if (depth > 40) throw new Error('The page resource graph is too deeply nested to inspect safely.');
    if (object.isIndirect()) { const ref = object.asIndirect(); if (visited.has(ref)) return; visited.add(ref); }
    if (object.isArray()) { object.forEach(child => { try { walk(child, depth + 1); } finally { child.destroy(); } }); return; }
    if (!object.isDictionary()) return;
    const type = object.get('Type'), subtype = object.get('Subtype');
    try {
      if (type.asName() === 'Font' && !['Type0', 'Type3'].includes(subtype.asName())) {
        const base = object.get('BaseFont'), descriptor = object.get('FontDescriptor');
        try {
          const name = base.asName().replace(/^[A-Z]{6}\+/, '') || 'Unnamed font';
          let embedded = false;
          if (descriptor.isDictionary()) for (const key of ['FontFile', 'FontFile2', 'FontFile3']) { const stream = descriptor.get(key); try { embedded ||= stream.isStream(); } finally { stream.destroy(); } }
          const id = `${pageNumber}:${name}`;
          if (!embedded && !standardFonts.has(name) && !seenWarnings.has(id)) {
            seenWarnings.add(id);
            if (warnings.length < 100) warnings.push({ pageNumber, fontName: name.slice(0, 160), message: `Page ${pageNumber}: ${name.slice(0, 160)} is not embedded. The preview and copy use the renderer's substitute font.` });
          }
        } finally { descriptor.destroy(); base.destroy(); }
      }
      object.forEach((child, key) => {
        // Resource/AP graphs are sufficient; following Parent/P would enter the
        // entire page tree and attribute other pages' fonts to this page.
        try { if (!['Parent', 'P'].includes(String(key))) walk(child, depth + 1); }
        finally { child.destroy(); }
      });
    } finally { subtype.destroy(); type.destroy(); }
  };
  const resources = pageObject.getInheritable('Resources'), annotations = pageObject.get('Annots');
  try { walk(resources); if (annotations.isArray()) annotations.forEach(annotation => { const appearance = annotation.get('AP'); try { walk(appearance); } finally { appearance.destroy(); annotation.destroy(); } }); }
  finally { annotations.destroy(); resources.destroy(); }
}

function containsSignature(document: PDFDocument): boolean {
  const trailer = document.getTrailer(), certification = trailer.get('Root', 'Perms', 'DocMDP'), fields = trailer.get('Root', 'AcroForm', 'Fields');
  const visited = new Set<number>();
  const walk = (object: PDFObject, depth = 0): boolean => {
    if (depth > 40) throw new Error('The form field hierarchy is too deeply nested to inspect safely.');
    if (object.isIndirect()) { const ref = object.asIndirect(); if (visited.has(ref)) return false; visited.add(ref); }
    if (object.isArray()) {
      let signed = false;
      object.forEach(child => { try { signed = walk(child, depth + 1) || signed; } finally { child.destroy(); } });
      return signed;
    }
    if (!object.isDictionary()) return false;
    const type = object.getInheritable('FT'), value = object.getInheritable('V'), kids = object.get('Kids');
    try { return (type.asName() === 'Sig' && !value.isNull()) || walk(kids, depth + 1); }
    finally { kids.destroy(); value.destroy(); type.destroy(); }
  };
  try { return !certification.isNull() || walk(fields); }
  finally { fields.destroy(); certification.destroy(); trailer.destroy(); }
}

async function inspectDocument(engine: Engine, document: PDFDocument, settings: VisibleCopySettings, control: VisibleCopyControl): Promise<VisibleCopyInspection> {
  const count = document.countPages(), pages: VisibleCopyPageInfo[] = [], warnings: VisibleCopyWarning[] = [], seenWarnings = new Set<string>();
  if (control.previewPage !== undefined && (!Number.isInteger(control.previewPage) || control.previewPage < 1 || control.previewPage > count)) throw new Error('Choose a preview page within the document.');
  let totalPixels = 0, selectedPixels = 0;
  const hasSignatures = strict(engine, () => containsSignature(document));
  control.onProgress?.({ phase: 'inspect', completed: 0, total: count });
  for (let index = 0; index < count; index++) {
    await tick(); cancel(control.signal);
    const page = strict(engine, () => document.loadPage(index), value => value.destroy());
    try {
      const bounds = strict(engine, () => page.getBounds()), width = bounds[2] - bounds[0], height = bounds[3] - bounds[1], scale = settings.dpi / 72;
      // Match MuPDF's float rectangle transform and 0.001 rounding tolerance;
      // plain JS ceil(240 * 150 / 72) incorrectly produces 501, not 500.
      const scaled = engine.Rect.transform([0, 0, width, height], engine.Matrix.scale(scale, scale));
      const pixelWidth = Math.ceil(scaled[2] - 0.001), pixelHeight = Math.ceil(scaled[3] - 0.001), pixels = pixelWidth * pixelHeight;
      const selected = control.previewPage === undefined || control.previewPage === index + 1;
      if (![width, height, pixels].every(Number.isFinite) || width <= 0 || height <= 0 || width > 14400 || height > 14400) throw new Error(`Page ${index + 1} has unsupported or invalid visible dimensions.`);
      if (selected && (pixelWidth < 1 || pixelHeight < 1 || pixelWidth > VISIBLE_COPY_LIMITS.dimension || pixelHeight > VISIBLE_COPY_LIMITS.dimension || pixels > VISIBLE_COPY_LIMITS.pagePixels)) throw new Error(`Page ${index + 1} has invalid pixel dimensions or exceeds 40 megapixels or 16,384 pixels on one side at ${settings.dpi} dpi. Choose 150 dpi or a smaller document.`);
      const object = page.getObject();
      try { strict(engine, () => fontWarnings(object, index + 1, warnings, seenWarnings)); }
      finally { object.destroy(); }
      pages.push({ pageNumber: index + 1, width, height, pixelWidth, pixelHeight, pixels }); totalPixels += pixels; if (selected) selectedPixels += pixels;
      if (selectedPixels > VISIBLE_COPY_LIMITS.totalPixels) throw new Error('This visible copy exceeds the 500 megapixel total budget. Choose 150 dpi or split the document first.');
    } finally { page.destroy(); }
    control.onProgress?.({ phase: 'inspect', completed: index + 1, total: count });
  }
  cancel(control.signal);
  return { pageCount: count, pages, totalPixels, hasSignatures, warnings, warningsTruncated: seenWarnings.size > warnings.length };
}

export async function inspectVisibleCopy(data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings = DEFAULT_VISIBLE_COPY_SETTINGS, control: VisibleCopyControl = {}): Promise<VisibleCopyInspection> {
  cancel(control.signal); validateInput(data, settings);
  const engine = await loadMuPDF(); cancel(control.signal); const document = open(engine, data);
  try { return await inspectDocument(engine, document, settings, control); } finally { document.destroy(); }
}

const outputKeys = new Set(['Root', 'Size', 'ID', 'Type', 'Pages', 'Kids', 'Count', 'Parent', 'MediaBox', 'Rotate', 'Resources', 'XObject', 'VisiblePage', 'Contents', 'Length', 'Filter', 'DecodeParms', 'Predictor', 'Colors', 'Columns', 'BitsPerComponent', 'Subtype', 'Width', 'Height', 'ColorSpace', 'Decode', 'Interpolate', 'N', 'Alternate', 'Range']);
/** Reopen the serialized copy and verify its complete reachable object graph. */
function verifyOutput(engine: Engine, data: Uint8Array, pages: VisibleCopyPageInfo[]) {
  const document = new engine.PDFDocument(data), seen = new Set<number>();
  const walk = (object: PDFObject) => {
    if (object.isIndirect()) { const ref = object.asIndirect(); if (seen.has(ref)) return; seen.add(ref); }
    if (object.isArray()) object.forEach(value => { try { walk(value); } finally { value.destroy(); } });
    else if (object.isDictionary()) object.forEach((value, key) => {
      try { if (!outputKeys.has(String(key))) throw new Error(`Unexpected ${String(key)} data in the visible copy.`); walk(value); }
      finally { value.destroy(); }
    });
  };
  try {
    if (document.wasRepaired() || document.needsPassword() || document.countPages() !== pages.length) throw new Error('The new visible copy could not be verified.');
    const trailer = document.getTrailer(); try { walk(trailer); } finally { trailer.destroy(); }
    for (const [index, expected] of pages.entries()) {
      const page = document.loadPage(index), object = page.getObject(), image = object.get('Resources', 'XObject', 'VisiblePage'), text = page.toStructuredText('');
      try {
        const bounds = page.getBounds(), imageWidth = image.get('Width'), imageHeight = image.get('Height'), subtype = image.get('Subtype');
        try {
          if (Math.abs(bounds[2] - bounds[0] - expected.width) > 0.002 || Math.abs(bounds[3] - bounds[1] - expected.height) > 0.002
            || subtype.asName() !== 'Image' || imageWidth.asNumber() !== expected.pixelWidth || imageHeight.asNumber() !== expected.pixelHeight || text.asText().trim()) throw new Error('The visible copy contains unexpected page dimensions or extractable text.');
        } finally { subtype.destroy(); imageHeight.destroy(); imageWidth.destroy(); }
      } finally { text.destroy(); image.destroy(); object.destroy(); page.destroy(); }
    }
  } finally { document.destroy(); }
}

/**
 * Build a new PDF solely from newly encoded View/CropBox RGB pixels. No source
 * objects, fonts, annotations, field values, metadata, or attachments are grafted.
 * This deliberately removes text selection, links, forms and digital signatures.
 */
export async function createVisibleCopy(data: Uint8Array | ArrayBuffer, settings: VisibleCopySettings = DEFAULT_VISIBLE_COPY_SETTINGS, control: VisibleCopyControl = {}): Promise<VisibleCopyResult> {
  cancel(control.signal); validateInput(data, settings);
  const engine = await loadMuPDF(); cancel(control.signal);
  const source = open(engine, data), target = new engine.PDFDocument();
  try {
    const trailer = target.getTrailer(), catalog = trailer.get('Root');
    try { trailer.delete('Info'); catalog.delete('Info'); } finally { catalog.destroy(); trailer.destroy(); }
    const inspection = await inspectDocument(engine, source, settings, control);
    const pages = inspection.pages.filter(page => control.previewPage === undefined || page.pageNumber === control.previewPage);
    let encodedImageBytes = 0;
    control.onProgress?.({ phase: 'render', completed: 0, total: pages.length });
    for (const [index, info] of pages.entries()) {
      await tick(); cancel(control.signal);
      const page = strict(engine, () => source.loadPage(info.pageNumber - 1), value => value.destroy());
      try {
        const bounds = strict(engine, () => page.getBounds()), scale = settings.dpi / 72;
        const matrix = engine.Matrix.concat(engine.Matrix.translate(-bounds[0], -bounds[1]), engine.Matrix.scale(scale, scale));
        const pixmap = strict(engine, () => page.toPixmap(matrix, engine.ColorSpace.DeviceRGB, false, true, 'View', 'CropBox'), value => value.destroy());
        let encoded: Uint8Array;
        try {
          if (pixmap.getWidth() !== info.pixelWidth || pixmap.getHeight() !== info.pixelHeight) throw new Error(`Page ${info.pageNumber} rendered unexpected pixel dimensions.`);
          encoded = strict(engine, () => new Uint8Array(settings.compression === 'jpeg' ? pixmap.asJPEG(settings.quality ?? 90) : pixmap.asPNG()));
        } finally { pixmap.destroy(); }
        encodedImageBytes += encoded.byteLength;
        if (encodedImageBytes > VISIBLE_COPY_LIMITS.encodedBytes) throw new Error('The rendered images exceed the 120 MB budget. Choose JPEG, reduce quality or split the document.');
        const image = strict(engine, () => new engine.Image(encoded), value => value.destroy());
        try {
          const imageObject = strict(engine, () => target.addImage(image), value => value.destroy());
          try {
            // Keep the render grid aligned even when the physical CropBox ends
            // between pixels. The last subpixel strip is clipped by the new page.
            const imageWidth = info.pixelWidth / scale, imageHeight = info.pixelHeight / scale;
            const pageObject = target.addPage([0, 0, info.width, info.height], 0, { XObject: { VisiblePage: imageObject } }, `q\n${pdfNumber(imageWidth)} 0 0 ${pdfNumber(imageHeight)} 0 ${pdfNumber(info.height - imageHeight)} cm\n/VisiblePage Do\nQ\n`);
            try { target.insertPage(-1, pageObject); } finally { pageObject.destroy(); }
          } finally { imageObject.destroy(); }
        } finally { image.destroy(); }
      } finally { page.destroy(); }
      // Bound the native decoded-image cache; encoded target streams remain.
      engine.emptyStore();
      control.onProgress?.({ phase: 'render', completed: index + 1, total: pages.length });
    }
    await tick(); cancel(control.signal);
    control.onProgress?.({ phase: 'save', completed: 0, total: 1 });
    const saved = strict(engine, () => target.saveToBuffer('incremental=no,garbage=1,compress=yes'), value => value.destroy());
    let output: Uint8Array;
    try { if (saved.getLength() > VISIBLE_COPY_LIMITS.outputBytes) throw new Error('The visible copy exceeds the 128 MB output limit. Choose JPEG, reduce quality or split the document.'); output = new Uint8Array(saved.asUint8Array()); }
    finally { saved.destroy(); }
    cancel(control.signal); control.onProgress?.({ phase: 'save', completed: 1, total: 1 });
    await tick(); cancel(control.signal); control.onProgress?.({ phase: 'verify', completed: 0, total: 1 });
    strict(engine, () => verifyOutput(engine, output, pages));
    cancel(control.signal); control.onProgress?.({ phase: 'verify', completed: 1, total: 1 });
    cancel(control.signal);
    return { data: output, pageCount: pages.length, sourcePageCount: inspection.pageCount, pages: pages.map(page => page.pageNumber), dpi: settings.dpi, compression: settings.compression, encodedImageBytes, warnings: inspection.warnings, warningsTruncated: inspection.warningsTruncated };
  } finally { target.destroy(); source.destroy(); }
}
