/**
 * Form flattening utility
 * Converts interactive form fields to static content (non-editable)
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Flatten all form fields in a PDF document
 * This converts interactive form fields into static content
 */
export async function flattenForm(pdfData: ArrayBuffer): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const form = pdfDoc.getForm();

  try {
    // Flatten all fields - this renders the field values as static content
    // and removes the interactive form structure
    form.flatten();
  } catch (error) {
    console.error('Error flattening form:', error);
    // If flatten fails, try manual flattening
    await manualFlatten(pdfDoc);
  }

  return pdfDoc.save();
}

/**
 * Manual flattening fallback - draws field values directly on pages
 * This is used when the automatic flatten fails
 */
async function manualFlatten(pdfDoc: PDFDocument): Promise<void> {
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const field of fields) {
    try {
      const widgets = field.acroField.getWidgets();

      for (const widget of widgets) {
        const rect = widget.getRectangle();
        const pageRef = widget.P();

        // Find the page
        let page = pdfDoc.getPages()[0];
        if (pageRef) {
          const pages = pdfDoc.getPages();
          for (const p of pages) {
            if (p.ref === pageRef) {
              page = p;
              break;
            }
          }
        }

        // Get field value as string
        let textValue = '';
        const fieldName = field.getName();

        try {
          // Try to get text value based on field type
           
          if ('getText' in field) {
            textValue = (field as { getText: () => string | undefined }).getText() || '';
          } else if ('isChecked' in field) {
            textValue = (field as { isChecked: () => boolean }).isChecked() ? '✓' : '';
          } else if ('getSelected' in field) {
            const selected = (field as { getSelected: () => string[] | string }).getSelected();
            textValue = Array.isArray(selected) ? selected.join(', ') : (selected || '');
          }
        } catch {
          console.warn(`Could not get value for field: ${fieldName}`);
        }

        if (textValue) {
          // Draw the text value on the page
          const fontSize = Math.min(rect.height * 0.7, 12);

          page.drawText(textValue, {
            x: rect.x + 2,
            y: rect.y + (rect.height - fontSize) / 2,
            size: fontSize,
            font: helvetica,
            color: rgb(0, 0, 0),
          });
        }

        // Draw checkbox/radio visual if checked
        if ('isChecked' in field && (field as { isChecked: () => boolean }).isChecked()) {
          const centerX = rect.x + rect.width / 2;
          const centerY = rect.y + rect.height / 2;
          const size = Math.min(rect.width, rect.height) * 0.6;

          page.drawText('✓', {
            x: centerX - size / 2,
            y: centerY - size / 2,
            size: size,
            font: helvetica,
            color: rgb(0, 0, 0),
          });
        }
      }

      // Remove the field from the form
      form.removeField(field);
    } catch (error) {
      console.warn(`Error processing field ${field.getName()}:`, error);
    }
  }
}

/**
 * Check if a PDF has been flattened (no interactive form fields)
 */
export async function isFlattened(pdfData: ArrayBuffer): Promise<boolean> {
  try {
    const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    return fields.length === 0;
  } catch {
    return true; // If we can't read the form, assume it's flattened
  }
}

/**
 * Get count of form fields in a PDF
 */
export async function getFormFieldCount(pdfData: ArrayBuffer): Promise<number> {
  try {
    const pdfDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    return form.getFields().length;
  } catch {
    return 0;
  }
}
