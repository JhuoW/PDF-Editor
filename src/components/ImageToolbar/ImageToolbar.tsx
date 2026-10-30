import { useLocale, t } from "../../i18n";
import { useCallback, useState } from 'react';
import type { ImageAnnotation } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './ImageToolbar.css';

interface ImageToolbarProps {
  annotation: ImageAnnotation;
  onDelete?: () => void;
}

export function ImageToolbar({ annotation, onDelete }: ImageToolbarProps) {
  useLocale();
  const { updateAnnotation, deleteAnnotation, getAnnotationsForPage, enterCropMode } = useAnnotationStore();
  const { recordUpdate, recordDelete } = useAnnotationHistoryStore();
  const [showOpacitySlider, setShowOpacitySlider] = useState(false);

  // Enter crop mode
  const handleCrop = useCallback(() => {
    enterCropMode(annotation.id);
  }, [annotation.id, enterCropMode]);

  // Reset crop
  const handleResetCrop = useCallback(() => {
    if (!annotation.cropBounds) return;
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { cropBounds: undefined });
    recordUpdate({ ...annotation, cropBounds: undefined }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Flip horizontal
  const handleFlipHorizontal = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, {
      flipHorizontal: !annotation.flipHorizontal,
    });
    recordUpdate({ ...annotation, flipHorizontal: !annotation.flipHorizontal }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Flip vertical
  const handleFlipVertical = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, {
      flipVertical: !annotation.flipVertical,
    });
    recordUpdate({ ...annotation, flipVertical: !annotation.flipVertical }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Rotate 90 degrees clockwise
  const handleRotateRight = useCallback(() => {
    const previousState = { ...annotation };
    const newRotation = ((annotation.rotation || 0) + 90) % 360;
    updateAnnotation(annotation.id, { rotation: newRotation });
    recordUpdate({ ...annotation, rotation: newRotation }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Rotate 90 degrees counter-clockwise
  const handleRotateLeft = useCallback(() => {
    const previousState = { ...annotation };
    const newRotation = ((annotation.rotation || 0) - 90 + 360) % 360;
    updateAnnotation(annotation.id, { rotation: newRotation });
    recordUpdate({ ...annotation, rotation: newRotation }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Reset rotation
  const handleResetRotation = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { rotation: 0 });
    recordUpdate({ ...annotation, rotation: 0 }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Bring to front
  const handleBringToFront = useCallback(() => {
    const annotations = getAnnotationsForPage(annotation.pageNumber);
    const maxZIndex = Math.max(...annotations.map(a => (a as ImageAnnotation).zIndex || 0), 0);
    if ((annotation.zIndex || 0) < maxZIndex) {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { zIndex: maxZIndex + 1 });
      recordUpdate({ ...annotation, zIndex: maxZIndex + 1 }, previousState);
    }
  }, [annotation, updateAnnotation, recordUpdate, getAnnotationsForPage]);

  // Send to back
  const handleSendToBack = useCallback(() => {
    const annotations = getAnnotationsForPage(annotation.pageNumber);
    const minZIndex = Math.min(...annotations.map(a => (a as ImageAnnotation).zIndex || 0), 0);
    if ((annotation.zIndex || 0) > minZIndex) {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { zIndex: minZIndex - 1 });
      recordUpdate({ ...annotation, zIndex: minZIndex - 1 }, previousState);
    }
  }, [annotation, updateAnnotation, recordUpdate, getAnnotationsForPage]);

  // Bring forward one layer
  const handleBringForward = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: (annotation.zIndex || 0) + 1 });
    recordUpdate({ ...annotation, zIndex: (annotation.zIndex || 0) + 1 }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Send backward one layer
  const handleSendBackward = useCallback(() => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: (annotation.zIndex || 0) - 1 });
    recordUpdate({ ...annotation, zIndex: (annotation.zIndex || 0) - 1 }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Update opacity
  const handleOpacityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newOpacity = parseFloat(e.target.value);
    updateAnnotation(annotation.id, { opacity: newOpacity });
  }, [annotation.id, updateAnnotation]);

  // Record opacity change when slider is released
  const handleOpacityChangeEnd = useCallback(() => {
    // Record update is handled on blur/release
  }, []);

  // Delete image
  const handleDelete = useCallback(() => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onDelete?.();
  }, [annotation, deleteAnnotation, recordDelete, onDelete]);

  return (
    <div className="image-toolbar">
      {/* Transform Section */}
      <div className="image-toolbar-section">
        <button
          className="image-toolbar-button"
          onClick={handleFlipHorizontal}
          title={t("m.flip.horizontal.33045f")}
        >
          <span className="icon">↔</span>
        </button>
        <button
          className="image-toolbar-button"
          onClick={handleFlipVertical}
          title={t("m.flip.vertical.2871c0")}
        >
          <span className="icon">↕</span>
        </button>
        <div className="toolbar-divider" />
        <button
          className="image-toolbar-button"
          onClick={handleRotateLeft}
          title={t("m.rotate.left.90.d02095")}
        >
          <span className="icon">↺</span>
        </button>
        <button
          className="image-toolbar-button"
          onClick={handleRotateRight}
          title={t("m.rotate.right.90.d5176e")}
        >
          <span className="icon">↻</span>
        </button>
        {annotation.rotation !== 0 && (
          <button
            className="image-toolbar-button small"
            onClick={handleResetRotation}
            title={t("m.reset.rotation.76139f")}
          >
            <span className="icon">⟲</span>
          </button>
        )}
      </div>

      {/* Crop Section */}
      <div className="image-toolbar-section">
        <button
          className="image-toolbar-button"
          onClick={handleCrop}
          title={t("m.crop.image.eb485a")}
        >
          <span className="icon">⛶</span>
        </button>
        {annotation.cropBounds && (annotation.cropBounds.top > 0 || annotation.cropBounds.right > 0 || annotation.cropBounds.bottom > 0 || annotation.cropBounds.left > 0) && (
          <button
            className="image-toolbar-button small"
            onClick={handleResetCrop}
            title={t("m.reset.crop.ecee53")}
          >
            <span className="icon">⟲</span>
          </button>
        )}
      </div>

      {/* Layer Ordering Section */}
      <div className="image-toolbar-section">
        <button
          className="image-toolbar-button"
          onClick={handleBringToFront}
          title={t("m.bring.to.front.8a0950")}
        >
          <span className="icon">⬆</span>
        </button>
        <button
          className="image-toolbar-button"
          onClick={handleSendToBack}
          title={t("m.send.to.back.887995")}
        >
          <span className="icon">⬇</span>
        </button>
        <button
          className="image-toolbar-button small"
          onClick={handleBringForward}
          title={t("m.bring.forward.3a5a62")}
        >
          <span className="icon">↑</span>
        </button>
        <button
          className="image-toolbar-button small"
          onClick={handleSendBackward}
          title={t("m.send.backward.70dd87")}
        >
          <span className="icon">↓</span>
        </button>
      </div>

      {/* Opacity Section */}
      <div className="image-toolbar-section">
        <button
          className={`image-toolbar-button ${showOpacitySlider ? 'active' : ''}`}
          onClick={() => setShowOpacitySlider(!showOpacitySlider)}
          title={t("m.opacity.f0fa69")}
        >
          <span className="icon">◐</span>
          <span className="value">{Math.round(annotation.opacity * 100)}%</span>
        </button>
        {showOpacitySlider && (
          <div className="opacity-slider-container">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={annotation.opacity}
              onChange={handleOpacityChange}
              onMouseUp={handleOpacityChangeEnd}
              className="opacity-slider"
            />
          </div>
        )}
      </div>

      {/* Delete Section */}
      <div className="image-toolbar-section">
        <button
          className="image-toolbar-button danger"
          onClick={handleDelete}
          title={t("m.delete.image.d86725")}
        >
          <span className="icon">🗑</span>
        </button>
      </div>
    </div>
  );
}
