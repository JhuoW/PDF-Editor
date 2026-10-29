import {
  AnnotationFlags, PDFArray, PDFBool, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown,
  PDFField, PDFHexString, PDFName, PDFNull, PDFNumber, PDFOptionList, PDFRadioGroup, PDFRef,
  PDFSignature, PDFString, PDFTextField, StandardFonts,
} from 'pdf-lib';
import type { PDFObject, PDFPage, PDFWidgetAnnotation } from 'pdf-lib';
import { loadMuPDF } from '../utils/mupdf';
import { extractFormFields } from './FormFieldExtractor';
import { updateUnicodeFormAppearances } from './UnicodeFormAppearance';
import { updateUnicodeChoiceAppearances } from './UnicodeChoiceAppearance';
import type { FormFieldOption } from './types';
import type { FormDesignDocument, FormDesignField, FormDesignFieldPatch, FormDesignOperation, FormDesignValue, FormDesignWidget, NewFormDesignWidget } from './FormDesignerTypes';
export type * from './FormDesignerTypes';

const key = PDFName.of;
const buffer = (data: Uint8Array) => new Uint8Array(data).buffer;
type SupportedField = PDFTextField | PDFCheckBox | PDFRadioGroup | PDFDropdown | PDFOptionList;
const isSupported = (field: PDFField): field is SupportedField => field instanceof PDFTextField || field instanceof PDFCheckBox || field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList;

function geometry(page: PDFPage) {
  const media = page.getMediaBox(), crop = page.getCropBox();
  const left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width), top = Math.min(media.y + media.height, crop.y + crop.height);
  const box = right > left && top > bottom ? { x: left, y: bottom, width: right - left, height: top - bottom } : media;
  const raw = page.node.lookupMaybe(key('UserUnit'), PDFNumber)?.asNumber();
  const unit = raw && Number.isFinite(raw) && raw > 0 ? raw : 1;
  return { left: box.x, top: box.y + box.height, unit, width: box.width * unit, height: box.height * unit };
}

function restriction(pdf: PDFDocument): string | undefined {
  const acro = pdf.catalog.lookupMaybe(key('AcroForm'), PDFDict);
  if (acro?.has(key('XFA'))) return 'XFA forms are not supported by the form designer.';
  const permissions = pdf.catalog.lookupMaybe(key('Perms'), PDFDict);
  if (permissions?.has(key('DocMDP'))) return 'Signed or certified PDFs cannot be changed by the form designer.';
  const seen = new Set<PDFObject>();
  const inspect = (object: PDFObject | undefined): string | undefined => {
    if (!object || seen.has(object)) return undefined;
    seen.add(object);
    if (object instanceof PDFRef) return inspect(pdf.context.lookup(object));
    if (object instanceof PDFArray) {
      for (const child of object.asArray()) { const reason = inspect(child); if (reason) return reason; }
    } else if (object instanceof PDFDict) {
      const signatureValue = object.get(key('FT')) === key('Sig') ? pdf.context.lookup(object.get(key('V'))) : undefined;
      if (object.has(key('ByteRange')) || (signatureValue !== undefined && signatureValue !== PDFNull)) return 'Signed or certified PDFs cannot be changed by the form designer.';
      const action = object.get(key('S'));
      if (object.has(key('AA')) || ['JavaScript', 'SubmitForm', 'ResetForm', 'ImportData'].some(name => action === key(name))) return 'Forms with scripts or additional actions cannot be redesigned safely yet.';
      for (const [, child] of object.entries()) { const reason = inspect(child); if (reason) return reason; }
    }
    return undefined;
  };
  const nestedReason = inspect(pdf.catalog);
  if (nestedReason) return nestedReason;
  const names = pdf.catalog.lookupMaybe(key('Names'), PDFDict);
  if (names?.has(key('JavaScript'))) return 'Forms with scripts or additional actions cannot be redesigned safely yet.';
  return undefined;
}

function widgetPages(pdf: PDFDocument) {
  const result = new Map<PDFDict, number[]>();
  pdf.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let item = 0; item < annots.size(); item++) {
      const object = annots.lookup(item);
      if (object instanceof PDFDict) result.set(object, [...(result.get(object) ?? []), index + 1]);
    }
  });
  return result;
}

function typeOf(field: PDFField): FormDesignField['type'] {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'listbox';
  return field instanceof PDFSignature ? 'signature' : 'button';
}
function choices(field: PDFDropdown | PDFOptionList): FormFieldOption[] {
  return field.acroField.getOptions().map(option => ({ value: option.value.decodeText(), label: (option.display ?? option.value).decodeText() }));
}
function choiceValues(field: PDFDropdown | PDFOptionList): string[] {
  const options = choices(field);
  return field.getSelected().map(value => options.find(option => option.value === value)?.value ?? options.find(option => option.label === value)?.value ?? value);
}
function valueOf(field: PDFField): FormDesignValue {
  if (field instanceof PDFTextField) return field.getText() ?? '';
  if (field instanceof PDFCheckBox) return field.isChecked();
  if (field instanceof PDFRadioGroup) return field.getSelected() ?? '';
  if (field instanceof PDFDropdown) { const selected = choiceValues(field); return field.isMultiselect() ? selected : selected[0] ?? ''; }
  if (field instanceof PDFOptionList) return choiceValues(field);
  return '';
}
function defaultOf(field: PDFField): FormDesignValue | undefined {
  const value = field.acroField.dict.context.lookup(field.acroField.getInheritableAttribute(key('DV')));
  if (value === undefined) return undefined;
  if (field instanceof PDFCheckBox) return value instanceof PDFName && value !== key('Off');
  if (field instanceof PDFRadioGroup && value instanceof PDFName) {
    if (value === key('Off')) return '';
    const index = field.acroField.getWidgets().findIndex(widget => widget.getOnValue() === value);
    return field.getOptions()[index] ?? value.decodeText();
  }
  const decode = (item: PDFObject) => { const resolved = field.acroField.dict.context.lookup(item); return resolved instanceof PDFHexString || resolved instanceof PDFString ? resolved.decodeText() : undefined; };
  if (value instanceof PDFArray) return value.asArray().map(decode).filter((item): item is string => item !== undefined);
  const decoded = decode(value);
  return field instanceof PDFOptionList ? decoded === undefined ? [] : [decoded] : decoded;
}
function defaultAppearance(widget: PDFWidgetAnnotation | undefined, field: PDFField): string {
  const inherited = field.acroField.dict.context.lookup(field.acroField.getInheritableAttribute(key('DA')));
  const value = widget?.dict.lookup(key('DA')) ?? inherited;
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
}
function appearanceWithSize(appearance: string, size: number): string {
  if (!appearance.trim()) return `/Helvetica ${size} Tf 0 g`;
  const command = [...appearance.matchAll(/(\/[^\s]+)\s+[+-]?(?:\d*\.\d+|\d+\.?\d*)\s+Tf\b/g)].at(-1);
  if (!command) return `${appearance}\n/Helvetica ${size} Tf`;
  return `${appearance.slice(0, command.index)}${command[1]} ${size} Tf${appearance.slice(command.index! + command[0].length)}`;
}
function fontSize(widget: PDFWidgetAnnotation, field: PDFField, unit: number) {
  const appearance = defaultAppearance(widget, field);
  const matches = [...appearance.matchAll(/\/[^\s]+\s+([\d.]+)\s+Tf\b/g)];
  const size = Number(matches.at(-1)?.[1]);
  return Number.isFinite(size) && size > 0 ? size * unit : undefined;
}

function inspectLoaded(pdf: PDFDocument): FormDesignDocument {
  const pageList = pdf.getPages(), owners = widgetPages(pdf);
  const reason = restriction(pdf);
  const fields = pdf.getForm().getFields().map(field => {
    let unsupportedReason = isSupported(field) ? undefined : 'Signature and button fields can be preserved but cannot be designed yet.';
    if (field instanceof PDFTextField && (field.isRichFormatted() || field.isFileSelector())) unsupportedReason = 'Rich-text and file-selection fields are not supported by the form designer.';
    const widgets: FormDesignWidget[] = field.acroField.getWidgets().map((widget, index) => {
      const ref = pdf.context.getObjectRef(widget.dict);
      const pages = owners.get(widget.dict) ?? [];
      if (!ref || pages.length !== 1) unsupportedReason = 'Every widget must have an indirect reference and belong to exactly one page.';
      const pageNumber = pages[0] ?? 0;
      const page = pageList[pageNumber - 1];
      const rect = widget.getRectangle();
      const bounds = page ? geometry(page) : { left: 0, top: 0, unit: 1 };
      const rotation = widget.getAppearanceCharacteristics()?.getRotation() ?? 0;
      if (rotation % 360 !== 0) unsupportedReason = 'Individually rotated widgets are not supported by the form designer yet. Page rotation is supported.';
      if (widget.dict.has(key('A')) || widget.dict.has(key('AA'))) unsupportedReason = 'Widget actions are not supported by the form designer.';
      return { id: ref?.toString() ?? `unsupported-${index}`, pageNumber,
        rect: { x: (rect.x - bounds.left) * bounds.unit, y: (bounds.top - rect.y - rect.height) * bounds.unit, width: rect.width * bounds.unit, height: rect.height * bounds.unit },
        hidden: widget.hasFlag(AnnotationFlags.Hidden) || widget.hasFlag(AnnotationFlags.Invisible) || widget.hasFlag(AnnotationFlags.NoView),
        optionValue: field instanceof PDFRadioGroup ? field.getOptions()[index] : undefined };
    });
    if (widgets.length === 0) unsupportedReason = 'Fields without page widgets cannot be designed safely.';
    if (field instanceof PDFRadioGroup && new Set(widgets.map(widget => widget.optionValue)).size !== widgets.length) unsupportedReason = 'Radio groups with duplicated export options cannot be redesigned safely yet.';
    const first = field.acroField.getWidgets()[0];
    const firstPage = pageList[(widgets[0]?.pageNumber ?? 0) - 1];
    return { id: field.ref.toString(), name: field.getName(), type: typeOf(field), widgets,
      value: valueOf(field), defaultValue: defaultOf(field), required: field.isRequired(), readOnly: field.isReadOnly(),
      supported: !unsupportedReason, unsupportedReason,
      options: field instanceof PDFDropdown || field instanceof PDFOptionList ? choices(field) : undefined,
      multiSelect: field instanceof PDFDropdown || field instanceof PDFOptionList ? field.isMultiselect() : undefined,
      allowCustomValue: field instanceof PDFDropdown ? field.isEditable() : undefined,
      fontSize: first && firstPage ? fontSize(first, field, geometry(firstPage).unit) : undefined,
      textAlign: field instanceof PDFTextField ? (['left', 'center', 'right'] as const)[field.getAlignment()] : undefined,
      multiline: field instanceof PDFTextField ? field.isMultiline() : undefined,
      maxLength: field instanceof PDFTextField ? field.getMaxLength() ?? null : undefined };
  });
  return { pages: pageList.map((page, index) => ({ pageNumber: index + 1, width: geometry(page).width, height: geometry(page).height })), fields, canEdit: !reason, unsupportedReason: reason };
}

export async function inspectFormDesign(data: ArrayBuffer): Promise<FormDesignDocument> {
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  return inspectLoaded(pdf);
}

function nativeRect(pdf: PDFDocument, widget: NewFormDesignWidget) {
  if (!Number.isInteger(widget.pageNumber) || widget.pageNumber < 1 || widget.pageNumber > pdf.getPageCount()) throw new Error('Choose a valid page for the form widget.');
  const page = pdf.getPage(widget.pageNumber - 1), bounds = geometry(page);
  const { x, y, width, height } = widget.rect;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > bounds.width + 0.01 || y + height > bounds.height + 0.01) throw new Error('Form widgets must fit inside the visible page with positive dimensions.');
  return { page, unit: bounds.unit, rect: { x: bounds.left + x / bounds.unit, y: bounds.top - (y + height) / bounds.unit, width: width / bounds.unit, height: height / bounds.unit } };
}
function validateName(name: string) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.split('.').some(part => !part) || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Field names must be nonempty, have no control characters, and use nonempty dot-separated components.');
}
function validateOptions(options: FormFieldOption[]) {
  if (!Array.isArray(options) || options.some(option => !option || typeof option.value !== 'string' || !option.value || typeof option.label !== 'string' || !option.label || /[\r\n]/.test(option.label))) throw new Error('Each choice needs a nonempty, single-line label and a nonempty export value.');
  if (new Set(options.map(option => option.value)).size !== options.length) throw new Error('Choice export values must be unique.');
}
function checkedValue(field: SupportedField, value: FormDesignValue): FormDesignValue {
  if (field instanceof PDFTextField) {
    if (typeof value !== 'string') throw new Error('Text fields require a text value.');
    if (!field.isMultiline() && /[\r\n]/.test(value)) throw new Error('Enable multiline before using line breaks in a text field.');
    const limit = field.getMaxLength();
    if (limit !== undefined && value.length > limit) throw new Error(`The text exceeds the field's ${limit}-character maximum.`);
    return value;
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') throw new Error('Checkbox values must be true or false.');
    return value;
  }
  if (field instanceof PDFRadioGroup) {
    if (typeof value !== 'string' || (value && !field.getOptions().includes(value))) throw new Error('Choose an existing radio option, or an empty value.');
    return value;
  }
  const values = typeof value === 'string' ? value ? [value] : [] : value;
  if (!Array.isArray(values) || !values.every(item => typeof item === 'string')) throw new Error('Choice fields require text values.');
  if (!field.isMultiselect() && values.length > 1) throw new Error('Enable multiple selection before selecting more than one option.');
  if (new Set(values).size !== values.length) throw new Error('Selected choices must not contain duplicates.');
  if (!(field instanceof PDFDropdown && field.isEditable()) && values.some(value => !choices(field).some(option => option.value === value))) throw new Error('A selected or default value is missing from the choices. Update the value explicitly before removing that option.');
  return field instanceof PDFOptionList || field.isMultiselect() ? values : values[0] ?? '';
}
function setValue(pdf: PDFDocument, field: SupportedField, value: FormDesignValue, defaultValue = false) {
  value = checkedValue(field, value);
  if (defaultValue) {
    let encoded;
    if (field instanceof PDFCheckBox) encoded = value ? field.acroField.getOnValue() ?? key('Yes') : key('Off');
    else if (field instanceof PDFRadioGroup) encoded = value ? field.acroField.getWidgets()[field.getOptions().indexOf(value as string)].getOnValue()! : key('Off');
    else encoded = Array.isArray(value) ? pdf.context.obj(value.map(PDFHexString.fromText)) : PDFHexString.fromText(value as string);
    field.acroField.dict.set(key('DV'), encoded);
  } else if (field instanceof PDFTextField) field.setText(value as string);
  else if (field instanceof PDFCheckBox) { if (value) field.check(); else field.uncheck(); }
  else if (field instanceof PDFRadioGroup) { if (value) field.select(value as string); else field.clear(); }
  else {
    const values = Array.isArray(value) ? value : value ? [value as string] : [];
    const encoded = values.map(PDFHexString.fromText);
    if (encoded.length === 0) { field.clear(); return; }
    field.acroField.dict.set(key('V'), encoded.length === 1 ? encoded[0] : pdf.context.obj(encoded));
    const indices = values.map(value => choices(field).findIndex(option => option.value === value)).sort((a, b) => a - b);
    if (values.length > 1 && indices.every(index => index >= 0)) field.acroField.dict.set(key('I'), pdf.context.obj(indices));
    else field.acroField.dict.delete(key('I'));
  }
}

function setHidden(widget: PDFWidgetAnnotation, hidden: boolean) {
  widget.setFlagTo(AnnotationFlags.Hidden, hidden);
  widget.setFlagTo(AnnotationFlags.Invisible, false);
  widget.setFlagTo(AnnotationFlags.NoView, false);
}
function setFontSize(pdf: PDFDocument, field: SupportedField, size: number) {
  if (!(field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList)) throw new Error('Only text and choice fields have a font size.');
  if (!Number.isFinite(size) || size < 1 || size > 144) throw new Error('Choose a font size between 1 and 144 points.');
  const owners = widgetPages(pdf);
  for (const widget of field.acroField.getWidgets()) {
    const pageNumber = owners.get(widget.dict)?.[0];
    if (!pageNumber) throw new Error('Cannot set the font of an orphan widget.');
    const unit = geometry(pdf.getPage(pageNumber - 1)).unit;
    widget.setDefaultAppearance(appearanceWithSize(defaultAppearance(widget, field), size / unit));
  }
  field.acroField.setDefaultAppearance(appearanceWithSize(defaultAppearance(undefined, field), size));
}

function patchField(pdf: PDFDocument, field: SupportedField, patch: FormDesignFieldPatch, deferValues = false) {
  const previousValue = valueOf(field), previousDefault = defaultOf(field);
  if (patch.name !== undefined && patch.name !== field.getName()) {
    validateName(patch.name);
    const parent = field.acroField.getParent()?.getFullyQualifiedName();
    const prefix = parent ? `${parent}.` : '';
    if (!patch.name.startsWith(prefix) || patch.name.slice(prefix.length).includes('.')) throw new Error('Renaming a field must keep its existing parent group; moving field hierarchies is not supported yet.');
    if (pdf.getForm().getFields().some(other => other.ref !== field.ref && other.getName() === patch.name)) throw new Error(`A field named "${patch.name}" already exists.`);
    field.acroField.setPartialName(patch.name.slice(prefix.length));
  }
  if (patch.required !== undefined) { if (patch.required) field.enableRequired(); else field.disableRequired(); }
  if (patch.readOnly !== undefined) { if (patch.readOnly) field.enableReadOnly(); else field.disableReadOnly(); }
  if (patch.options !== undefined) {
    if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) throw new Error('Only dropdown and list fields use choice options; edit a radio widget option instead.');
    validateOptions(patch.options);
    field.acroField.setOptions(patch.options.map(option => ({ value: PDFHexString.fromText(option.value), display: PDFHexString.fromText(option.label) })));
  }
  if (patch.multiSelect !== undefined) {
    if (!(field instanceof PDFDropdown || field instanceof PDFOptionList)) throw new Error('Only choice fields support multiple selection.');
    if (patch.multiSelect) field.enableMultiselect(); else field.disableMultiselect();
  }
  if (patch.allowCustomValue !== undefined) {
    if (!(field instanceof PDFDropdown)) throw new Error('Only dropdown fields support custom values.');
    if (patch.allowCustomValue) field.enableEditing(); else field.disableEditing();
  }
  if (patch.multiline !== undefined || patch.maxLength !== undefined || patch.textAlign !== undefined) {
    if (!(field instanceof PDFTextField)) throw new Error('Multiline, maximum length and text alignment apply only to text fields.');
    if (patch.multiline !== undefined) { if (patch.multiline) field.enableMultiline(); else field.disableMultiline(); }
    if (patch.maxLength !== undefined) {
      if (patch.maxLength === null) field.removeMaxLength();
      else if (!Number.isSafeInteger(patch.maxLength) || patch.maxLength < 1) throw new Error('Maximum length must be a positive integer or null.');
      else { field.acroField.dict.set(key('MaxLen'), PDFNumber.of(patch.maxLength)); }
    }
    if (patch.textAlign !== undefined) {
      const alignment = ['left', 'center', 'right'].indexOf(patch.textAlign);
      if (alignment < 0) throw new Error('Choose left, center or right text alignment.');
      field.setAlignment(alignment);
    }
  }
  if (!deferValues) {
    setValue(pdf, field, patch.value ?? previousValue);
    if (patch.defaultValue !== undefined || previousDefault !== undefined) setValue(pdf, field, patch.defaultValue ?? previousDefault!, true);
  }
  if (patch.fontSize !== undefined) setFontSize(pdf, field, patch.fontSize);
}

function addWidget(pdf: PDFDocument, field: SupportedField, input: NewFormDesignWidget) {
  if (field.acroField.getWidgets().some(widget => widget.dict === field.acroField.dict)) throw new Error('Adding copies to merged field/widget objects is not supported yet; the existing widget was preserved.');
  const position = nativeRect(pdf, input);
  const saved = new Map(['V', 'Opt', 'I'].map(name => [name, field.acroField.dict.get(key(name))]));
  // Public addToPage draws immediately using WinAnsi. Build the new background
  // blank, then generate the real Unicode appearances once the operation is complete.
  if (field instanceof PDFTextField) field.setText('');
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) { field.clear(); field.setOptions([]); }
  try {
    const options = { ...position.rect, hidden: input.hidden ?? false, borderWidth: 1 };
    if (field instanceof PDFRadioGroup) {
      if (typeof input.optionValue !== 'string' || !input.optionValue || field.getOptions().includes(input.optionValue)) throw new Error('Each radio widget requires a unique nonempty option value.');
      field.addOptionToPage(input.optionValue, position.page, options);
    } else field.addToPage(position.page, options);
  } finally {
    for (const [name, value] of saved) {
      if (field instanceof PDFRadioGroup && name === 'Opt') continue;
      if (value !== undefined) field.acroField.dict.set(key(name), value); else field.acroField.dict.delete(key(name));
    }
  }
  const widget = field.acroField.getWidgets().at(-1)!;
  widget.setRectangle(position.rect);
  setHidden(widget, input.hidden ?? false);
  return widget;
}

function removeField(pdf: PDFDocument, field: PDFField) {
  const refs = field.acroField.getWidgets().map(widget => pdf.context.getObjectRef(widget.dict));
  for (const page of pdf.getPages()) for (const ref of refs) if (ref) page.node.removeAnnot(ref);
  pdf.getForm().acroForm.removeField(field.acroField);
  const order = pdf.getForm().acroForm.dict.lookupMaybe(key('CO'), PDFArray);
  if (order) for (let index = order.size() - 1; index >= 0; index--) if (order.get(index) === field.ref) order.remove(index);
  for (const ref of refs) if (ref && ref !== field.ref) pdf.context.delete(ref);
  pdf.context.delete(field.ref);
}

function normalizeRadioStates(pdf: PDFDocument, field: PDFRadioGroup) {
  const value = valueOf(field), defaultValue = defaultOf(field);
  // pdf-lib derives new on-state names from the current option count. After
  // removing a middle widget that can collide with a surviving widget's name.
  // Keep widget refs/options, but assign unique appearance states before values.
  field.acroField.getWidgets().forEach((widget, index) => {
    const oldName = widget.getOnValue(), newName = key(`PDFEditorOption_${index}`);
    const appearances = widget.dict.lookupMaybe(key('AP'), PDFDict);
    for (const kind of ['N', 'D', 'R']) {
      const states = appearances?.lookupMaybe(key(kind), PDFDict);
      const appearance = oldName ? states?.get(oldName) : undefined;
      if (states && oldName && appearance) { states.delete(oldName); states.set(newName, appearance); }
    }
    widget.setAppearanceState(key('Off'));
  });
  setValue(pdf, field, value);
  if (defaultValue !== undefined) setValue(pdf, field, defaultValue, true);
}

/** Apply a transaction to native AcroForm objects; never modify caller bytes. */
export async function applyFormDesign(data: ArrayBuffer, operations: FormDesignOperation[]): Promise<Uint8Array> {
  if (!operations.length) return new Uint8Array(data.slice(0));
  const pdf = await PDFDocument.load(data, { updateMetadata: false });
  const reason = restriction(pdf);
  if (reason) throw new Error(reason);
  const form = pdf.getForm();
  const redraw = new Set<string>();
  const pendingValues = new Map<string, { value?: FormDesignValue; defaultValue?: FormDesignValue }>();
  for (const operation of operations) {
    if (operation.type === 'create-field') {
      const input = operation.field;
      validateName(input.name);
      if (form.getFields().some(field => field.getName() === input.name)) throw new Error(`A field named "${input.name}" already exists.`);
      if (!input.widgets.length) throw new Error('Create at least one widget for each new field.');
      const factories = { text: () => form.createTextField(input.name), checkbox: () => form.createCheckBox(input.name), radio: () => form.createRadioGroup(input.name), dropdown: () => form.createDropdown(input.name), listbox: () => form.createOptionList(input.name) };
      if (!(input.type in factories)) throw new Error('Only text, checkbox, radio, dropdown and list fields can be designed.');
      const field = factories[input.type]();
      for (const widget of input.widgets) addWidget(pdf, field, widget);
      patchField(pdf, field, { ...input, value: input.value ?? input.defaultValue ?? valueOf(field) });
      if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) setFontSize(pdf, field, input.fontSize ?? 12);
      redraw.add(field.ref.toString());
      continue;
    }
    const field = form.getFields().find(field => field.ref.toString() === operation.fieldId);
    const inspected = inspectLoaded(pdf).fields.find(field => field.id === operation.fieldId);
    if (!field || !inspected) throw new Error('The selected form field no longer exists. Reopen the designer.');
    if (!isSupported(field) || !inspected.supported) throw new Error(inspected.unsupportedReason ?? 'This field cannot be designed safely.');
    if (operation.type === 'delete-field') { removeField(pdf, field); redraw.delete(field.ref.toString()); continue; }
    if (operation.type === 'update-field') {
      patchField(pdf, field, operation.patch, true);
      const pending = pendingValues.get(operation.fieldId) ?? {};
      if (operation.patch.value !== undefined) pending.value = operation.patch.value;
      if (operation.patch.defaultValue !== undefined) pending.defaultValue = operation.patch.defaultValue;
      pendingValues.set(operation.fieldId, pending);
      if (Object.keys(operation.patch).some(key => !['name', 'required', 'readOnly', 'defaultValue'].includes(key))) redraw.add(field.ref.toString());
      continue;
    }
    if (operation.type === 'add-widget') {
      addWidget(pdf, field, operation.widget); redraw.add(field.ref.toString()); continue;
    }
    const index = field.acroField.getWidgets().findIndex(widget => pdf.context.getObjectRef(widget.dict)?.toString() === operation.widgetId);
    const widget = field.acroField.getWidgets()[index];
    if (!widget) throw new Error('The selected widget no longer exists. Reopen the designer.');
    const ref = pdf.context.getObjectRef(widget.dict)!;
    const old = inspected.widgets[index];
    if (operation.type === 'delete-widget') {
      if (inspected.widgets.length === 1) { removeField(pdf, field); redraw.delete(field.ref.toString()); continue; }
      const previous = valueOf(field), previousDefault = defaultOf(field);
      for (const page of pdf.getPages()) page.node.removeAnnot(ref);
      field.acroField.removeWidget(index);
      if (field instanceof PDFRadioGroup) {
        field.acroField.removeExportValue(index);
        setValue(pdf, field, field.getOptions().includes(previous as string) ? previous : '');
        if (previousDefault !== undefined) setValue(pdf, field, field.getOptions().includes(previousDefault as string) ? previousDefault : '', true);
      }
      pdf.context.delete(ref); redraw.add(field.ref.toString()); continue;
    }
    if (operation.type !== 'update-widget') throw new Error('Unsupported form design operation.');
    const target = { ...old, ...operation.patch };
    const previousSize = fontSize(widget, field, geometry(pdf.getPage(old.pageNumber - 1)).unit);
    const position = nativeRect(pdf, target);
    if (target.pageNumber !== old.pageNumber) {
      pdf.getPage(old.pageNumber - 1).node.removeAnnot(ref);
      position.page.node.addAnnot(ref);
    }
    widget.setP(position.page.ref); widget.setRectangle(position.rect); setHidden(widget, target.hidden ?? false);
    if (previousSize) widget.setDefaultAppearance(appearanceWithSize(defaultAppearance(widget, field), previousSize / position.unit));
    if (operation.patch.optionValue !== undefined) {
      if (!(field instanceof PDFRadioGroup)) throw new Error('Only radio widgets have individual option values.');
      const options = field.getOptions();
      const replacement = operation.patch.optionValue;
      if (!replacement || options.some((option, item) => item !== index && option === replacement)) throw new Error('Radio option values must be nonempty and unique.');
      options[index] = replacement;
      field.acroField.setOpt(options.map(PDFHexString.fromText));
    }
    redraw.add(field.ref.toString());
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const unicode = new Map<string, string>();
  const choiceNames = new Set<string>();
  for (const field of form.getFields()) {
    if (field instanceof PDFRadioGroup && redraw.has(field.ref.toString())) normalizeRadioStates(pdf, field);
    const pending = pendingValues.get(field.ref.toString());
    if (isSupported(field) && (pending || redraw.has(field.ref.toString()))) {
      setValue(pdf, field, pending?.value ?? valueOf(field));
      const defaultValue = pending?.defaultValue ?? defaultOf(field);
      if (defaultValue !== undefined) setValue(pdf, field, defaultValue, true);
    }
    if (!redraw.has(field.ref.toString())) continue;
    if (field instanceof PDFTextField) {
      const value = field.getText() ?? '';
      field.setText(''); field.updateAppearances(font);
      field.acroField.setValue(PDFHexString.fromText(value));
      if (value) unicode.set(field.getName(), value);
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      choiceNames.add(field.getName());
    } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      const value = valueOf(field); field.updateAppearances(); setValue(pdf, field, value);
    }
    form.markFieldAsClean(field.ref);
  }
  form.acroForm.dict.set(key('NeedAppearances'), PDFBool.False);
  let saved = await pdf.save({ updateFieldAppearances: false });
  if (unicode.size) saved = await updateUnicodeFormAppearances(saved, unicode);
  if (choiceNames.size) saved = await updateUnicodeChoiceAppearances(saved, choiceNames);
  // Drop deleted widget values and appearances without renumbering surviving
  // field/widget IDs. The original pages and document catalog remain intact.
  const engine = await loadMuPDF();
  const rewritten = new engine.PDFDocument(saved);
  try {
    const output = rewritten.saveToBuffer('incremental=no,garbage=1,compress=yes');
    try {
      const result = new Uint8Array(output.asUint8Array());
      // Read back through the app's normal form path before returning a transaction.
      await extractFormFields(buffer(result));
      return result;
    } finally { output.destroy(); }
  } finally { rewritten.destroy(); }
}
