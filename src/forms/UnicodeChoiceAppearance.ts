import { PDFBool, PDFDict, PDFDocument as LibDocument, PDFDropdown, PDFName, PDFOptionList, StandardFonts } from 'pdf-lib';
import type { Color, Font, PDFDocument, PDFObject, PDFWidget, StrokeState } from 'mupdf';
import { loadMuPDF } from '../utils/mupdf';

type Engine = Awaited<ReturnType<typeof loadMuPDF>>;
interface Glyph { character: string; font: Font; glyph: number; advance: number }
interface Label { glyphs: Glyph[]; left: number; width: number; ascent: number; descent: number }

/** Rebuild only empty backgrounds with pdf-lib, restoring every native value. */
async function prepareBackgrounds(data: Uint8Array, names: Set<string>) {
  const pdf = await LibDocument.load(data, { updateMetadata: false });
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm?.has(PDFName.of('XFA'))) throw new Error('XFA choice fields are not supported. No form values were changed.');
  const form = pdf.getForm(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const pageCounts = new Map<PDFDict, number>();
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    for (let index = 0; annots && index < annots.size(); index++) {
      const object = annots.lookup(index);
      if (object instanceof PDFDict) pageCounts.set(object, (pageCounts.get(object) ?? 0) + 1);
    }
  }
  for (const name of names) {
    const field = form.getField(name);
    if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) throw new Error(`Form field "${name}" is not a dropdown or list.`);
    // Validate before the native C-string APIs can stop at an embedded NUL.
    const nativeStrings = field.acroField.getOptions().flatMap(option => [option.value.decodeText(), (option.display ?? option.value).decodeText()]);
    nativeStrings.push(...field.getSelected());
    if (nativeStrings.some(value => Array.from(value).some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127))) {
      throw new Error(`Choice field "${name}" contains a control character or line break in an option or value.`);
    }
    const widgets = field.acroField.getWidgets();
    if (!widgets.length || widgets.some(widget => pageCounts.get(widget.dict) !== 1)) throw new Error(`Choice field "${name}" has a widget without one unambiguous page.`);
    // updateAppearances writes /DA as well as /AP. Restore /DA and the original
    // values/indices/options so layout never changes field semantics or defaults.
    const dictionaries = [field.acroField.dict, ...widgets.map(widget => widget.dict)];
    const preserved = dictionaries.map(dict => ({ dict, entries: ['Opt', 'V', 'I', 'DA'].map(key => ({ key: PDFName.of(key), value: dict.get(PDFName.of(key)) })) }));
    try {
      for (const { dict } of preserved) {
        dict.set(PDFName.of('Opt'), pdf.context.obj([]));
        dict.delete(PDFName.of('V')); dict.delete(PDFName.of('I'));
      }
      field.updateAppearances(font);
    } finally {
      for (const { dict, entries } of preserved) for (const { key, value } of entries) {
        if (value === undefined) dict.delete(key); else dict.set(key, value);
      }
    }
    form.markFieldAsClean(field.ref);
  }
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.False);
  return pdf.save({ updateFieldAppearances: false });
}

function prepareLabel(engine: Engine, value: string, fonts: Font[], stroke: StrokeState, name: string): Label {
  const normalized = value.normalize('NFC');
  // These scripts need shaping/bidi, which a sequence of individual glyphs
  // cannot faithfully represent. Reject rather than export misleading text.
  const complexRanges = [[0x0590, 0x109f], [0x1780, 0x18af], [0x200c, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xa980, 0xa9df], [0xaa60, 0xaa7f], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
  if (/\p{M}/u.test(normalized) || Array.from(normalized).some(character => complexRanges.some(([start, end]) => character.codePointAt(0)! >= start && character.codePointAt(0)! <= end))) {
    throw new Error(`Choice field "${name}" requires complex-script layout, which is not supported yet. No label was discarded.`);
  }
  const glyphs = Array.from(normalized, character => {
    if (character.codePointAt(0)! < 32 || character.codePointAt(0) === 127) throw new Error(`Choice field "${name}" contains a control character or line break in an option.`);
    const font = fonts.find(candidate => candidate.encodeCharacter(character) !== 0);
    if (!font) throw new Error(`Choice field "${name}" contains unsupported character ${JSON.stringify(character)}. No label was discarded.`);
    const glyph = font.encodeCharacter(character);
    return { character, font, glyph, advance: font.advanceGlyph(glyph) };
  });
  let advance = 0;
  const text = new engine.Text();
  try {
    // Measure actual ink at 100 units to include glyph overhangs and ascenders.
    for (const glyph of glyphs) {
      text.showGlyph(glyph.font, [100, 0, 0, -100, advance * 100, 0], glyph.glyph, glyph.character.codePointAt(0)!);
      advance += glyph.advance;
    }
    const bounds = text.getBounds(stroke, engine.Matrix.identity);
    const nonempty = bounds[0] <= bounds[2] && bounds[1] <= bounds[3] && bounds.every(Number.isFinite);
    const left = nonempty ? Math.min(0, bounds[0] / 100) : 0;
    return {
      glyphs, left, width: Math.max(advance, nonempty ? bounds[2] / 100 : 0) - left,
      ascent: Math.max(0.8, nonempty ? -bounds[1] / 100 : 0),
      descent: Math.max(0.2, nonempty ? bounds[3] / 100 : 0),
    };
  } finally { text.destroy(); }
}

function strings(object: PDFObject): string[] {
  if (object.isNull()) return [];
  if (object.isString()) return [object.asString()];
  if (!object.isArray()) throw new Error('Choice field has a non-text value.');
  const result: string[] = [];
  object.forEach(value => {
    try { if (!value.isString()) throw new Error('Choice field has a non-text selected value.'); result.push(value.asString()); }
    finally { value.destroy(); }
  });
  return result;
}

function cloneDictionary(document: PDFDocument, source: PDFObject): PDFObject {
  const result = document.newDictionary();
  if (source.isDictionary()) source.forEach((value, key) => { try { result.put(key, value); } finally { value.destroy(); } });
  return result;
}

function graftResources(document: PDFDocument, source: PDFObject, fontCache: Map<string, PDFObject>): PDFObject {
  const resources = document.newDictionary(), fonts = document.newDictionary();
  try {
    source.forEach((value, key) => {
      try {
        if (key === 'Font') value.forEach((font, id) => {
          const baseName = font.get('BaseFont');
          try {
            const name = baseName.asName();
            // DocumentWriter uses our fixed fonts with full Identity-H maps.
            // Reuse their embedded programs across every widget in this export.
            if (!fontCache.has(name)) fontCache.set(name, document.graftObject(font));
            fonts.put(id, fontCache.get(name)!);
          } finally { baseName.destroy(); font.destroy(); }
        });
        else { const copied = document.graftObject(value); try { resources.put(key, copied); } finally { copied.destroy(); } }
      } finally { value.destroy(); }
    });
    resources.put('Font', fonts);
    return resources;
  } catch (error) { resources.destroy(); throw error; }
  finally { fonts.destroy(); }
}

function drawChoice(engine: Engine, document: PDFDocument, widget: PDFWidget, fonts: Font[], stroke: StrokeState, fontCache: Map<string, PDFObject>) {
  const owned: PDFObject[] = [];
  const own = (object: PDFObject) => { owned.push(object); return object; };
  const name = widget.getName();
  try {
    const object = own(widget.getObject()), appearance = own(object.get('AP', 'N'));
    if (!appearance.isStream()) throw new Error(`Choice field "${name}" has no writable appearance.`);
    const bbox = Array.from({ length: 4 }, (_, index) => own(appearance.get('BBox', index)).asNumber());
    const width = bbox[2] - bbox[0], height = bbox[3] - bbox[1];
    const rotation = ((own(object.get('MK', 'R')).asNumber() % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation)) throw new Error(`Choice field "${name}" has an unsupported rotation.`);
    const logicalWidth = rotation % 180 ? height : width, logicalHeight = rotation % 180 ? width : height;
    const padding = Math.max(2, widget.getBorderWidth() + 1);
    const availableWidth = logicalWidth - padding * 2, availableHeight = logicalHeight - padding * 2;
    if (!Number.isFinite(availableWidth + availableHeight) || availableWidth <= 0 || availableHeight <= 0) throw new Error(`Choice field "${name}" is too small to display its labels.`);
    const labels = widget.getOptions(false), exports = widget.getOptions(true);
    const selected = strings(own(object.getInheritable('V')));
    const indicesObject = own(object.getInheritable('I'));
    let indices = selected.map(value => {
      const exported = exports.indexOf(value);
      return exported >= 0 ? exported : labels.indexOf(value);
    });
    if (indicesObject.isArray() && indicesObject.length === selected.length) {
      const storedIndices = Array.from({ length: indicesObject.length }, (_, index) => own(indicesObject.get(index)).asNumber());
      if (storedIndices.every(index => Number.isInteger(index) && index >= 0 && index < labels.length && (selected.includes(exports[index]) || selected.includes(labels[index])))) indices = storedIndices;
    }
    const isList = widget.isListBox();
    if (isList && indices.some(index => index < 0)) throw new Error(`Choice field "${name}" has a selected value absent from its options.`);
    // Validate all options, including labels not currently displayed by a combo.
    const preparedOptions = labels.map(label => prepareLabel(engine, label, fonts, stroke, name));
    const prepared = isList ? preparedOptions : [prepareLabel(engine, selected.map((value, index) => labels[indices[index]] ?? value).join(', '), fonts, stroke, name)];
    const defaults = widget.getDefaultAppearance();
    const widest = Math.max(0.01, ...prepared.map(label => label.width));
    const ascent = Math.max(0.8, ...prepared.map(label => label.ascent));
    const descent = Math.max(0.2, ...prepared.map(label => label.descent));
    const lineFactor = Math.max(1.3, ascent + descent + 0.1);
    const firstSelected = indices.length ? Math.min(...indices) : 0, lastSelected = indices.length ? Math.max(...indices) : 0;
    const neededRows = isList && indices.length ? lastSelected - firstSelected + 1 : 1;
    let size = Math.min(defaults.size > 0 ? defaults.size : 12, availableWidth / widest, availableHeight / lineFactor / neededRows);
    if (!Number.isFinite(size) || size < 1) throw new Error(`Choice field "${name}" cannot display its labels and selected rows legibly. Enlarge the field or shorten its options; no text was truncated.`);
    size = Math.max(1, size);
    const rowHeight = size * lineFactor;
    const rows = isList ? Math.max(1, Math.floor((availableHeight + 0.001) / rowHeight)) : 1;
    const originalTop = own(object.getInheritable('TI')).asNumber();
    let top = isList && Number.isInteger(originalTop) ? Math.max(0, Math.min(originalTop, Math.max(0, labels.length - rows))) : 0;
    // A list is a scrollable viewport. Keep its top index when possible, but
    // include every selected row; never silently hide part of a multi-selection.
    if (isList && indices.length) top = Math.max(0, Math.min(firstSelected, Math.max(top, lastSelected - rows + 1)));
    if (isList && top !== originalTop) {
      let owner = object;
      for (;;) {
        if (!own(owner.get('FT')).isNull()) break;
        const parent = own(owner.get('Parent')); if (parent.isNull()) break; owner = parent;
      }
      owner.put('TI', top);
    }

    const output = new engine.Buffer(), writer = new engine.DocumentWriter(output, 'pdf', '');
    let overlay: PDFDocument | undefined;
    try {
      const device = writer.beginPage([0, 0, logicalWidth, logicalHeight]);
      try {
        const visible = prepared.slice(top, top + rows);
        for (const [row, label] of visible.entries()) {
          const highlighted = isList && indices.includes(top + row);
          if (highlighted) {
            const rectangle = new engine.Path();
            try { rectangle.rect(padding, padding + row * rowHeight, logicalWidth - padding, padding + (row + 1) * rowHeight); device.fillPath(rectangle, false, engine.Matrix.identity, engine.ColorSpace.DeviceRGB, [0.15, 0.35, 0.7], 1); }
            finally { rectangle.destroy(); }
          }
          const alignment = widget.getQuadding();
          let x = padding - label.left * size + (alignment === 1 ? (availableWidth - label.width * size) / 2 : alignment === 2 ? availableWidth - label.width * size : 0);
          const baseline = isList ? padding + row * rowHeight + (rowHeight - (ascent + descent) * size) / 2 + ascent * size : (logicalHeight - (ascent + descent) * size) / 2 + ascent * size;
          const text = new engine.Text();
          try {
            for (const glyph of label.glyphs) {
              text.showGlyph(glyph.font, [size, 0, 0, -size, x, baseline], glyph.glyph, glyph.character.codePointAt(0)!);
              x += glyph.advance * size;
            }
            const color: Color = highlighted ? [1] : defaults.color.length ? defaults.color : [0];
            const space = color.length === 1 ? engine.ColorSpace.DeviceGray : color.length === 4 ? engine.ColorSpace.DeviceCMYK : engine.ColorSpace.DeviceRGB;
            device.fillText(text, engine.Matrix.identity, space, color, 1);
          } finally { text.destroy(); }
        }
        device.close();
      } finally { device.destroy(); }
      writer.endPage(); writer.close();
      overlay = new engine.PDFDocument(output);
      const overlayPage = own(overlay.findPage(0)), contents = own(overlayPage.get('Contents'));
      const stream = contents.readStream();
      try {
        const resources = own(graftResources(document, own(overlayPage.get('Resources')), fontCache));
        const textForm = own(document.addStream(new Uint8Array(stream.asUint8Array()), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, logicalWidth, logicalHeight], Resources: resources }));
        const originalResources = own(appearance.get('Resources'));
        const combinedResources = own(cloneDictionary(document, originalResources));
        const xObjects = own(cloneDictionary(document, own(originalResources.get('XObject'))));
        xObjects.put('PDFEditorChoiceText', textForm); combinedResources.put('XObject', xObjects);
        const original = appearance.readStream();
        try {
          const transforms: Record<number, string> = { 0: '1 0 0 1 0 0', 90: `0 1 -1 0 ${width} 0`, 180: `-1 0 0 -1 ${width} ${height}`, 270: `0 -1 1 0 0 ${height}` };
          const dictionary = own(cloneDictionary(document, appearance));
          dictionary.delete('Filter'); dictionary.delete('DecodeParms'); dictionary.put('Resources', combinedResources);
          const replacement = own(document.addStream(`q\n${original.asString()}\nQ\nq\n1 0 0 1 ${bbox[0]} ${bbox[1]} cm\n${transforms[rotation]} cm\n/PDFEditorChoiceText Do\nQ\n`, dictionary));
          own(object.get('AP')).put('N', replacement);
        } finally { original.destroy(); }
      } finally { stream.destroy(); }
    } finally {
      // Release source PDFObjects before destroying their owning overlay PDF.
      for (const object of owned.reverse()) object.destroy(); owned.length = 0;
      overlay?.destroy(); writer.destroy(); output.destroy();
    }
  } finally { for (const object of owned.reverse()) object.destroy(); }
}

/** Embedded Unicode choice appearances; native options, values and defaults remain editable. */
export async function updateUnicodeChoiceAppearances(data: Uint8Array, names: Set<string>): Promise<Uint8Array> {
  if (!names.size) return new Uint8Array(data);
  const prepared = await prepareBackgrounds(data, names), engine = await loadMuPDF();
  const document = new engine.PDFDocument(prepared);
  const fonts = [new engine.Font('Helvetica'), new engine.Font('zh-Hans')];
  const stroke = new engine.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 1 });
  const fontCache = new Map<string, PDFObject>(), found = new Set<string>();
  try {
    for (let index = 0; index < document.countPages(); index++) {
      const page = document.loadPage(index);
      try {
        const widgets = page.getWidgets();
        try { for (const widget of widgets) if (widget.isChoice() && names.has(widget.getName())) {
          drawChoice(engine, document, widget, fonts, stroke, fontCache); found.add(widget.getName());
        } } finally { for (const widget of widgets) widget.destroy(); }
      } finally { page.destroy(); }
    }
    if ([...names].some(name => !found.has(name))) throw new Error('A choice field has no reachable page widget. No partial result was exported.');
    const result = document.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try { return new Uint8Array(result.asUint8Array()); } finally { result.destroy(); }
  } finally {
    for (const font of fonts) font.destroy();
    for (const font of fontCache.values()) font.destroy();
    stroke.destroy(); document.destroy();
  }
}
