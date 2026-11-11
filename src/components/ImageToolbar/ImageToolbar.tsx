import { useLocale, t } from "../../i18n";
import { useCallback, useRef } from 'react';
import { FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, RotateCcwSquare, Crop, Undo2, BringToFront, SendToBack, ChevronUp, ChevronDown, Blend, Trash2, type LucideIcon } from 'lucide-react';
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
  // Opacity is previewed live while dragging and recorded once on release.
  const opacityStart = useRef<ImageAnnotation | null>(null);

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
    if (!Number.isFinite(newOpacity)) return;
    opacityStart.current ??= { ...annotation };
    updateAnnotation(annotation.id, { opacity: newOpacity });
  }, [annotation, updateAnnotation]);

  // One undo step per slider gesture (pointer release, key release or blur).
  const handleOpacityChangeEnd = useCallback(() => {
    const previousState = opacityStart.current;
    opacityStart.current = null;
    if (previousState && previousState.opacity !== annotation.opacity) recordUpdate({ ...annotation }, previousState);
  }, [annotation, recordUpdate]);

  // Delete image
  const handleDelete = useCallback(() => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onDelete?.();
  }, [annotation, deleteAnnotation, recordDelete, onDelete]);

  const button = (Icon: LucideIcon, label: string, onClick: () => void, extra = '') => (
    <button type="button" className={`image-toolbar-button ${extra}`} onClick={onClick} title={label} aria-label={label}>
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  const cropped = !!annotation.cropBounds && (annotation.cropBounds.top > 0 || annotation.cropBounds.right > 0 || annotation.cropBounds.bottom > 0 || annotation.cropBounds.left > 0);

  return (
    <div className="image-toolbar" role="toolbar" aria-label={t("m.image.50e19f")}>
      {/* Transform Section */}
      <div className="image-toolbar-section">
        {button(FlipHorizontal2, t("m.flip.horizontal.33045f"), handleFlipHorizontal)}
        {button(FlipVertical2, t("m.flip.vertical.2871c0"), handleFlipVertical)}
        <div className="toolbar-divider" />
        {button(RotateCcw, t("m.rotate.left.90.d02095"), handleRotateLeft)}
        {button(RotateCw, t("m.rotate.right.90.d5176e"), handleRotateRight)}
        {!!annotation.rotation && button(RotateCcwSquare, t("m.reset.rotation.76139f"), handleResetRotation, 'small')}
      </div>

      {/* Crop Section */}
      <div className="image-toolbar-section">
        {button(Crop, t("m.crop.image.eb485a"), handleCrop)}
        {cropped && button(Undo2, t("m.reset.crop.ecee53"), handleResetCrop, 'small')}
      </div>

      {/* Layer Ordering Section */}
      <div className="image-toolbar-section">
        {button(BringToFront, t("m.bring.to.front.8a0950"), handleBringToFront)}
        {button(SendToBack, t("m.send.to.back.887995"), handleSendToBack)}
        {button(ChevronUp, t("m.bring.forward.3a5a62"), handleBringForward, 'small')}
        {button(ChevronDown, t("m.send.backward.70dd87"), handleSendBackward, 'small')}
      </div>

      {/* Opacity Section */}
      <div className="image-toolbar-section">
        <label className="image-opacity" title={t("m.opacity.f0fa69")}>
          <Blend size={16} aria-hidden="true" />
          <input
            type="range"
            min="0.05"
            max="1"
            step="0.05"
            value={annotation.opacity}
            onChange={handleOpacityChange}
            onPointerUp={handleOpacityChangeEnd}
            onKeyUp={handleOpacityChangeEnd}
            onBlur={handleOpacityChangeEnd}
            className="opacity-slider"
            aria-label={t("m.opacity.f0fa69")}
          />
          <span className="value">{Math.round(annotation.opacity * 100)}%</span>
        </label>
      </div>

      {/* Delete Section */}
      <div className="image-toolbar-section">
        {button(Trash2, t("m.delete.image.d86725"), handleDelete, 'danger')}
      </div>
    </div>
  );
}
