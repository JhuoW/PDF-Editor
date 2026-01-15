/**
 * Form data import/export utilities
 * Supports JSON, FDF (Forms Data Format), and XFDF (XML Forms Data Format)
 */

import type { FormField, FormData } from './types';

// ============================================================================
// JSON Format
// ============================================================================

/**
 * Export form data to JSON format
 */
export function exportToJSON(
  fields: FormField[],
  metadata?: { pdfFileName?: string }
): string {
  const data: FormData = {
    fields: {},
    metadata: {
      pdfFileName: metadata?.pdfFileName,
      exportDate: new Date().toISOString(),
      version: '1.0',
    },
  };

  // Group fields by name and collect unique values
  const fieldsByName = new Map<string, string | boolean | string[]>();
  fields.forEach(field => {
    // Only export if value is set
    if (field.value !== '' && field.value !== false) {
      fieldsByName.set(field.name, field.value);
    }
  });

  fieldsByName.forEach((value, name) => {
    data.fields[name] = value;
  });

  return JSON.stringify(data, null, 2);
}

/**
 * Import form data from JSON format
 */
export function importFromJSON(jsonString: string): Map<string, string | boolean | string[]> {
  const data: FormData = JSON.parse(jsonString);
  const fieldValues = new Map<string, string | boolean | string[]>();

  Object.entries(data.fields).forEach(([name, value]) => {
    fieldValues.set(name, value);
  });

  return fieldValues;
}

// ============================================================================
// FDF Format (Forms Data Format)
// ============================================================================

/**
 * Export form data to FDF format
 * FDF is Adobe's binary format for form data, but we export a simplified text version
 */
export function exportToFDF(
  fields: FormField[],
  metadata?: { pdfFileName?: string }
): string {
  const lines: string[] = [];

  lines.push('%FDF-1.2');
  lines.push('1 0 obj');
  lines.push('<<');
  lines.push('/FDF');
  lines.push('<<');

  // Add PDF file reference if provided
  if (metadata?.pdfFileName) {
    lines.push(`/F (${escapeFDFString(metadata.pdfFileName)})`);
  }

  // Add fields
  lines.push('/Fields [');

  // Group fields by name
  const fieldsByName = new Map<string, string | boolean | string[]>();
  fields.forEach(field => {
    if (field.value !== '' && field.value !== false) {
      fieldsByName.set(field.name, field.value);
    }
  });

  fieldsByName.forEach((value, name) => {
    lines.push('<<');
    lines.push(`/T (${escapeFDFString(name)})`);

    if (typeof value === 'boolean') {
      lines.push(`/V /${value ? 'Yes' : 'Off'}`);
    } else if (Array.isArray(value)) {
      lines.push(`/V [${value.map(v => `(${escapeFDFString(v)})`).join(' ')}]`);
    } else {
      lines.push(`/V (${escapeFDFString(String(value))})`);
    }

    lines.push('>>');
  });

  lines.push(']');
  lines.push('>>');
  lines.push('>>');
  lines.push('endobj');
  lines.push('trailer');
  lines.push('<<');
  lines.push('/Root 1 0 R');
  lines.push('>>');
  lines.push('%%EOF');

  return lines.join('\n');
}

/**
 * Import form data from FDF format
 */
export function importFromFDF(fdfString: string): Map<string, string | boolean | string[]> {
  const fieldValues = new Map<string, string | boolean | string[]>();

  // Simple FDF parser - looks for /T (name) and /V (value) pairs
  const fieldRegex = /\/T\s*\(([^)]+)\)\s*\/V\s*(?:\/(\w+)|\(([^)]*)\)|\[([^\]]*)\])/g;
  let match;

  while ((match = fieldRegex.exec(fdfString)) !== null) {
    const name = unescapeFDFString(match[1]);

    if (match[2]) {
      // Name value like /Yes or /Off
      const nameValue = match[2];
      fieldValues.set(name, nameValue === 'Yes' || nameValue === 'On');
    } else if (match[3] !== undefined) {
      // String value
      fieldValues.set(name, unescapeFDFString(match[3]));
    } else if (match[4]) {
      // Array value
      const arrayMatch = match[4].match(/\(([^)]*)\)/g);
      if (arrayMatch) {
        const values = arrayMatch.map(v => unescapeFDFString(v.slice(1, -1)));
        fieldValues.set(name, values);
      }
    }
  }

  return fieldValues;
}

function escapeFDFString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function unescapeFDFString(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

// ============================================================================
// XFDF Format (XML Forms Data Format)
// ============================================================================

/**
 * Export form data to XFDF format
 */
export function exportToXFDF(
  fields: FormField[],
  metadata?: { pdfFileName?: string }
): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">');

  // Add PDF file reference if provided
  if (metadata?.pdfFileName) {
    lines.push(`  <f href="${escapeXML(metadata.pdfFileName)}" />`);
  }

  lines.push('  <fields>');

  // Group fields by name
  const fieldsByName = new Map<string, string | boolean | string[]>();
  fields.forEach(field => {
    if (field.value !== '' && field.value !== false) {
      fieldsByName.set(field.name, field.value);
    }
  });

  fieldsByName.forEach((value, name) => {
    lines.push(`    <field name="${escapeXML(name)}">`);

    if (typeof value === 'boolean') {
      lines.push(`      <value>${value ? 'Yes' : 'Off'}</value>`);
    } else if (Array.isArray(value)) {
      value.forEach(v => {
        lines.push(`      <value>${escapeXML(v)}</value>`);
      });
    } else {
      lines.push(`      <value>${escapeXML(String(value))}</value>`);
    }

    lines.push('    </field>');
  });

  lines.push('  </fields>');
  lines.push('</xfdf>');

  return lines.join('\n');
}

/**
 * Import form data from XFDF format
 */
export function importFromXFDF(xfdfString: string): Map<string, string | boolean | string[]> {
  const fieldValues = new Map<string, string | boolean | string[]>();

  // Parse XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xfdfString, 'application/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid XFDF format');
  }

  // Find all field elements
  const fieldElements = doc.querySelectorAll('field');

  fieldElements.forEach(fieldEl => {
    const name = fieldEl.getAttribute('name');
    if (!name) return;

    const valueElements = fieldEl.querySelectorAll('value');
    if (valueElements.length === 0) return;

    if (valueElements.length === 1) {
      const value = valueElements[0].textContent || '';
      // Check for boolean values
      if (value === 'Yes' || value === 'On') {
        fieldValues.set(name, true);
      } else if (value === 'Off' || value === 'No') {
        fieldValues.set(name, false);
      } else {
        fieldValues.set(name, value);
      }
    } else {
      // Multiple values (for listbox)
      const values = Array.from(valueElements).map(el => el.textContent || '');
      fieldValues.set(name, values);
    }
  });

  return fieldValues;
}

function escapeXML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================================
// Download utilities
// ============================================================================

/**
 * Download form data as a file
 */
export function downloadFormData(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

/**
 * Read a file and return its content as a string
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
