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
  loadRequestId: number; // Changes as soon as another open/close is requested.
  isLoading: boolean;
  error: string | null;
  navigation: NavigationState;

  // Actions
  setDocument: (doc: PDFDocumentProxy | null, preserveNavigation?: boolean) => void;
  beginLoadRequest: () => number;
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
  loadRequestId: 0,
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

  setDocument: (doc, preserveNavigation = false) => set((state) => ({
    document: doc,
    documentVersion: state.documentVersion + 1,  // Increment version on each load
    navigation: {
      ...state.navigation,
      totalPages: doc?.numPages ?? 0,
      currentPage: preserveNavigation ? Math.min(state.navigation.currentPage, doc?.numPages || 1) : 1,
      zoomMode: preserveNavigation ? state.navigation.zoomMode : 'fit-page',
      rotation: preserveNavigation ? state.navigation.rotation : 0,
    },
  })),

  beginLoadRequest: () => {
    let requestId = 0;
    set(state => {
      requestId = state.loadRequestId + 1;
      return { loadRequestId: requestId };
    });
    return requestId;
  },

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
