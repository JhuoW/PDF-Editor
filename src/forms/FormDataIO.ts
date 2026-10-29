/** Form data exchange with Unicode and explicit empty values. */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFParser, PDFString } from 'pdf-lib';
import type { FormField, FormData } from './types';

type FieldValue = FormField['value'];
type FileMetadata = { pdfFileName?: string };
const dataFields = (fields: FormField[]) => fields.filter(field => field.type !== 'button' && field.type !== 'signature');
const uniqueFields = (fields: FormField[]) => new Map(dataFields(fields).map(field => [field.name, field]));

export function exportToJSON(fields: FormField[], metadata?: FileMetadata): string {
  const data: FormData = {
    fields: Object.fromEntries([...uniqueFields(fields)].map(([name, field]) => [name, field.value])),
    metadata: { pdfFileName: metadata?.pdfFileName, exportDate: new Date().toISOString(), version: '1.0' },
  };
  return JSON.stringify(data, null, 2);
}

export function importFromJSON(source: string): Map<string, FieldValue> {
  const data: unknown = JSON.parse(source);
  if (!data || typeof data !== 'object' || !('fields' in data) || !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields)) {
    throw new Error('Form JSON must contain a fields object.');
  }
  const values = new Map<string, FieldValue>();
  for (const [name, value] of Object.entries(data.fields)) {
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) {
      throw new Error(`Invalid value for form field "${name}".`);
    }
    values.set(name, value);
  }
  return values;
}

/** Button /V values use widget appearance names, which may differ from labels. */
function exchangeValue(field: FormField, fields: FormField[]): FieldValue {
  if (field.type === 'checkbox') return field.value ? field.appearanceValue ?? field.exportValue ?? 'Yes' : 'Off';
  if (field.type === 'radio') {
    if (!field.value) return 'Off';
    return fields.find(widget => widget.name === field.name && widget.exportValue === field.value)?.appearanceValue ?? field.value;
  }
  return field.value;
}
const pdfString = (text: string) => PDFHexString.fromText(text).toString();

export function exportToFDF(fields: FormField[], metadata?: FileMetadata): string {
  const entries = [...uniqueFields(fields)].map(([name, field]) => {
    const value = exchangeValue(field, fields);
    const encoded = field.type === 'checkbox' || field.type === 'radio'
      ? PDFName.of(String(value)).toString()
      : Array.isArray(value) ? `[${value.map(pdfString).join(' ')}]` : pdfString(String(value));
    return `<< /T ${pdfString(name)} /V ${encoded} >>`;
  });
  return ['%FDF-1.2', '1 0 obj', '<< /FDF <<', metadata?.pdfFileName ? `/F ${pdfString(metadata.pdfFileName)}` : '',
    `/Fields [\n${entries.join('\n')}\n]`, '>> >>', 'endobj', 'trailer', '<< /Root 1 0 R >>', '%%EOF'].join('\n');
}

export async function importFromFDF(source: string | ArrayBuffer): Promise<Map<string, FieldValue>> {
  const bytes = typeof source === 'string' ? Uint8Array.from(source, char => char.charCodeAt(0)) : new Uint8Array(source.slice(0));
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%FDF-') throw new Error('Invalid FDF header.');
  // FDF uses PDF objects and string encodings. The header replacement has the
  // same length, so existing cross-reference offsets remain valid.
  bytes[1] = 'P'.charCodeAt(0);
  const context = await PDFParser.forBytesWithOptions(bytes, 100, true).parseDocument();
  const root = context.lookup(context.trailerInfo.Root, PDFDict);
  const fdf = root.lookup(PDFName.of('FDF'), PDFDict);
  const entries = fdf.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const result = new Map<string, FieldValue>();
  const visited = new Set<PDFDict>();
  const stringValue = (value: unknown): string => {
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
    if (value instanceof PDFName) return value.decodeText();
    throw new Error('FDF field values must be strings or button names.');
  };
  const visit = (fields: PDFArray, prefix: string, depth = 0) => {
    if (depth > 64) throw new Error('FDF field hierarchy is too deep.');
    for (let index = 0; index < fields.size(); index++) {
      const field = fields.lookup(index, PDFDict);
      if (visited.has(field)) throw new Error('FDF fields contain a circular or repeated reference.');
      visited.add(field);
      const nameObject = field.lookup(PDFName.of('T'));
      const name = nameObject === undefined ? '' : stringValue(nameObject);
      const fullName = [prefix, name].filter(Boolean).join('.');
      const value = field.lookup(PDFName.of('V'));
      if (value !== undefined) {
        if (!fullName) throw new Error('An FDF value has no field name.');
        result.set(fullName, value instanceof PDFArray
          ? Array.from({ length: value.size() }, (_, item) => stringValue(value.lookup(item))) : stringValue(value));
      }
      const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
      if (kids) visit(kids, fullName, depth + 1);
    }
  };
  if (entries) visit(entries, '');
  return result;
}

function escapeXML(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function exportToXFDF(fields: FormField[], metadata?: FileMetadata): string {
  const entries = [...uniqueFields(fields)].map(([name, field]) => {
    const value = exchangeValue(field, fields);
    const values = Array.isArray(value) ? value : [String(value)];
    return `    <field name="${escapeXML(name)}">${values.map(item => `<value>${escapeXML(item)}</value>`).join('')}</field>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
    metadata?.pdfFileName ? `  <f href="${escapeXML(metadata.pdfFileName)}" />` : '', '  <fields>', ...entries, '  </fields>', '</xfdf>'].join('\n');
}

export function importFromXFDF(source: string): Map<string, FieldValue> {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'xfdf') throw new Error('Invalid XFDF format.');
  const result = new Map<string, FieldValue>();
  const children = (element: Element, name: string) => [...element.children].filter(child => child.localName === name);
  const visit = (element: Element, prefix: string, depth = 0) => {
    if (depth > 64) throw new Error('XFDF field hierarchy is too deep.');
    for (const field of children(element, 'field')) {
      const name = field.getAttribute('name');
      if (!name) throw new Error('An XFDF field has no name.');
      const fullName = prefix ? `${prefix}.${name}` : name;
      const values = children(field, 'value').map(item => item.textContent ?? '');
      const nested = children(field, 'field');
      if (values.length || !nested.length) result.set(fullName, values.length === 1 ? values[0] : values);
      visit(field, fullName, depth + 1);
    }
  };
  for (const fields of children(document.documentElement, 'fields')) visit(fields, '');
  return result;
}

/** Validate all values before changing the workspace; text such as "Off" stays text. */
export function normalizeImportedFormValues(fields: FormField[], input: Map<string, FieldValue>, nativeButtons = true): Map<string, FieldValue> {
  const result = new Map<string, FieldValue>();
  for (const [name, field] of uniqueFields(fields)) {
    if (field.readOnly || !input.has(name)) continue;
    let value = input.get(name)!;
    if (field.type === 'checkbox') {
      if (typeof value !== 'boolean') {
        if (!nativeButtons) throw new Error(`Expected a checkbox boolean for "${name}".`);
        if (value === 'Off' || value === '') value = false;
        else if (value === (field.appearanceValue ?? field.exportValue ?? 'Yes')) value = true;
        else throw new Error(`Invalid checkbox value for "${name}".`);
      }
    } else if (field.type === 'radio') {
      if (typeof value !== 'string') throw new Error(`Expected a radio option for "${name}".`);
      if (nativeButtons) value = value === 'Off' ? '' : fields.find(widget => widget.name === name && widget.appearanceValue === value)?.exportValue ?? value;
      if (value !== '' && !fields.some(widget => widget.name === name && widget.exportValue === value)) {
        throw new Error(`Unknown radio option for "${name}".`);
      }
    } else if (field.type === 'text') {
      if (typeof value !== 'string') throw new Error(`Expected text for "${name}".`);
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`Field "${name}" accepts at most ${field.maxLength} characters.`);
      }
    } else {
      if (typeof value !== 'string' && !Array.isArray(value)) throw new Error(`Expected option values for "${name}".`);
      const multiple = field.multiSelect ?? (field.type === 'listbox' || Array.isArray(field.value));
      if (!multiple && Array.isArray(value) && value.length > 1) {
        throw new Error(`Field "${name}" accepts only one option.`);
      }
      if (field.type === 'listbox' || multiple) {
        if (!Array.isArray(value)) value = value === '' ? [] : [value];
      } else if (Array.isArray(value)) {
        if (value.length > 1) throw new Error(`Field "${name}" accepts only one option.`);
        value = value[0] ?? '';
      }
      if (field.options && !field.allowCustomValue) {
        const selected = Array.isArray(value) ? value : value === '' ? [] : [value];
        const options = selected.map(option => field.options!.find(item => item.value === option || item.label === option));
        if (options.some(option => !option)) throw new Error(`Unknown option for "${name}".`);
        value = Array.isArray(value) ? options.map(option => option!.value) : options[0]?.value ?? '';
      }
    }
    result.set(name, value);
  }
  return result;
}

export function downloadFormData(content: string, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
