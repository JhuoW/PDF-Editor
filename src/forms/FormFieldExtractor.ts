/**
 * Extract form fields from a PDF document using pdf-lib
 */

import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFButton, PDFSignature } from 'pdf-lib';
import type { FormField, FormFieldType, FormFieldRect, FormFieldOption } from './types';

/**
 * Extract all form fields from a PDF document
 */
export async function extractFormFields(pdfData: ArrayBuffer): Promise<FormField[]> {
  const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields: FormField[] = [];

  try {
    const pdfFields = form.getFields();

    for (const field of pdfFields) {
      const fieldName = field.getName();
      const widgets = field.acroField.getWidgets();

      // Process each widget (a field can appear on multiple pages)
      for (let widgetIndex = 0; widgetIndex < widgets.length; widgetIndex++) {
        const widget = widgets[widgetIndex];
        const pageRef = widget.P();

        // Find which page this widget is on
        let pageNumber = 1;
        if (pageRef) {
          const pages = pdfDoc.getPages();
          for (let i = 0; i < pages.length; i++) {
            if (pages[i].ref === pageRef) {
              pageNumber = i + 1;
              break;
            }
          }
        }

        // Get widget rectangle
        const rect = widget.getRectangle();
        const page = pdfDoc.getPage(pageNumber - 1);
        const pageHeight = page.getHeight();

        // Convert PDF coordinates (bottom-left origin) to screen coordinates (top-left origin)
        const fieldRect: FormFieldRect = {
          x: rect.x,
          y: pageHeight - rect.y - rect.height,
          width: rect.width,
          height: rect.height,
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
          exportValue = onValue ? String(onValue).replace(/^\//, '') : 'Yes';
        } else if (field instanceof PDFDropdown) {
          fieldType = 'dropdown';
          const selected = field.getSelected();
          value = selected.length > 0 ? selected[0] : '';
          options = field.getOptions().map(opt => ({ label: opt, value: opt }));
        } else if (field instanceof PDFRadioGroup) {
          fieldType = 'radio';
          value = field.getSelected() || '';
          radioGroup = fieldName;
          options = field.getOptions().map(opt => ({ label: opt, value: opt }));
        } else if (field instanceof PDFButton) {
          fieldType = 'button';
          value = '';
        } else if (field instanceof PDFSignature) {
          fieldType = 'signature';
          value = '';
        }

        // Check field flags
        const acroField = field.acroField;
        const flags = acroField.getFlags();
        const isReadOnly = (flags & 1) !== 0; // Bit 1: ReadOnly
        const isRequired = (flags & 2) !== 0; // Bit 2: Required
        const isHidden = widget.hasFlag(1); // Hidden flag on widget

        const formField: FormField = {
          id: `${fieldName}-${widgetIndex}`,
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
          exportValue,
          radioGroup,
          multiline,
          maxLength,
        };

        fields.push(formField);
      }
    }
  } catch (error) {
    console.error('Error extracting form fields:', error);
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
  const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const form = pdfDoc.getForm();

  for (const [fieldName, value] of fieldValues) {
    try {
      const field = form.getField(fieldName);

      if (field instanceof PDFTextField) {
        field.setText(String(value));
      } else if (field instanceof PDFCheckBox) {
        if (value === true || value === 'true' || value === 'Yes') {
          field.check();
        } else {
          field.uncheck();
        }
      } else if (field instanceof PDFDropdown) {
        if (typeof value === 'string') {
          field.select(value);
        } else if (Array.isArray(value) && value.length > 0) {
          field.select(value[0]);
        }
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value) {
          field.select(value);
        }
      }
    } catch (error) {
      console.warn(`Failed to update field "${fieldName}":`, error);
    }
  }

  return pdfDoc.save();
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
