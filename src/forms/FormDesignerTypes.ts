import type { FormFieldOption, FormFieldRect, FormFieldType } from './types';

export type DesignableFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox';
export type FormDesignValue = string | boolean | string[];
export interface NewFormDesignWidget {
  pageNumber: number;
  /** PDF.js scale=1, rotation=0 CropBox-relative coordinates, including UserUnit. */
  rect: FormFieldRect;
  hidden?: boolean;
  /** Radio export option. Each radio widget must have a distinct nonempty value. */
  optionValue?: string;
}
export interface FormDesignWidget extends NewFormDesignWidget { id: string; hidden: boolean }
export interface FormDesignFieldPatch {
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  value?: FormDesignValue;
  defaultValue?: FormDesignValue;
  /** Choice fields only. Labels and export values remain distinct. */
  options?: FormFieldOption[];
  multiSelect?: boolean;
  allowCustomValue?: boolean;
  /** Points in PDF.js scale=1 coordinates. Applied to each widget's UserUnit. */
  fontSize?: number;
  textAlign?: 'left' | 'center' | 'right';
  multiline?: boolean;
  maxLength?: number | null;
}
export interface NewFormDesignField extends FormDesignFieldPatch {
  name: string;
  type: DesignableFieldType;
  widgets: NewFormDesignWidget[];
}
export interface FormDesignField extends Omit<FormDesignFieldPatch, 'name' | 'value' | 'defaultValue'> {
  /** Stable native logical-field object reference, independent of its name. */
  id: string;
  name: string;
  type: FormFieldType;
  widgets: FormDesignWidget[];
  value: FormDesignValue;
  defaultValue?: FormDesignValue;
  required: boolean;
  readOnly: boolean;
  supported: boolean;
  unsupportedReason?: string;
}
export interface FormDesignDocument {
  pages: Array<{ pageNumber: number; width: number; height: number }>;
  fields: FormDesignField[];
  canEdit: boolean;
  unsupportedReason?: string;
}
export type FormDesignOperation =
  | { type: 'create-field'; field: NewFormDesignField }
  | { type: 'update-field'; fieldId: string; patch: FormDesignFieldPatch }
  | { type: 'delete-field'; fieldId: string }
  | { type: 'add-widget'; fieldId: string; widget: NewFormDesignWidget }
  | { type: 'update-widget'; fieldId: string; widgetId: string; patch: Partial<NewFormDesignWidget> }
  | { type: 'delete-widget'; fieldId: string; widgetId: string };
