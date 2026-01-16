import { useCallback, useRef } from 'react';
import { useAnnotationStore } from '../../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../../store/annotationHistoryStore';
import type { FreeTextAnnotation } from '../../../annotations/types';

interface SnapGuide {
  type: 'horizontal' | 'vertical';
  position: number;
  source: 'page-edge' | 'annotation' | 'grid' | 'center';
}

// Snap threshold in pixels
const SNAP_THRESHOLD = 8;
const NUDGE_AMOUNT = 1;
const NUDGE_AMOUNT_SHIFT = 10;

export function useTextBoxManipulation() {
  const {
    selectedAnnotationId,
    getAnnotationsForPage,
    updateAnnotation,
    selectAnnotation,
    deleteAnnotation,
    getAllAnnotations,
  } = useAnnotationStore();

  const { recordUpdate, recordDelete } = useAnnotationHistoryStore();

  // Store original state before manipulation
  const originalAnnotationRef = useRef<FreeTextAnnotation | null>(null);

  // Get selected annotation
  const getSelectedAnnotation = useCallback((): FreeTextAnnotation | null => {
    if (!selectedAnnotationId) return null;
    const allAnnotations = getAllAnnotations();
    const annotation = allAnnotations.find(
      (a) => a.id === selectedAnnotationId && a.type === 'freetext'
    );
    return annotation as FreeTextAnnotation | null;
  }, [selectedAnnotationId, getAllAnnotations]);

  // Start manipulation (drag, resize, rotate)
  const startManipulation = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (annotation) {
      originalAnnotationRef.current = { ...annotation };
    }
  }, [getSelectedAnnotation]);

  // End manipulation and record for undo
  const endManipulation = useCallback(() => {
    const annotation = getSelectedAnnotation();
    const original = originalAnnotationRef.current;

    if (annotation && original) {
      // Only record if something changed
      if (
        JSON.stringify(annotation.rect) !== JSON.stringify(original.rect) ||
        annotation.rotation !== original.rotation
      ) {
        recordUpdate(annotation, original);
      }
    }

    originalAnnotationRef.current = null;
  }, [getSelectedAnnotation, recordUpdate]);

  // Move annotation by delta
  const moveBy = useCallback(
    (deltaX: number, deltaY: number, recordHistory: boolean = true) => {
      const annotation = getSelectedAnnotation();
      if (!annotation || annotation.isLocked) return;

      if (recordHistory) {
        startManipulation();
      }

      const newRect: [number, number, number, number] = [
        annotation.rect[0] + deltaX,
        annotation.rect[1] + deltaY,
        annotation.rect[2],
        annotation.rect[3],
      ];

      updateAnnotation(annotation.id, { rect: newRect });

      if (recordHistory) {
        endManipulation();
      }
    },
    [getSelectedAnnotation, updateAnnotation, startManipulation, endManipulation]
  );

  // Nudge with arrow keys
  const nudge = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right', shiftKey: boolean = false) => {
      const amount = shiftKey ? NUDGE_AMOUNT_SHIFT : NUDGE_AMOUNT;

      let deltaX = 0;
      let deltaY = 0;

      switch (direction) {
        case 'up':
          deltaY = amount; // PDF coords: y increases upward
          break;
        case 'down':
          deltaY = -amount;
          break;
        case 'left':
          deltaX = -amount;
          break;
        case 'right':
          deltaX = amount;
          break;
      }

      moveBy(deltaX, deltaY, true);
    },
    [moveBy]
  );

  // Resize annotation
  const resize = useCallback(
    (
      handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w',
      deltaX: number,
      deltaY: number,
      maintainAspectRatio: boolean = false
    ) => {
      const annotation = getSelectedAnnotation();
      if (!annotation || annotation.isLocked) return;

      const [x, y, width, height] = annotation.rect;
      let newRect: [number, number, number, number] = [...annotation.rect];

      switch (handle) {
        case 'nw':
          newRect = [x + deltaX, y + deltaY, width - deltaX, height - deltaY];
          break;
        case 'n':
          newRect = [x, y + deltaY, width, height - deltaY];
          break;
        case 'ne':
          newRect = [x, y + deltaY, width + deltaX, height - deltaY];
          break;
        case 'e':
          newRect = [x, y, width + deltaX, height];
          break;
        case 'se':
          newRect = [x, y, width + deltaX, height + deltaY];
          break;
        case 's':
          newRect = [x, y, width, height + deltaY];
          break;
        case 'sw':
          newRect = [x + deltaX, y, width - deltaX, height + deltaY];
          break;
        case 'w':
          newRect = [x + deltaX, y, width - deltaX, height];
          break;
      }

      // Maintain aspect ratio if shift held
      if (maintainAspectRatio && width > 0 && height > 0) {
        const aspectRatio = width / height;
        const newWidth = newRect[2];
        const newHeight = newRect[3];

        if (handle === 'e' || handle === 'w') {
          newRect[3] = newWidth / aspectRatio;
        } else if (handle === 'n' || handle === 's') {
          newRect[2] = newHeight * aspectRatio;
        } else {
          // Corner handles
          const avgScale = (Math.abs(newWidth / width) + Math.abs(newHeight / height)) / 2;
          newRect[2] = width * avgScale;
          newRect[3] = height * avgScale;
        }
      }

      // Ensure minimum size
      if (newRect[2] >= 20 && newRect[3] >= 20) {
        updateAnnotation(annotation.id, { rect: newRect });
      }
    },
    [getSelectedAnnotation, updateAnnotation]
  );

  // Rotate annotation
  const rotate = useCallback(
    (degrees: number, snap: boolean = false) => {
      const annotation = getSelectedAnnotation();
      if (!annotation || annotation.isLocked) return;

      let newRotation = (annotation.rotation || 0) + degrees;

      // Snap to 15 degree increments
      if (snap) {
        newRotation = Math.round(newRotation / 15) * 15;
      }

      // Normalize to 0-360
      newRotation = ((newRotation % 360) + 360) % 360;

      updateAnnotation(annotation.id, { rotation: newRotation });
    },
    [getSelectedAnnotation, updateAnnotation]
  );

  // Set absolute rotation
  const setRotation = useCallback(
    (degrees: number) => {
      const annotation = getSelectedAnnotation();
      if (!annotation || annotation.isLocked) return;

      updateAnnotation(annotation.id, { rotation: degrees });
    },
    [getSelectedAnnotation, updateAnnotation]
  );

  // Calculate snap guides
  const getSnapGuides = useCallback(
    (
      pageNumber: number,
      rect: [number, number, number, number],
      pageWidth: number,
      pageHeight: number
    ): { guides: SnapGuide[]; snappedRect: [number, number, number, number] } => {
      const guides: SnapGuide[] = [];
      const snappedRect: [number, number, number, number] = [...rect];
      const [x, y, width, height] = rect;

      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const right = x + width;
      const top = y + height;

      // Check page edges
      const pageSnaps = [
        { type: 'vertical' as const, pos: 0, check: x, source: 'page-edge' as const },
        { type: 'vertical' as const, pos: pageWidth, check: right, source: 'page-edge' as const },
        { type: 'vertical' as const, pos: pageWidth / 2, check: centerX, source: 'center' as const },
        { type: 'horizontal' as const, pos: 0, check: y, source: 'page-edge' as const },
        { type: 'horizontal' as const, pos: pageHeight, check: top, source: 'page-edge' as const },
        { type: 'horizontal' as const, pos: pageHeight / 2, check: centerY, source: 'center' as const },
      ];

      for (const snap of pageSnaps) {
        const diff = Math.abs(snap.check - snap.pos);
        if (diff < SNAP_THRESHOLD) {
          guides.push({
            type: snap.type,
            position: snap.pos,
            source: snap.source,
          });

          // Apply snap
          if (snap.type === 'vertical') {
            const adjust = snap.pos - snap.check;
            snappedRect[0] += adjust;
          } else {
            const adjust = snap.pos - snap.check;
            snappedRect[1] += adjust;
          }
        }
      }

      // Check other annotations on the same page
      const pageAnnotations = getAnnotationsForPage(pageNumber).filter(
        (a) => a.type === 'freetext' && a.id !== selectedAnnotationId
      ) as FreeTextAnnotation[];

      for (const other of pageAnnotations) {
        const [ox, oy, ow, oh] = other.rect;
        const ocx = ox + ow / 2;
        const ocy = oy + oh / 2;
        const oright = ox + ow;
        const otop = oy + oh;

        // Check vertical alignment (left, center, right edges)
        const verticalSnaps = [
          { pos: ox, check: x },
          { pos: ox, check: right },
          { pos: ocx, check: centerX },
          { pos: oright, check: x },
          { pos: oright, check: right },
        ];

        for (const snap of verticalSnaps) {
          const diff = Math.abs(snap.check - snap.pos);
          if (diff < SNAP_THRESHOLD) {
            guides.push({
              type: 'vertical',
              position: snap.pos,
              source: 'annotation',
            });
          }
        }

        // Check horizontal alignment (bottom, center, top edges)
        const horizontalSnaps = [
          { pos: oy, check: y },
          { pos: oy, check: top },
          { pos: ocy, check: centerY },
          { pos: otop, check: y },
          { pos: otop, check: top },
        ];

        for (const snap of horizontalSnaps) {
          const diff = Math.abs(snap.check - snap.pos);
          if (diff < SNAP_THRESHOLD) {
            guides.push({
              type: 'horizontal',
              position: snap.pos,
              source: 'annotation',
            });
          }
        }
      }

      return { guides, snappedRect };
    },
    [getAnnotationsForPage, selectedAnnotationId]
  );

  // Z-index operations
  const bringToFront = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const pageAnnotations = getAnnotationsForPage(annotation.pageNumber);
    const maxZIndex = Math.max(
      ...pageAnnotations.map((a) => (a as FreeTextAnnotation).zIndex || 0),
      0
    );

    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: maxZIndex + 1 });
    recordUpdate({ ...annotation, zIndex: maxZIndex + 1 }, previousState);
  }, [getSelectedAnnotation, getAnnotationsForPage, updateAnnotation, recordUpdate]);

  const sendToBack = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const pageAnnotations = getAnnotationsForPage(annotation.pageNumber);
    const minZIndex = Math.min(
      ...pageAnnotations.map((a) => (a as FreeTextAnnotation).zIndex || 0),
      0
    );

    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: minZIndex - 1 });
    recordUpdate({ ...annotation, zIndex: minZIndex - 1 }, previousState);
  }, [getSelectedAnnotation, getAnnotationsForPage, updateAnnotation, recordUpdate]);

  const bringForward = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const previousState = { ...annotation };
    const currentZ = annotation.zIndex || 0;
    updateAnnotation(annotation.id, { zIndex: currentZ + 1 });
    recordUpdate({ ...annotation, zIndex: currentZ + 1 }, previousState);
  }, [getSelectedAnnotation, updateAnnotation, recordUpdate]);

  const sendBackward = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const previousState = { ...annotation };
    const currentZ = annotation.zIndex || 0;
    updateAnnotation(annotation.id, { zIndex: currentZ - 1 });
    recordUpdate({ ...annotation, zIndex: currentZ - 1 }, previousState);
  }, [getSelectedAnnotation, updateAnnotation, recordUpdate]);

  // Lock/unlock
  const toggleLock = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const previousState = { ...annotation };
    const newLocked = !annotation.isLocked;
    updateAnnotation(annotation.id, { isLocked: newLocked });
    recordUpdate({ ...annotation, isLocked: newLocked }, previousState);
  }, [getSelectedAnnotation, updateAnnotation, recordUpdate]);

  // Delete selected
  const deleteSelected = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    recordDelete(annotation);
    deleteAnnotation(annotation.id);
  }, [getSelectedAnnotation, recordDelete, deleteAnnotation]);

  // Duplicate
  const duplicate = useCallback(() => {
    const annotation = getSelectedAnnotation();
    if (!annotation) return;

    const newRect: [number, number, number, number] = [
      annotation.rect[0] + 20,
      annotation.rect[1] - 20,
      annotation.rect[2],
      annotation.rect[3],
    ];

    const duplicated: FreeTextAnnotation = {
      ...annotation,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      rect: newRect,
      createdAt: new Date(),
      modifiedAt: new Date(),
    };

    useAnnotationStore.getState().addAnnotation(duplicated);
    useAnnotationHistoryStore.getState().recordAdd(duplicated);
    selectAnnotation(duplicated.id);

    return duplicated.id;
  }, [getSelectedAnnotation, selectAnnotation]);

  return {
    selectedAnnotationId,
    getSelectedAnnotation,
    startManipulation,
    endManipulation,
    moveBy,
    nudge,
    resize,
    rotate,
    setRotation,
    getSnapGuides,
    bringToFront,
    sendToBack,
    bringForward,
    sendBackward,
    toggleLock,
    deleteSelected,
    duplicate,
  };
}
