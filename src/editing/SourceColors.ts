import type { ColorSpace, PDFObject, PDFPage } from 'mupdf';
import type { loadMuPDF } from '../utils/mupdf';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
const number = (value: number) => String(Number(value.toFixed(5)));
/** What the page really painted with. The hexadecimal color only describes its display. */
export interface SourceColor { components: number[]; operator?: 'g' | 'k'; object?: PDFObject }
interface Candidate { object: PDFObject; components: number }

const nameOf = (object: PDFObject, ...path: (string | number)[]) => {
  const value = object.get(...path);
  try { return value.isName() ? value.asName() : ''; } finally { value.destroy(); }
};
function componentCount(space: PDFObject) {
  switch (nameOf(space, 0)) {
    case 'Separation': case 'CalGray': return 1;
    case 'CalRGB': case 'Lab': return 3;
    case 'DeviceN': { const names = space.get(1); try { return names.isArray() ? names.length : 0; } finally { names.destroy(); } }
    case 'ICCBased': { const count = space.get(1, 'N'); try { return count.asNumber(); } finally { count.destroy(); } }
    default: return 0;
  }
}
function readCandidates(resources: PDFObject) {
  const candidates: Candidate[] = [], forms = new Set<number>();
  const visit = (scope: PDFObject, depth: number) => {
    if (!scope.isDictionary() || depth > 16) return;
    const spaces = scope.get('ColorSpace'), xObjects = scope.get('XObject');
    try {
      if (spaces.isDictionary()) spaces.forEach(space => {
        const components = space.isArray() ? componentCount(space) : 0;
        if (components) candidates.push({ object: space, components }); else space.destroy();
      });
      if (xObjects.isDictionary()) xObjects.forEach(form => {
        try {
          const id = form.isIndirect() ? form.asIndirect() : 0;
          if ((id && forms.has(id)) || nameOf(form, 'Subtype') !== 'Form') return;
          if (id) forms.add(id);
          const nested = form.get('Resources');
          try { visit(nested, depth + 1); } finally { nested.destroy(); }
        } finally { form.destroy(); }
      });
    } finally { spaces.destroy(); xObjects.destroy(); }
  };
  visit(resources, 0);
  return candidates;
}
/** Device callbacks do not name the resource, so paint one pixel with each candidate. */
function paintsAs(engine: Engine, space: PDFObject, components: number[], rgb: number[]) {
  const scratch = new engine.PDFDocument();
  try {
    const spaces = scratch.newDictionary(), resources = scratch.newDictionary(), copy = scratch.graftObject(space);
    try {
      spaces.put('C', copy); resources.put('ColorSpace', spaces);
      const pageObject = scratch.addPage([0, 0, 1, 1], 0, resources, `/C cs ${components.map(number).join(' ')} scn 0 0 1 1 re f\n`);
      try { scratch.insertPage(0, pageObject); } finally { pageObject.destroy(); }
    } finally { copy.destroy(); resources.destroy(); spaces.destroy(); }
    const page = scratch.loadPage(0), pixmap = page.toPixmap(engine.Matrix.identity, engine.ColorSpace.DeviceRGB, false, false);
    try {
      const pixels = pixmap.getPixels();
      return rgb.every((value, index) => Math.abs(pixels[index] - value) <= 1);
    } finally { pixmap.destroy(); page.destroy(); }
  } finally { scratch.destroy(); }
}

/** Replacement text keeps its print inks and spot colors. Different colors can display
 * identically (a cyan spot and CMYK cyan), so each text block has its own table. */
export class SourceColorCatalog {
  private readonly colors = new Map<string, SourceColor>();
  private readonly pages = new Map<number, Candidate[]>();
  private readonly engine: Engine;
  constructor(engine: Engine) { this.engine = engine; }
  remember(page: PDFPage, blockId: string, hex: string, colorspace: ColorSpace, color: number[]) {
    const key = `${blockId}|${hex}`;
    if (this.colors.has(key)) return;
    if (colorspace.getName() === 'DeviceGray') this.colors.set(key, { components: color, operator: 'g' });
    else if (colorspace.getName() === 'DeviceCMYK') this.colors.set(key, { components: color, operator: 'k' });
    else if (colorspace.getName() !== 'DeviceRGB') {
      const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
      const found = this.candidates(page).find(candidate => candidate.components === color.length && paintsAs(this.engine, candidate.object, color, rgb));
      if (found) this.colors.set(key, { components: color, object: found.object });
    }
  }
  private candidates(page: PDFPage) {
    const pageObject = page.getObject();
    try {
      const id = pageObject.asIndirect();
      let candidates = this.pages.get(id);
      if (!candidates) {
        const resources = pageObject.getInheritable('Resources');
        try { candidates = readCandidates(resources); } finally { resources.destroy(); }
        this.pages.set(id, candidates);
      }
      return candidates;
    } finally { pageObject.destroy(); }
  }
  /** Replace the writer's RGB operators; it can express neither a spot color nor Lab. */
  apply(content: string, spaces: PDFObject, blockId: string) {
    const toHex = (value: string) => Math.round(Math.min(1, Number(value)) * 255 + .0001).toString(16).padStart(2, '0');
    const names = new Map<PDFObject, string>();
    return content.replace(/(^|\s)([\d.]+) ([\d.]+) ([\d.]+) (rg|RG)(?=\s)/g, (match, lead: string, r: string, g: string, b: string, operator: string) => {
      const color = this.colors.get(`${blockId}|#${toHex(r)}${toHex(g)}${toHex(b)}`), stroke = operator === 'RG';
      if (!color) return match;
      const values = color.components.map(number).join(' ');
      if (color.operator) return `${lead}${values} ${stroke ? color.operator.toUpperCase() : color.operator}`;
      let name = names.get(color.object!);
      if (!name) { name = `PDFEditorColor${names.size}`; names.set(color.object!, name); spaces.put(name, color.object!); }
      return `${lead}/${name} ${stroke ? 'CS' : 'cs'} ${values} ${stroke ? 'SCN' : 'scn'}`;
    });
  }
  destroy() {
    for (const candidates of this.pages.values()) for (const candidate of candidates) candidate.object.destroy();
    this.pages.clear(); this.colors.clear();
  }
}
