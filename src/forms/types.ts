/**
 * Form field types and interfaces for AcroForms handling
 */

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'listbox'
  | 'signature'
  | 'button';

export interface FormFieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormField {
  id: string;
  name: string;
  type: FormFieldType;
  value: string | boolean | string[];
  defaultValue?: string | boolean | string[];
  rect: FormFieldRect;
  pageNumber: number;
  required: boolean;
  readOnly: boolean;
  hidden: boolean;
  // For dropdown/listbox
  options?: FormFieldOption[];
  // For radio buttons - group name
  radioGroup?: string;
  // For text fields
  multiline?: boolean;
  maxLength?: number;
  // For checkboxes
  exportValue?: string;
  // Appearance
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  textAlign?: 'left' | 'center' | 'right';
}

export interface FormFieldOption {
  label: string;
  value: string;
}

export interface FormData {
  fields: Record<string, string | boolean | string[]>;
  metadata?: {
    pdfFileName?: string;
    exportDate?: string;
    version?: string;
  };
}

// FDF (Forms Data Format) structure
export interface FDFData {
  FDF: {
    Fields: FDFField[];
    F?: string; // PDF file reference
  };
}

export interface FDFField {
  T: string; // Field name
  V: string | boolean | string[]; // Field value
  Kids?: FDFField[]; // Child fields (for radio groups)
}

// XFDF (XML Forms Data Format) structure
export interface XFDFData {
  xfdf: {
    f?: { href: string }; // PDF file reference
    fields: {
      field: XFDFField[];
    };
  };
}

export interface XFDFField {
  name: string;
  value: string | string[];
}

// Form state for the store
export interface FormState {
  fields: Map<string, FormField>;
  originalValues: Map<string, string | boolean | string[]>;
  isDirty: boolean;
  isFormPDF: boolean;
}
