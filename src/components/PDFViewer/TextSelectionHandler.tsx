import { useEffect, useCallback } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useAnnotationStore } from '../../store/annotationStore';
import {
  createHighlightAnnotation,
  createUnderlineAnnotation,
  createStrikeoutAnnotation,
} from '../../store/annotationStore';
import { getEffectiveRotation } from '../../core/PDFRenderer';

interface TextSelectionHandlerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function TextSelectionHandler({
  page,
  pageNumber,
  scale,
  rotation,
  containerRef,
}: TextSelectionHandlerProps) {
  const { currentTool, toolSettings, addAnnotation } = useAnnotationStore();

  // Check if current tool is a text markup tool
  const isTextMarkupTool =
    currentTool === 'highlight' ||
    currentTool === 'underline' ||
    currentTool === 'strikeout';

  // Handle text selection
  const handleMouseUp = useCallback(async () => {
    if (!isTextMarkupTool) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    if (!range) return;

    // Check if selection is within this page's text layer
    const container = containerRef.current;
    if (!container) return;

    const textLayer = container.querySelector('.text-layer-container');
    if (!textLayer || !textLayer.contains(range.commonAncestorContainer)) {
      return;
    }

    // Get selected text
    const selectedText = selection.toString();
    if (!selectedText.trim()) return;

    // Get all client rects from the selection
    const rects = range.getClientRects();
    if (rects.length === 0) return;

    // Convert rects to quad points in PDF coordinates
    const quadPoints: number[][] = [];
    const containerRect = container.getBoundingClientRect();
    const effectiveRotation = getEffectiveRotation(page, rotation);
    const viewport = page.getViewport({ scale, rotation: effectiveRotation });

    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];

      // Get coordinates relative to the container
      const left = rect.left - containerRect.left;
      const right = rect.right - containerRect.left;
      const top = rect.top - containerRect.top;
      const bottom = rect.bottom - containerRect.top;

      // Convert screen coordinates to PDF coordinates
      // PDF coordinates have origin at bottom-left
      const pdfLeft = left / scale;
      const pdfRight = right / scale;
      const pdfTop = (viewport.height - top) / scale;
      const pdfBottom = (viewport.height - bottom) / scale;

      // Create quad points: [x1,y1, x2,y2, x3,y3, x4,y4]
      // Order: bottom-left, bottom-right, top-right, top-left
      quadPoints.push([
        pdfLeft, pdfBottom,   // bottom-left
        pdfRight, pdfBottom,  // bottom-right
        pdfRight, pdfTop,     // top-right
        pdfLeft, pdfTop,      // top-left
      ]);
    }

    if (quadPoints.length === 0) return;

    // Create annotation based on tool type
    let annotation;
    switch (currentTool) {
      case 'highlight':
        annotation = createHighlightAnnotation(
          pageNumber,
          quadPoints,
          toolSettings.color,
          toolSettings.opacity,
          selectedText
        );
        break;
      case 'underline':
        annotation = createUnderlineAnnotation(
          pageNumber,
          quadPoints,
          toolSettings.color
        );
        break;
      case 'strikeout':
        annotation = createStrikeoutAnnotation(
          pageNumber,
          quadPoints,
          toolSettings.color
        );
        break;
    }

    if (annotation) {
      addAnnotation(annotation);
    }

    // Clear selection
    selection.removeAllRanges();
  }, [
    isTextMarkupTool,
    currentTool,
    toolSettings,
    page,
    pageNumber,
    scale,
    rotation,
    containerRef,
    addAnnotation,
  ]);

  // Listen for mouseup events
  useEffect(() => {
    if (!isTextMarkupTool) return;

    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isTextMarkupTool, handleMouseUp, containerRef]);

  return null;
}
