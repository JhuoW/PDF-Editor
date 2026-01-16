import { useCallback } from 'react';
import { useTextBoxStore } from '../../../store/textBoxStore';
import { useAnnotationStore, createFreeTextAnnotation } from '../../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../../store/annotationHistoryStore';

interface Point {
  x: number;
  y: number;
}

export function useTextBoxCreation() {
  const {
    creation,
    startCreation,
    updateCreation,
    finishCreation,
    cancelCreation,
    defaultTextStyle,
    defaultBoxStyle,
  } = useTextBoxStore();

  const { addAnnotation, selectAnnotation, toolSettings } = useAnnotationStore();
  const { recordAdd } = useAnnotationHistoryStore();

  // Start creating a text box
  const handleStartCreation = useCallback(
    (pageNumber: number, point: Point) => {
      startCreation(pageNumber, point);
    },
    [startCreation]
  );

  // Update the creation preview as mouse moves
  const handleUpdateCreation = useCallback(
    (point: Point) => {
      if (creation.isCreating) {
        updateCreation(point);
      }
    },
    [creation.isCreating, updateCreation]
  );

  // Complete the text box creation
  const handleFinishCreation = useCallback((): string | null => {
    const result = finishCreation();
    if (!result) return null;

    const { pageNumber, rect } = result;

    // Create the annotation with default styles
    const annotation = createFreeTextAnnotation(
      pageNumber,
      rect,
      '',
      { ...defaultTextStyle, ...toolSettings.textStyle }
    );

    // Add box style
    if (defaultBoxStyle) {
      (annotation as any).boxStyle = { ...defaultBoxStyle };
    }

    // Add to store and record for undo
    addAnnotation(annotation);
    recordAdd(annotation);
    selectAnnotation(annotation.id);

    return annotation.id;
  }, [finishCreation, defaultTextStyle, defaultBoxStyle, toolSettings.textStyle, addAnnotation, recordAdd, selectAnnotation]);

  // Cancel creation
  const handleCancelCreation = useCallback(() => {
    cancelCreation();
  }, [cancelCreation]);

  // Get the preview rectangle for rendering
  const getPreviewRect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    if (!creation.isCreating || !creation.startPoint) return null;

    const endPoint = creation.currentPoint || creation.startPoint;

    const x = Math.min(creation.startPoint.x, endPoint.x);
    const y = Math.min(creation.startPoint.y, endPoint.y);
    const width = Math.abs(endPoint.x - creation.startPoint.x);
    const height = Math.abs(endPoint.y - creation.startPoint.y);

    // Return minimum size for preview
    return {
      x,
      y,
      width: Math.max(width, 50),
      height: Math.max(height, 30),
    };
  }, [creation]);

  return {
    isCreating: creation.isCreating,
    creationPageNumber: creation.pageNumber,
    startCreation: handleStartCreation,
    updateCreation: handleUpdateCreation,
    finishCreation: handleFinishCreation,
    cancelCreation: handleCancelCreation,
    getPreviewRect,
  };
}
