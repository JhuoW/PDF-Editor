import { useCallback, useEffect, useRef } from 'react';
import type { ImageAnnotation } from '../../annotations/types';
import { useAnnotationStore, createImageAnnotation } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './ImageContextMenu.css';

interface ImageContextMenuProps {
  annotation: ImageAnnotation;
  position: { x: number; y: number };
  onClose: () => void;
  onShowProperties?: () => void;
}

export function ImageContextMenu({ annotation, position, onClose, onShowProperties }: ImageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { updateAnnotation, deleteAnnotation, addAnnotation, selectAnnotation, getAnnotationsForPage, enterCropMode } = useAnnotationStore();
  const { recordUpdate, recordDelete, recordAdd } = useAnnotationHistoryStore();

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Copy to clipboard
  const handleCopy = useCallback(() => {
    (window as unknown as { __annotationClipboard?: ImageAnnotation }).__annotationClipboard = JSON.parse(JSON.stringify(annotation));
    onClose();
  }, [annotation, onClose]);

  // Cut
  const handleCut = useCallback(() => {
    (window as unknown as { __annotationClipboard?: ImageAnnotation }).__annotationClipboard = JSON.parse(JSON.stringify(annotation));
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  }, [annotation, deleteAnnotation, recordDelete, onClose]);

  // Duplicate
  const handleDuplicate = useCallback(() => {
    const duplicated = createImageAnnotation(
      annotation.pageNumber,
      [annotation.rect[0] + 20, annotation.rect[1] - 20, annotation.rect[2], annotation.rect[3]],
      annotation.imageData,
      annotation.originalWidth,
      annotation.originalHeight,
      {
        originalFilename: annotation.originalFilename,
        originalFileSize: annotation.originalFileSize,
        mimeType: annotation.mimeType,
        opacity: annotation.opacity,
      }
    );
    // Copy other properties
    duplicated.rotation = annotation.rotation;
    duplicated.flipHorizontal = annotation.flipHorizontal;
    duplicated.flipVertical = annotation.flipVertical;
    duplicated.borderWidth = annotation.borderWidth;
    duplicated.borderColor = annotation.borderColor;
    duplicated.borderStyle = annotation.borderStyle;
    duplicated.borderRadius = annotation.borderRadius;

    addAnnotation(duplicated);
    recordAdd(duplicated);
    selectAnnotation(duplicated.id);
    onClose();
  }, [annotation, addAnnotation, recordAdd, selectAnnotation, onClose]);

  // Delete
  const handleDelete = useCallback(() => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  }, [annotation, deleteAnnotation, recordDelete, onClose]);

  // Flip horizontal
  const handleFlipHorizontal = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { flipHorizontal: !annotation.flipHorizontal });
    recordUpdate({ ...annotation, flipHorizontal: !annotation.flipHorizontal }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Flip vertical
  const handleFlipVertical = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { flipVertical: !annotation.flipVertical });
    recordUpdate({ ...annotation, flipVertical: !annotation.flipVertical }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Rotate 90 CW
  const handleRotateCW = useCallback(() => {
    const previousState = { ...annotation };
    const newRotation = ((annotation.rotation || 0) + 90) % 360;
    updateAnnotation(annotation.id, { rotation: newRotation });
    recordUpdate({ ...annotation, rotation: newRotation }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Rotate 90 CCW
  const handleRotateCCW = useCallback(() => {
    const previousState = { ...annotation };
    const newRotation = ((annotation.rotation || 0) - 90 + 360) % 360;
    updateAnnotation(annotation.id, { rotation: newRotation });
    recordUpdate({ ...annotation, rotation: newRotation }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Reset transformations
  const handleResetTransformations = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, {
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
    recordUpdate({ ...annotation, rotation: 0, flipHorizontal: false, flipVertical: false }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Bring to front
  const handleBringToFront = useCallback(() => {
    const annotations = getAnnotationsForPage(annotation.pageNumber);
    const maxZIndex = Math.max(...annotations.map(a => (a as ImageAnnotation).zIndex || 0), 0);
    if ((annotation.zIndex || 0) < maxZIndex) {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { zIndex: maxZIndex + 1 });
      recordUpdate({ ...annotation, zIndex: maxZIndex + 1 }, previousState);
    }
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, getAnnotationsForPage, onClose]);

  // Send to back
  const handleSendToBack = useCallback(() => {
    const annotations = getAnnotationsForPage(annotation.pageNumber);
    const minZIndex = Math.min(...annotations.map(a => (a as ImageAnnotation).zIndex || 0), 0);
    if ((annotation.zIndex || 0) > minZIndex) {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { zIndex: minZIndex - 1 });
      recordUpdate({ ...annotation, zIndex: minZIndex - 1 }, previousState);
    }
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, getAnnotationsForPage, onClose]);

  // Bring forward
  const handleBringForward = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: (annotation.zIndex || 0) + 1 });
    recordUpdate({ ...annotation, zIndex: (annotation.zIndex || 0) + 1 }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Send backward
  const handleSendBackward = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: (annotation.zIndex || 0) - 1 });
    recordUpdate({ ...annotation, zIndex: (annotation.zIndex || 0) - 1 }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Save image as
  const handleSaveImageAs = useCallback(() => {
    const link = document.createElement('a');
    link.href = annotation.imageData;
    link.download = annotation.originalFilename || 'image.png';
    link.click();
    onClose();
  }, [annotation, onClose]);

  // Crop image
  const handleCrop = useCallback(() => {
    enterCropMode(annotation.id);
    onClose();
  }, [annotation.id, enterCropMode, onClose]);

  // Reset crop
  const handleResetCrop = useCallback(() => {
    if (!annotation.cropBounds) return;
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { cropBounds: undefined });
    recordUpdate({ ...annotation, cropBounds: undefined }, previousState);
    onClose();
  }, [annotation, updateAnnotation, recordUpdate, onClose]);

  // Adjust position to keep menu on screen
  const adjustedPosition = { ...position };
  if (typeof window !== 'undefined') {
    const menuWidth = 200;
    const menuHeight = 380;
    if (position.x + menuWidth > window.innerWidth) {
      adjustedPosition.x = window.innerWidth - menuWidth - 10;
    }
    if (position.y + menuHeight > window.innerHeight) {
      adjustedPosition.y = window.innerHeight - menuHeight - 10;
    }
  }

  return (
    <div
      ref={menuRef}
      className="image-context-menu"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y }}
    >
      {/* Edit Section */}
      <div className="context-menu-section">
        <button className="context-menu-item" onClick={handleCut}>
          <span className="icon">✂</span>
          <span className="label">Cut</span>
          <span className="shortcut">Ctrl+X</span>
        </button>
        <button className="context-menu-item" onClick={handleCopy}>
          <span className="icon">📋</span>
          <span className="label">Copy</span>
          <span className="shortcut">Ctrl+C</span>
        </button>
        <button className="context-menu-item" onClick={handleDuplicate}>
          <span className="icon">⎘</span>
          <span className="label">Duplicate</span>
          <span className="shortcut">Ctrl+D</span>
        </button>
        <button className="context-menu-item danger" onClick={handleDelete}>
          <span className="icon">🗑</span>
          <span className="label">Delete</span>
          <span className="shortcut">Del</span>
        </button>
      </div>

      <div className="context-menu-divider" />

      {/* Transform Section */}
      <div className="context-menu-section">
        <button className="context-menu-item" onClick={handleFlipHorizontal}>
          <span className="icon">↔</span>
          <span className="label">Flip Horizontal</span>
        </button>
        <button className="context-menu-item" onClick={handleFlipVertical}>
          <span className="icon">↕</span>
          <span className="label">Flip Vertical</span>
        </button>
        <button className="context-menu-item" onClick={handleRotateCW}>
          <span className="icon">↻</span>
          <span className="label">Rotate 90° Clockwise</span>
        </button>
        <button className="context-menu-item" onClick={handleRotateCCW}>
          <span className="icon">↺</span>
          <span className="label">Rotate 90° Counter-clockwise</span>
        </button>
        {(annotation.rotation !== 0 || annotation.flipHorizontal || annotation.flipVertical) && (
          <button className="context-menu-item" onClick={handleResetTransformations}>
            <span className="icon">⟲</span>
            <span className="label">Reset Transformations</span>
          </button>
        )}
      </div>

      <div className="context-menu-divider" />

      {/* Crop Section */}
      <div className="context-menu-section">
        <button className="context-menu-item" onClick={handleCrop}>
          <span className="icon">⛶</span>
          <span className="label">Crop Image</span>
        </button>
        {annotation.cropBounds && (annotation.cropBounds.top > 0 || annotation.cropBounds.right > 0 || annotation.cropBounds.bottom > 0 || annotation.cropBounds.left > 0) && (
          <button className="context-menu-item" onClick={handleResetCrop}>
            <span className="icon">⟲</span>
            <span className="label">Reset Crop</span>
          </button>
        )}
      </div>

      <div className="context-menu-divider" />

      {/* Arrange Section */}
      <div className="context-menu-section">
        <button className="context-menu-item" onClick={handleBringToFront}>
          <span className="icon">⬆</span>
          <span className="label">Bring to Front</span>
          <span className="shortcut">Ctrl+Shift+]</span>
        </button>
        <button className="context-menu-item" onClick={handleSendToBack}>
          <span className="icon">⬇</span>
          <span className="label">Send to Back</span>
          <span className="shortcut">Ctrl+Shift+[</span>
        </button>
        <button className="context-menu-item" onClick={handleBringForward}>
          <span className="icon">↑</span>
          <span className="label">Bring Forward</span>
          <span className="shortcut">Ctrl+]</span>
        </button>
        <button className="context-menu-item" onClick={handleSendBackward}>
          <span className="icon">↓</span>
          <span className="label">Send Backward</span>
          <span className="shortcut">Ctrl+[</span>
        </button>
      </div>

      <div className="context-menu-divider" />

      {/* Properties Section */}
      <div className="context-menu-section">
        <button className="context-menu-item" onClick={handleSaveImageAs}>
          <span className="icon">💾</span>
          <span className="label">Save Image As...</span>
        </button>
        {onShowProperties && (
          <button className="context-menu-item" onClick={() => { onShowProperties(); onClose(); }}>
            <span className="icon">⚙</span>
            <span className="label">Image Properties...</span>
          </button>
        )}
      </div>
    </div>
  );
}
