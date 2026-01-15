import { useCallback, useEffect, useRef } from 'react';
import { pdfjsLib } from '../utils/pdfConfig';
import { useDocumentStore } from '../store/documentStore';
import { saveCurrentPDF, loadCurrentPDF } from '../utils/pdfStorage';

export function usePDFDocument() {
  const {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    setDocument,
    setLoading,
    setError,
    setCurrentPage,
    setZoom,
    setZoomMode,
    setViewMode,
    setRotation,
  } = useDocumentStore();

  const hasTriedStorageLoad = useRef(false);

  const loadDocument = useCallback(async (
    source: string | ArrayBuffer | Uint8Array
  ) => {
    setLoading(true);
    setError(null);

    try {
      const loadingTask = pdfjsLib.getDocument(source);
      const doc = await loadingTask.promise;
      setDocument(doc);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load PDF';
      setError(message);
      setDocument(null);
    } finally {
      setLoading(false);
    }
  }, [setDocument, setLoading, setError]);

  const loadFromFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();

    // Clone the ArrayBuffer for storage BEFORE PDF.js uses it
    // (PDF.js may detach the original ArrayBuffer)
    const storageBuffer = arrayBuffer.slice(0);

    // Load the PDF
    await loadDocument(arrayBuffer);

    // Save to storage (using the cloned buffer)
    try {
      await saveCurrentPDF(storageBuffer, file.name);
    } catch (err) {
      console.error('Failed to save PDF to storage:', err);
    }
  }, [loadDocument]);

  // Load from storage on initial mount
  useEffect(() => {
    if (hasTriedStorageLoad.current) return;
    hasTriedStorageLoad.current = true;

    const loadFromStorage = async () => {
      try {
        const stored = await loadCurrentPDF();
        if (stored) {
          await loadDocument(stored.data);
        }
      } catch (err) {
        console.error('Failed to load PDF from storage:', err);
      }
    };

    loadFromStorage();
  }, [loadDocument]);

  const loadFromUrl = useCallback(async (url: string) => {
    await loadDocument(url);
  }, [loadDocument]);

  const goToPage = useCallback((page: number) => {
    if (document && page >= 1 && page <= document.numPages) {
      setCurrentPage(page);
    }
  }, [document, setCurrentPage]);

  const nextPage = useCallback(() => {
    if (document && navigation.currentPage < document.numPages) {
      setCurrentPage(navigation.currentPage + 1);
    }
  }, [document, navigation.currentPage, setCurrentPage]);

  const previousPage = useCallback(() => {
    if (navigation.currentPage > 1) {
      setCurrentPage(navigation.currentPage - 1);
    }
  }, [navigation.currentPage, setCurrentPage]);

  const zoomIn = useCallback(() => {
    const newZoom = Math.min(navigation.zoom * 1.25, 4);
    setZoom(newZoom, 'manual');
  }, [navigation.zoom, setZoom]);

  const zoomOut = useCallback(() => {
    const newZoom = Math.max(navigation.zoom / 1.25, 0.25);
    setZoom(newZoom, 'manual');
  }, [navigation.zoom, setZoom]);

  const fitToPage = useCallback(() => {
    setZoomMode('fit-page');
  }, [setZoomMode]);

  const fitToWidth = useCallback(() => {
    setZoomMode('fit-width');
  }, [setZoomMode]);

  const rotate = useCallback((degrees: 90 | -90 | 180) => {
    const newRotation = (navigation.rotation + degrees + 360) % 360;
    setRotation(newRotation);
  }, [navigation.rotation, setRotation]);

  return {
    document,
    documentVersion,
    isLoading,
    error,
    navigation,
    loadDocument,
    loadFromFile,
    loadFromUrl,
    goToPage,
    nextPage,
    previousPage,
    zoomIn,
    zoomOut,
    setZoom,
    setZoomMode,
    fitToPage,
    fitToWidth,
    setViewMode,
    rotate,
    setCurrentPage,
  };
}
