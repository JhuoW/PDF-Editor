import type { Font, PDFObject, PDFPage } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
/** The page's own simple font dictionary, addressed by its existing character codes. */
export interface NativeSourceFont { object: PDFObject; codes: Map<number, number>; type3: boolean; monochrome?: boolean }
interface Candidate { object: PDFObject; names: string[]; type3: boolean; monochrome?: boolean; probe?: { codes: Map<number, number>; advances: Map<number, number>; signature: string } }

const nameOf = (object: PDFObject, ...path: string[]) => {
  const value = object.get(...path);
  try { return value.isName() ? value.asName() : ''; } finally { value.destroy(); }
};

/** d0/d1 must be the first operator in a Type 3 CharProc. Keep only d1 masks
 * (plus empty d0 spaces); arbitrary painted d0 programs stay read-only. */
function monochromeType3(font: PDFObject) {
  const programs = font.get('CharProcs');
  let safe = programs.isDictionary();
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const mask = new RegExp(`^\\s*(?:${number}\\s+){6}d1\\b`);
  const blank = new RegExp(`^\\s*(?:${number}\\s+){2}d0\\s*$`);
  try {
    if (safe) programs.forEach(program => {
      try {
        if (!program.isStream()) { safe = false; return; }
        const data = program.readStream();
        try {
          const content = data.asString().replace(/%[^\r\n]*/g, '');
          if (!mask.test(content) && !blank.test(content)) safe = false;
        } finally { data.destroy(); }
      } finally { program.destroy(); }
    });
  } finally { programs.destroy(); }
  return safe;
}

/** MuPDF's PDF writer would wrap a bare Type 1 program in a CIDFontType0, which the
 * PDF format does not allow: PDF.js, Poppler, Ghostscript and others paint wrong or
 * missing letters. Those programs are only valid behind their own simple font.
 * Type 3 glyphs are content streams the writer cannot embed at all, so they also
 * have to be painted through the page's own font dictionary. */
function readCandidates(document: PDFObject): Candidate[] {
  const candidates: Candidate[] = [], fontIds = new Set<number>(), formIds = new Set<number>();
  const visit = (resources: PDFObject, depth: number) => {
    if (!resources.isDictionary() || depth > 16) return;
    const fonts = resources.get('Font');
    try {
      if (fonts.isDictionary()) fonts.forEach(font => {
        const id = font.isIndirect() ? font.asIndirect() : 0;
        const subtype = nameOf(font, 'Subtype'), type3 = subtype === 'Type3';
        if ((id && fontIds.has(id)) || !(type3 || subtype === 'Type1' || subtype === 'MMType1')) { font.destroy(); return; }
        const program = font.get('FontDescriptor', 'FontFile');
        try {
          if (!type3 && !program.isStream()) { font.destroy(); return; }
          if (id) fontIds.add(id);
          candidates.push({ object: font, type3, ...(type3 ? { monochrome: monochromeType3(font) } : {}), names: [nameOf(font, 'BaseFont'), nameOf(font, 'Name'), nameOf(font, 'FontDescriptor', 'FontName')].filter(Boolean) });
        } finally { program.destroy(); }
      });
    } finally { fonts.destroy(); }
    const forms = resources.get('XObject');
    try {
      if (forms.isDictionary()) forms.forEach(form => {
        try {
          const id = form.isIndirect() ? form.asIndirect() : 0;
          if ((id && formIds.has(id)) || nameOf(form, 'Subtype') !== 'Form') return;
          if (id) formIds.add(id);
          const nested = form.get('Resources');
          try { visit(nested, depth + 1); } finally { nested.destroy(); }
        } finally { form.destroy(); }
      });
    } finally { forms.destroy(); }
  };
  visit(document, 0);
  return candidates;
}

/** A font without an outline program has no character map: MuPDF echoes the character back. */
export const isType3Font = (font: Font) => font.encodeCharacter(0x1f600) === 0x1f600 && font.encodeCharacter(0x41) === 0x41;

/** Equal names and advances do not identify a font: different Type 3 symbols and
 * independently subset programs can have both. Compare their actual glyph ink as
 * well. Fit each glyph into its own cell, so an unusually wide glyph cannot hide
 * its differences outside the atlas. The geometry remains part of the signature. */
function glyphSignature(engine: Engine, font: Font, gids: number[]) {
  const cell = 32, columns = Math.min(16, gids.length), rows = Math.ceil(gids.length / columns);
  if (!columns) return '';
  const pixmap = new engine.Pixmap(engine.ColorSpace.DeviceRGB, [0, 0, columns * cell, rows * cell], false);
  const text = new engine.Text(), stroke = new engine.StrokeState({ lineWidth: 0, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 1 });
  const geometry: string[] = [];
  try {
    pixmap.clear(255);
    for (const [index, gid] of gids.entries()) {
      const glyph = new engine.Text();
      try {
        glyph.showGlyph(font, [100, 0, 0, -100, 0, 0], gid, 0);
        const bounds = glyph.getBounds(stroke, engine.Matrix.identity);
        geometry.push(bounds.map(value => Number.isFinite(value) ? value.toFixed(4) : String(value)).join(','));
        if (!bounds.every(Number.isFinite) || bounds[2] < bounds[0] || bounds[3] < bounds[1]) continue;
        const scale = (cell - 4) / Math.max(1, bounds[2] - bounds[0], bounds[3] - bounds[1]);
        text.showGlyph(font, [100 * scale, 0, 0, -100 * scale,
          index % columns * cell + 2 - bounds[0] * scale,
          Math.floor(index / columns) * cell + 2 - bounds[1] * scale], gid, 0);
      } finally { glyph.destroy(); }
    }
    const device = new engine.DrawDevice(engine.Matrix.identity, pixmap);
    try { device.fillText(text, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, [0, 0, 0], 1); device.close(); }
    finally { device.destroy(); }
    // Two independent 32-bit accumulators avoid retaining a full bitmap for every
    // source font; the per-glyph geometry is compared without hashing.
    let first = 2166136261, second = 5381;
    for (const pixel of pixmap.getPixels()) { first = Math.imul(first ^ pixel, 16777619); second = Math.imul(second, 33) ^ pixel; }
    return `${geometry.join(';')}|${first >>> 0}:${second >>> 0}`;
  } finally { stroke.destroy(); text.destroy(); pixmap.destroy(); }
}

/** Ask the same interpreter which glyph each code paints, instead of reimplementing
 * Type 1 built-in encodings and /Differences. Type 3 GIDs are byte codes, so zero
 * can name a real CharProc; other font programs reserve GID zero for .notdef. */
function probeSimpleFont(engine: Engine, font: PDFObject) {
  const scratch = new engine.PDFDocument();
  const type3 = nameOf(font, 'Subtype') === 'Type3';
  const codes = new Map<number, number>(), advances = new Map<number, number>();
  let program: Font | undefined, signature = '';
  try {
    const dictionary = scratch.newDictionary(), resources = scratch.newDictionary(), copy = scratch.graftObject(font);
    try {
      dictionary.put('F', copy); resources.put('Font', dictionary);
      const rows = Array.from({ length: 256 }, (_, code) => `1 0 0 1 ${code} 0 Tm <${code.toString(16).padStart(2, '0')}> Tj`);
      const pageObject = scratch.addPage([0, 0, 1000, 1000], 0, resources, `BT /F 1 Tf\n${rows.join('\n')}\nET\n`);
      try { scratch.insertPage(0, pageObject); } finally { pageObject.destroy(); }
    } finally { copy.destroy(); resources.destroy(); dictionary.destroy(); }
    const page = scratch.loadPage(0);
    const read = (text: import('mupdf').Text) => {
      try {
        text.walk({ showGlyph(painted, matrix, gid) {
          program ??= new engine.Font(painted.pointer);
          if (gid < 0 || (!type3 && gid === 0) || codes.has(gid)) return;
          codes.set(gid, Math.round(matrix[4])); advances.set(gid, painted.advanceGlyph(gid));
        } });
      } finally { text.destroy(); }
    };
    const device = new engine.Device({
      fillText(text, _matrix, colorspace) {
        try { read(text); } finally { colorspace.destroy(); }
      },
      // Colored/non-cacheable Type 3 glyphs expand to paths and images, followed
      // by ignoreText carrying their searchable glyph identity.
      ignoreText(text) { read(text); },
    });
    try {
      page.runPageContents(device, engine.Matrix.identity); device.close();
      if (program) signature = glyphSignature(engine, program, [...codes.keys()].sort((a, b) => a - b));
    }
    finally { device.destroy(); page.destroy(); }
  } finally { program?.destroy(); scratch.destroy(); }
  return { codes, advances, signature };
}

/** One lookup per layout session; dictionaries stay owned by the page's document. */
export class NativeSourceFontCatalog {
  private readonly pages = new Map<number, Candidate[]>();
  private readonly signatures = new Map<number, Map<string, string>>();
  private readonly engine: Engine;
  constructor(engine: Engine) { this.engine = engine; }
  find(page: PDFPage, font: Font): NativeSourceFont | undefined {
    const pageObject = page.getObject();
    let candidates: Candidate[];
    try {
      const id = pageObject.asIndirect();
      candidates = this.pages.get(id) ?? [];
      if (!this.pages.has(id)) {
        const resources = pageObject.getInheritable('Resources');
        try { candidates = readCandidates(resources); } finally { resources.destroy(); }
        this.pages.set(id, candidates);
      }
    } finally { pageObject.destroy(); }
    const name = font.getName();
    const eligible = candidates.filter(candidate => candidate.names.includes(name));
    // Type 3 /Name is optional. An unnamed dictionary needs the same ink check,
    // but must never take priority over a dictionary explicitly naming this font.
    if (isType3Font(font)) eligible.push(...candidates.filter(candidate => candidate.type3 && !candidate.names.length));
    for (const candidate of eligible) {
      candidate.probe ??= probeSimpleFont(this.engine, candidate.object);
      // Subset tags can repeat across different programs. Glyph numbers are only
      // meaningful for one program, so require its advances to match as well.
      const { codes, advances, signature } = candidate.probe;
      if (!codes.size || ![...advances].every(([gid, advance]) => Math.abs(font.advanceGlyph(gid) - advance) < 1e-4)) continue;
      const gids = [...codes.keys()].sort((a, b) => a - b), key = gids.join(',');
      let signatures = this.signatures.get(font.pointer);
      if (!signatures) { signatures = new Map(); this.signatures.set(font.pointer, signatures); }
      let actual = signatures.get(key);
      if (actual === undefined) { actual = glyphSignature(this.engine, font, gids); signatures.set(key, actual); }
      if (actual === signature) return { object: candidate.object, codes, type3: candidate.type3, monochrome: candidate.monochrome };
    }
    return undefined;
  }
  destroy() {
    for (const candidates of this.pages.values()) for (const candidate of candidates) candidate.object.destroy();
    this.pages.clear();
    this.signatures.clear();
  }
}
