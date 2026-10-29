/**
 * Extract form fields from a PDF document using pdf-lib
 */

import {
  AnnotationFlags, PDFDocument, PDFDict, PDFTextField, PDFCheckBox, PDFDropdown,
  PDFOptionList, PDFRadioGroup, PDFButton, PDFSignature, PDFHexString, PDFName, PDFNumber, StandardFonts,
} from 'pdf-lib';
import type { FormField, FormFieldType, FormFieldRect, FormFieldOption } from './types';
import { updateUnicodeFormAppearances } from './UnicodeFormAppearance';
import { updateUnicodeChoiceAppearances } from './UnicodeChoiceAppearance';

function getChoiceOptions(field: PDFDropdown | PDFOptionList): FormFieldOption[] {
  return field.acroField.getOptions().map(({ value, display }) => ({
    value: value.decodeText(),
    label: (display ?? value).decodeText(),
  }));
}

function getChoiceValues(field: PDFDropdown | PDFOptionList, options: FormFieldOption[]): string[] {
  // Some producers (including pdf-lib's public select API) store display labels
  // in /V. Normalize those to export values without changing valid export values.
  return field.getSelected().map(selected => options.find(option => option.value === selected)?.value
    ?? options.find(option => option.label === selected)?.value ?? selected);
}

/**
 * Extract all form fields from a PDF document
 */
export async function extractFormFields(pdfData: ArrayBuffer): Promise<FormField[]> {
  const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields: FormField[] = [];
  const pages = pdfDoc.getPages();
  const pageNumbers = new Map(pages.map((page, index) => [page.ref.toString(), index + 1]));
  const widgetPages = new Map<PDFDict, number>();
  const objectRefs = new Map(pdfDoc.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref]));

  // /P is optional on a widget. The page's /Annots array also establishes ownership.
  for (const [index, page] of pages.entries()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let i = 0; i < annotations.size(); i++) {
      const annotation = annotations.lookup(i);
      if (annotation instanceof PDFDict) widgetPages.set(annotation, index + 1);
    }
  }

  const pdfFields = form.getFields();

  for (const field of pdfFields) {
    const fieldName = field.getName();
    const widgets = field.acroField.getWidgets();

    // Process each widget (a field can appear on multiple pages)
    for (let widgetIndex = 0; widgetIndex < widgets.length; widgetIndex++) {
      const widget = widgets[widgetIndex];
      const pageRef = widget.P();

      const pageNumber = widgetPages.get(widget.dict)
        ?? (pageRef ? pageNumbers.get(pageRef.toString()) : undefined);
      // An orphaned widget has no location and must not appear on page one.
      if (pageNumber === undefined) continue;

      // Get widget rectangle
      const rect = widget.getRectangle();
      const page = pdfDoc.getPage(pageNumber - 1);
      const media = page.getMediaBox();
      const crop = page.getCropBox();
      const left = Math.max(media.x, crop.x);
      const bottom = Math.max(media.y, crop.y);
      const right = Math.min(media.x + media.width, crop.x + crop.width);
      const top = Math.min(media.y + media.height, crop.y + crop.height);
      // PDF.js uses the intersection of MediaBox and CropBox, falling back to
      // MediaBox for an empty intersection. Rotation is applied by FormLayer.
      const visible = right > left && top > bottom
        ? { x: left, top } : { x: media.x, top: media.y + media.height };
      const rawUnit = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber)?.asNumber();
      const unit = rawUnit !== undefined && Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : 1;

      // Match PDF.js's scale-1, rotation-0 viewport, including /UserUnit.
      const fieldRect: FormFieldRect = {
        x: (rect.x - visible.x) * unit,
        y: (visible.top - rect.y - rect.height) * unit,
        width: rect.width * unit,
        height: rect.height * unit,
      };

      // Determine field type and extract value
      let fieldType: FormFieldType = 'text';
      let value: string | boolean | string[] = '';
      let options: FormFieldOption[] | undefined;
      let exportValue: string | undefined;
      let radioGroup: string | undefined;
      let multiline = false;
      let maxLength: number | undefined;

      if (field instanceof PDFTextField) {
        fieldType = 'text';
        value = field.getText() || '';
        multiline = field.isMultiline();
        maxLength = field.getMaxLength();
      } else if (field instanceof PDFCheckBox) {
        fieldType = 'checkbox';
        value = field.isChecked();
        // Get the export value from the appearance (use string conversion)
        const onValue = field.acroField.getOnValue();
        exportValue = onValue?.decodeText() ?? 'Yes';
      } else if (field instanceof PDFDropdown) {
        fieldType = 'dropdown';
        options = getChoiceOptions(field);
        const selected = getChoiceValues(field, options);
        value = field.isMultiselect() || selected.length > 1 ? selected : selected[0] ?? '';
      } else if (field instanceof PDFOptionList) {
        fieldType = 'listbox';
        options = getChoiceOptions(field);
        value = getChoiceValues(field, options);
      } else if (field instanceof PDFRadioGroup) {
        fieldType = 'radio';
        value = field.getSelected() || '';
        radioGroup = fieldName;
        options = field.getOptions().map(opt => ({ label: opt, value: opt }));
        exportValue = field.acroField.getExportValues()?.[widgetIndex]?.decodeText()
          ?? widget.getOnValue()?.decodeText();
      } else if (field instanceof PDFButton) {
        fieldType = 'button';
        value = '';
      } else if (field instanceof PDFSignature) {
        fieldType = 'signature';
        value = '';
      } else {
        throw new Error(`Unsupported form field type: "${fieldName}"`);
      }

      // Check field flags
      const acroField = field.acroField;
      const flags = acroField.getFlags();
      const isReadOnly = (flags & 1) !== 0 || fieldType === 'signature' || fieldType === 'button';
      const isRequired = (flags & 2) !== 0; // Bit 2: Required
      const isHidden = widget.hasFlag(AnnotationFlags.Hidden)
        || widget.hasFlag(AnnotationFlags.Invisible) || widget.hasFlag(AnnotationFlags.NoView);
      const widgetRef = objectRefs.get(widget.dict);
      // Object references survive page reordering and deletion of sibling widgets.
      const widgetId = widgetRef?.toString()
        ?? `${page.ref}:${rect.x}:${rect.y}:${rect.width}:${rect.height}:${widgetIndex}`;
      const appearance = widget.getDefaultAppearance() ?? acroField.getDefaultAppearance() ?? '';
      const fontCommands = [...appearance.matchAll(/\/[^\s]+\s+([\d.]+)\s+Tf\b/g)];
      const fontSize = Number(fontCommands.at(-1)?.[1]);

      const formField: FormField = {
        id: `${fieldName}@${widgetId}`,
        name: fieldName,
        type: fieldType,
        value,
        defaultValue: value,
        rect: fieldRect,
        pageNumber,
        required: isRequired,
        readOnly: isReadOnly,
        hidden: isHidden,
        options,
        multiSelect: field instanceof PDFDropdown || field instanceof PDFOptionList ? field.isMultiselect() : undefined,
        allowCustomValue: field instanceof PDFDropdown ? field.isEditable() : undefined,
        exportValue,
        appearanceValue: fieldType === 'checkbox' || fieldType === 'radio' ? widget.getOnValue()?.decodeText() : undefined,
        radioGroup,
        multiline,
        maxLength,
        fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize * unit : undefined,
        textAlign: field instanceof PDFTextField ? (['left', 'center', 'right'] as const)[field.getAlignment()] : undefined,
      };

      fields.push(formField);
    }
  }
  return fields;
}

/**
 * Check if a PDF has form fields
 */
export async function hasFormFields(pdfData: ArrayBuffer): Promise<boolean> {
  try {
    const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    return fields.length > 0;
  } catch {
    return false;
  }
}

/**
 * Update form field values in a PDF
 */
export async function updateFormFieldValues(
  pdfData: ArrayBuffer,
  fieldValues: Map<string, string | boolean | string[]>
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true, updateMetadata: false });
  if (pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))) {
    throw new Error('XFA forms are not supported for filling or export. The original form data was preserved.');
  }
  const form = pdfDoc.getForm();
  const errors: string[] = [];
  const appearanceFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const unicodeValues = new Map<string, string>();
  const choiceValues: Array<{
    field: PDFDropdown | PDFOptionList;
    values: string[];
    indices: number[];
  }> = [];

  for (const [fieldName, value] of fieldValues) {
    try {
      const field = form.getField(fieldName);
      if (field instanceof PDFButton || field instanceof PDFSignature || field.isReadOnly()) continue;

      if (field instanceof PDFTextField) {
        if (typeof value !== 'string') throw new Error('Expected a text value');
        field.setText(value);
        try {
          appearanceFont.encodeText(value.replace(/[\r\n\t]/g, ''));
        } catch {
          // Generate only the original field's background/border with pdf-lib.
          // Unicode text is drawn with embedded fonts after saving these widgets.
          unicodeValues.set(fieldName, value);
          field.setText('');
        }
      } else if (field instanceof PDFCheckBox) {
        const exportValue = field.acroField.getOnValue()?.decodeText() ?? 'Yes';
        if (value === true || value === 'true' || value === exportValue || value === 'Yes') {
          field.check();
        } else if (value === false || value === 'false' || value === 'Off' || value === '') {
          field.uncheck();
        } else {
          throw new Error('Expected a checkbox boolean or its export value');
        }
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (typeof value !== 'string' && !Array.isArray(value)) {
          throw new Error('Expected an option value or a list of option values');
        }
        const selected = typeof value === 'string' ? (value === '' ? [] : [value]) : value;
        if (!selected.every(option => typeof option === 'string')) {
          throw new Error('Every selected option must be text');
        }
        if (selected.length > 1 && !field.isMultiselect()) {
          throw new Error('This field accepts only one option');
        }
        if (selected.length === 0) {
          field.clear();
        } else {
          const allowsCustomValues = field instanceof PDFDropdown && field.isEditable();
          const options = getChoiceOptions(field);
          const choices = selected.map(value => options.find(option => option.value === value)
            ?? options.find(option => option.label === value));
          const invalid = selected.filter((_, index) => !choices[index]);
          if (!allowsCustomValues && invalid.length > 0) {
            throw new Error(`Unknown option(s): ${invalid.join(', ')}`);
          }
          // pdf-lib renders and validates choice labels; retain the distinct
          // export values to write after it has generated the appearances.
          field.select(choices.map((option, index) => option?.label ?? selected[index]));
          choiceValues.push({
            field,
            values: choices.map((option, index) => option?.value ?? selected[index]),
            indices: choices.map(option => option ? options.indexOf(option) : -1),
          });
        }
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value !== 'string') throw new Error('Expected one radio option');
        if (value) {
          field.select(value);
        } else {
          field.clear();
        }
      } else {
        throw new Error('Unsupported field type');
      }
    } catch (error) {
      errors.push(`"${fieldName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) throw new Error(`Failed to update form fields:\n${errors.join('\n')}`);
  const unicodeChoices = new Set<string>();
  for (const field of form.getFields()) {
    if (!field.needsAppearancesUpdate()) continue;
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      try {
        for (const text of [...getChoiceOptions(field).map(option => option.label), ...field.getSelected()]) {
          appearanceFont.encodeText(text);
        }
      } catch {
        unicodeChoices.add(field.getName());
        // A clean flag alone does not skip widgets with missing appearances.
        // The Unicode renderer rebuilds these after native values are restored.
        continue;
      }
    }
    field.defaultUpdateAppearances(appearanceFont);
  }
  for (const [name, value] of unicodeValues) {
    const field = form.getTextField(name);
    field.acroField.setValue(PDFHexString.fromText(value));
    form.markFieldAsClean(field.ref);
  }
  for (const { field, values, indices } of choiceValues) {
    const encodedValues = values.map(value => PDFHexString.fromText(value));
    field.acroField.dict.set(PDFName.of('V'), encodedValues.length === 1
      ? encodedValues[0] : pdfDoc.context.obj(encodedValues));
    if (values.length > 1 && indices.every(index => index >= 0)) {
      field.acroField.dict.set(PDFName.of('I'), pdfDoc.context.obj(indices.sort((a, b) => a - b)));
    } else {
      field.acroField.dict.delete(PDFName.of('I'));
    }
  }
  let saved = await pdfDoc.save({ updateFieldAppearances: false });
  if (unicodeValues.size) saved = await updateUnicodeFormAppearances(saved, unicodeValues);
  if (unicodeChoices.size) saved = await updateUnicodeChoiceAppearances(saved, unicodeChoices);
  return saved;
}

/**
 * Get field by name from a list of fields
 */
export function getFieldByName(fields: FormField[], name: string): FormField | undefined {
  return fields.find(f => f.name === name);
}

/**
 * Get all fields on a specific page
 */
export function getFieldsOnPage(fields: FormField[], pageNumber: number): FormField[] {
  return fields.filter(f => f.pageNumber === pageNumber);
}

/**
 * Group radio buttons by their group name
 */
export function groupRadioButtons(fields: FormField[]): Map<string, FormField[]> {
  const groups = new Map<string, FormField[]>();

  fields
    .filter(f => f.type === 'radio' && f.radioGroup)
    .forEach(field => {
      const groupName = field.radioGroup!;
      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName)!.push(field);
    });

  return groups;
}
