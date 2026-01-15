import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type ZoomMode = 'fit-page' | 'fit-width' | 'manual';

interface NavigationState {
  currentPage: number;
  totalPages: number;
  zoom: number;
  zoomMode: ZoomMode;
  viewMode: 'single' | 'continuous' | 'two-page';
  rotation: number;
}

interface DocumentState {
  document: PDFDocumentProxy | null;
  documentVersion: number;  // Increments on each document load
  isLoading: boolean;
  error: string | null;
  navigation: NavigationState;

  // Actions
  setDocument: (doc: PDFDocumentProxy | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (zoom: number, mode?: ZoomMode) => void;
  setZoomMode: (mode: ZoomMode) => void;
  setViewMode: (mode: 'single' | 'continuous' | 'two-page') => void;
  setRotation: (rotation: number) => void;
}

export const useDocumentStore = create<DocumentState>((set) => ({
  document: null,
  documentVersion: 0,
  isLoading: false,
  error: null,
  navigation: {
    currentPage: 1,
    totalPages: 0,
    zoom: 1,
    zoomMode: 'fit-page',  // Default to fit-page on load
    viewMode: 'single',
    rotation: 0,
  },

  setDocument: (doc) => set((state) => ({
    document: doc,
    documentVersion: state.documentVersion + 1,  // Increment version on each load
    navigation: {
      ...state.navigation,
      totalPages: doc?.numPages ?? 0,
      currentPage: 1,
      zoomMode: 'fit-page',  // Reset to fit-page when loading new document
    },
  })),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  setCurrentPage: (page) => set((state) => ({
    navigation: { ...state.navigation, currentPage: page },
  })),

  setZoom: (zoom, mode = 'manual') => set((state) => ({
    navigation: { ...state.navigation, zoom, zoomMode: mode },
  })),

  setZoomMode: (mode) => set((state) => ({
    navigation: { ...state.navigation, zoomMode: mode },
  })),

  setViewMode: (mode) => set((state) => ({
    navigation: { ...state.navigation, viewMode: mode },
  })),

  setRotation: (rotation) => set((state) => ({
    navigation: { ...state.navigation, rotation },
  })),
}));
