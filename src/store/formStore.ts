/**
 * Zustand store for managing PDF form state
 */

import { create } from 'zustand';
import type { FormField } from '../forms/types';

interface FormStore {
  // State
  fields: FormField[];
  originalValues: Map<string, string | boolean | string[]>;
  isFormPDF: boolean;
  isDirty: boolean;
  activeFieldId: string | null;

  // Actions
  setFields: (fields: FormField[]) => void;
  setFieldValue: (fieldId: string, value: string | boolean | string[]) => void;
  setFieldValueByName: (fieldName: string, value: string | boolean | string[]) => void;
  setActiveField: (fieldId: string | null) => void;
  resetToOriginal: () => void;
  clearForm: () => void;
  getFieldValue: (fieldId: string) => string | boolean | string[] | undefined;
  getFieldValueByName: (fieldName: string) => string | boolean | string[] | undefined;
  getFieldsOnPage: (pageNumber: number) => FormField[];
  getModifiedFields: () => Map<string, string | boolean | string[]>;
  hasUnsavedChanges: () => boolean;
}

export const useFormStore = create<FormStore>((set, get) => ({
  // Initial state
  fields: [],
  originalValues: new Map(),
  isFormPDF: false,
  isDirty: false,
  activeFieldId: null,

  // Set all fields (called when loading a PDF)
  setFields: (fields) => {
    const originalValues = new Map<string, string | boolean | string[]>();
    fields.forEach(field => {
      originalValues.set(field.id, field.value);
    });

    set({
      fields,
      originalValues,
      isFormPDF: fields.length > 0,
      isDirty: false,
      activeFieldId: null,
    });
  },

  // Update a single field value by ID
  setFieldValue: (fieldId, value) => {
    set(state => {
      const updatedFields = state.fields.map(field =>
        field.id === fieldId ? { ...field, value } : field
      );

      // Check if any field differs from original
      const isDirty = updatedFields.some(field => {
        const original = state.originalValues.get(field.id);
        return JSON.stringify(field.value) !== JSON.stringify(original);
      });

      return { fields: updatedFields, isDirty };
    });
  },

  // Update a field value by name (updates all widgets with that name)
  setFieldValueByName: (fieldName, value) => {
    set(state => {
      const updatedFields = state.fields.map(field =>
        field.name === fieldName ? { ...field, value } : field
      );

      const isDirty = updatedFields.some(field => {
        const original = state.originalValues.get(field.id);
        return JSON.stringify(field.value) !== JSON.stringify(original);
      });

      return { fields: updatedFields, isDirty };
    });
  },

  // Set the currently active/focused field
  setActiveField: (fieldId) => {
    set({ activeFieldId: fieldId });
  },

  // Reset all fields to their original values
  resetToOriginal: () => {
    set(state => {
      const resetFields = state.fields.map(field => ({
        ...field,
        value: state.originalValues.get(field.id) ?? field.defaultValue ?? '',
      }));

      return { fields: resetFields, isDirty: false };
    });
  },

  // Clear all form state
  clearForm: () => {
    set({
      fields: [],
      originalValues: new Map(),
      isFormPDF: false,
      isDirty: false,
      activeFieldId: null,
    });
  },

  // Get a field value by ID
  getFieldValue: (fieldId) => {
    const field = get().fields.find(f => f.id === fieldId);
    return field?.value;
  },

  // Get a field value by name
  getFieldValueByName: (fieldName) => {
    const field = get().fields.find(f => f.name === fieldName);
    return field?.value;
  },

  // Get all fields on a specific page
  getFieldsOnPage: (pageNumber) => {
    return get().fields.filter(f => f.pageNumber === pageNumber);
  },

  // Get a map of all modified fields (name -> value)
  getModifiedFields: () => {
    const state = get();
    const modified = new Map<string, string | boolean | string[]>();

    state.fields.forEach(field => {
      const original = state.originalValues.get(field.id);
      if (JSON.stringify(field.value) !== JSON.stringify(original)) {
        modified.set(field.name, field.value);
      }
    });

    return modified;
  },

  // Check if there are unsaved changes
  hasUnsavedChanges: () => {
    return get().isDirty;
  },
}));
