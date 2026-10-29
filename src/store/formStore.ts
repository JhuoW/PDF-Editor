/**
 * Zustand store for managing PDF form state
 */

import { create } from 'zustand';
import type { FormField } from '../forms/types';
import { useHistoryStore } from './historyStore';

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
  setFieldValues: (values: Map<string, FormField['value']>, actionName?: string) => void;
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

  // Widgets with the same field name are one logical value.
  setFieldValue: (fieldId, value) => {
    const field = get().fields.find(item => item.id === fieldId);
    if (field) get().setFieldValueByName(field.name, value);
  },

  setFieldValueByName: (fieldName, value) => {
    get().setFieldValues(new Map([[fieldName, value]]));
  },

  setFieldValues: (values, actionName) => {
    const state = get();
    const fields = state.fields.map(field => {
      if (field.readOnly || !values.has(field.name)) return field;
      const value = values.get(field.name)!;
      return JSON.stringify(value) === JSON.stringify(field.value) ? field : { ...field, value: structuredClone(value) };
    });
    if (fields.every((field, index) => field === state.fields[index])) return;
    const active = state.fields.find(field => field.id === state.activeFieldId);
    const group = !actionName && values.size === 1 && active && values.has(active.name)
      && (active.type === 'text' || active.allowCustomValue) ? `form:${active.id}` : undefined;
    useHistoryStore.getState().pushWorkspaceState({ form: { fields: state.fields, originalValues: state.originalValues, isDirty: state.isDirty } },
      actionName ?? `Fill ${values.keys().next().value}`, group);
    set({ fields, isDirty: fields.some(field => JSON.stringify(field.value) !== JSON.stringify(state.originalValues.get(field.id))) });
  },

  setActiveField: activeFieldId => {
    if (get().activeFieldId !== activeFieldId) useHistoryStore.getState().endGroup();
    set({ activeFieldId });
  },

  resetToOriginal: () => {
    const state = get();
    const fields = state.fields.map(field => ({ ...field, value: structuredClone(state.originalValues.get(field.id) ?? field.defaultValue ?? '') }));
    if (fields.every((field, index) => JSON.stringify(field.value) === JSON.stringify(state.fields[index].value))) return;
    useHistoryStore.getState().pushWorkspaceState({ form: { fields: state.fields, originalValues: state.originalValues, isDirty: state.isDirty } }, 'Reset form');
    set({ fields, isDirty: false });
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
