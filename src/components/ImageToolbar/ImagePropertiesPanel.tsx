import { useLocale, t } from "../../i18n";
import { useCallback, useState, useRef, useEffect, useId } from 'react';
import type { ImageAnnotation } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import { PropertyNumberInput } from '../Workspace/PropertyInput';
import { readInsertImage } from '../../utils/readInsertImage';
import { useDocumentStore } from '../../store/documentStore';
import { ErrorMessage } from '../Feedback/ErrorMessage';
import './ImagePropertiesPanel.css';

interface ImagePropertiesPanelProps {
  annotation: ImageAnnotation;
  onClose: () => void;
}

export function ImagePropertiesPanel({ annotation, onClose }: ImagePropertiesPanelProps) {
  useLocale();
  const { updateAnnotation, deleteAnnotation } = useAnnotationStore();
  const { recordUpdate, recordDelete } = useAnnotationHistoryStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const replacement = useRef<AbortController | null>(null);
  const [replacementState, setReplacementState] = useState<{ id: string; loading: boolean; error: unknown }>({ id: annotation.id, loading: false, error: null });
  const replacing = replacementState.id === annotation.id && replacementState.loading;
  const replaceError = replacementState.id === annotation.id ? replacementState.error : null;
  useEffect(() => {
    const unsubscribe = useDocumentStore.subscribe((next, previous) => {
      if (next.document !== previous.document || next.documentVersion !== previous.documentVersion) replacement.current?.abort();
    });
    return () => { unsubscribe(); replacement.current?.abort(); replacement.current = null; };
  }, [annotation.id]);

  // Local state for form values
  const [lockAspectRatio, setLockAspectRatio] = useState(true);

  // Calculate display values
  const x = annotation.rect[0];
  const y = annotation.rect[1];
  const width = annotation.rect[2];
  const height = annotation.rect[3];
  const rotation = annotation.rotation || 0;
  const opacity = Math.round(annotation.opacity * 100);

  // Border properties
  const borderEnabled = (annotation.borderWidth || 0) > 0;
  const borderWidth = annotation.borderWidth || 1;
  const borderColor = annotation.borderColor || '#000000';
  const borderStyle = annotation.borderStyle || 'solid';
  const borderRadius = annotation.borderRadius || 0;

  // Crop bounds
  const cropBounds = annotation.cropBounds || { top: 0, right: 0, bottom: 0, left: 0 };
  const hasCrop = cropBounds.top > 0 || cropBounds.right > 0 || cropBounds.bottom > 0 || cropBounds.left > 0;

  // File info
  const filename = annotation.originalFilename || t('m.unknown.bc7819');
  const fileSize = annotation.originalFileSize
    ? annotation.originalFileSize > 1024 * 1024
      ? `${(annotation.originalFileSize / (1024 * 1024)).toFixed(2)} MB`
      : `${(annotation.originalFileSize / 1024).toFixed(2)} KB`
    : t('m.unknown.bc7819');
  const originalDimensions = `${annotation.originalWidth} × ${annotation.originalHeight}`;
  const mimeType = annotation.mimeType || t('m.unknown.bc7819');

  // Update with undo support
  const updateWithHistory = useCallback((updates: Partial<ImageAnnotation>) => {
    const current = useAnnotationStore.getState().getAllAnnotations().find(item => item.id === annotation.id);
    if (!current || current.type !== 'image') return;
    const previousState = { ...current };
    updateAnnotation(current.id, updates);
    recordUpdate({ ...current, ...updates }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Position handlers
  const handleXChange = useCallback((newX: number) => {
    updateWithHistory({ rect: [newX, annotation.rect[1], annotation.rect[2], annotation.rect[3]] });
  }, [annotation, updateWithHistory]);

  const handleYChange = useCallback((newY: number) => {
    updateWithHistory({ rect: [annotation.rect[0], newY, annotation.rect[2], annotation.rect[3]] });
  }, [annotation, updateWithHistory]);

  // Size handlers
  const handleWidthChange = useCallback((newWidth: number) => {
    let newHeight = annotation.rect[3];
    if (lockAspectRatio && annotation.rect[2] > 0 && annotation.rect[3] > 0) {
      const aspectRatio = annotation.rect[2] / annotation.rect[3];
      newHeight = newWidth / aspectRatio;
    }
    updateWithHistory({ rect: [annotation.rect[0], annotation.rect[1], newWidth, newHeight] });
  }, [annotation, updateWithHistory, lockAspectRatio]);

  const handleHeightChange = useCallback((newHeight: number) => {
    let newWidth = annotation.rect[2];
    if (lockAspectRatio && annotation.rect[2] > 0 && annotation.rect[3] > 0) {
      const aspectRatio = annotation.rect[2] / annotation.rect[3];
      newWidth = newHeight * aspectRatio;
    }
    updateWithHistory({ rect: [annotation.rect[0], annotation.rect[1], newWidth, newHeight] });
  }, [annotation, updateWithHistory, lockAspectRatio]);

  // Reset to original size
  const handleResetSize = useCallback(() => {
    const maxDim = 300;
    let newWidth = annotation.originalWidth;
    let newHeight = annotation.originalHeight;

    if (newWidth > maxDim || newHeight > maxDim) {
      const scale = Math.min(maxDim / newWidth, maxDim / newHeight);
      newWidth *= scale;
      newHeight *= scale;
    }

    updateWithHistory({ rect: [annotation.rect[0], annotation.rect[1], newWidth, newHeight] });
  }, [annotation, updateWithHistory]);

  // Rotation handler
  const handleRotationChange = useCallback((newRotation: number) => {
    updateWithHistory({ rotation: newRotation });
  }, [updateWithHistory]);

  // Opacity handler
  const handleOpacityChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newOpacity = Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) / 100;
    updateWithHistory({ opacity: newOpacity });
  }, [updateWithHistory]);

  // Border handlers
  const handleBorderEnabledChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateWithHistory({ borderWidth: e.target.checked ? 1 : 0 });
  }, [updateWithHistory]);

  const handleBorderWidthChange = useCallback((newWidth: number) => {
    updateWithHistory({ borderWidth: newWidth });
  }, [updateWithHistory]);

  const handleBorderColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateWithHistory({ borderColor: e.target.value });
  }, [updateWithHistory]);

  const handleBorderStyleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateWithHistory({ borderStyle: e.target.value as 'solid' | 'dashed' | 'dotted' | 'none' });
  }, [updateWithHistory]);

  const handleBorderRadiusChange = useCallback((newRadius: number) => {
    updateWithHistory({ borderRadius: newRadius });
  }, [updateWithHistory]);

  // Reset crop
  const handleResetCrop = useCallback(() => {
    updateWithHistory({ cropBounds: undefined });
  }, [updateWithHistory]);

  // Reset all transformations
  const handleResetAll = useCallback(() => {
    const maxDim = 300;
    let newWidth = annotation.originalWidth;
    let newHeight = annotation.originalHeight;

    if (newWidth > maxDim || newHeight > maxDim) {
      const scale = Math.min(maxDim / newWidth, maxDim / newHeight);
      newWidth *= scale;
      newHeight *= scale;
    }

    updateWithHistory({
      rect: [annotation.rect[0], annotation.rect[1], newWidth, newHeight],
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      cropBounds: undefined,
      opacity: 1,
      borderWidth: 0,
      borderRadius: 0,
    });
  }, [annotation, updateWithHistory]);

  // Replace image
  const handleReplaceImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    replacement.current?.abort();
    const controller = new AbortController(); replacement.current = controller;
    const { document, documentVersion } = useDocumentStore.getState();
    setReplacementState({ id: annotation.id, loading: true, error: null });
    try {
      const image = await readInsertImage(file, controller.signal);
      const current = useDocumentStore.getState();
      if (controller.signal.aborted || current.document !== document || current.documentVersion !== documentVersion) return;
      updateWithHistory({ imageData: image.imageData, originalWidth: image.originalWidth, originalHeight: image.originalHeight,
        originalFilename: image.filename, originalFileSize: image.fileSize, mimeType: image.mimeType, cropBounds: undefined });
    } catch (error) { if (!controller.signal.aborted) setReplacementState({ id: annotation.id, loading: false, error }); }
    finally {
      if (replacement.current === controller) {
        replacement.current = null;
        setReplacementState(previous => ({ ...previous, loading: false }));
      }
    }
  }, [annotation.id, updateWithHistory]);

  // Delete image
  const handleDelete = useCallback(() => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  }, [annotation, deleteAnnotation, recordDelete, onClose]);

  return (
    <div className="image-properties-panel">
      <div className="panel-header">
        <h3>{t("m.image.properties.70dd8a")}</h3>
        <button className="close-button" aria-label={t("m.close.bbfa77")} onClick={onClose}>×</button>
      </div>

      <div className="panel-content">
        {/* Position & Size Section */}
        <div className="panel-section">
          <h4>{t("m.position.size.3c8106")}</h4>
          <div className="property-row">
            <label htmlFor={`${id}-x`}>{t("m.x.9cca99")}</label>
            <PropertyNumberInput id={`${id}-x`}
              value={x}
              onCommit={handleXChange}
              className="property-input"
            />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
          <div className="property-row">
            <label htmlFor={`${id}-y`}>{t("m.y.aebff3")}</label>
            <PropertyNumberInput id={`${id}-y`}
              value={y}
              onCommit={handleYChange}
              className="property-input"
            />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
          <div className="property-row">
            <label htmlFor={`${id}-width`}>{t("m.width.bff1e2")}</label>
            <PropertyNumberInput id={`${id}-width`}
              value={width}
              onCommit={handleWidthChange}
              min={10}
              className="property-input"
            />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
          <div className="property-row">
            <label htmlFor={`${id}-height`}>{t("m.height.c58a28")}</label>
            <PropertyNumberInput id={`${id}-height`}
              value={height}
              onCommit={handleHeightChange}
              min={10}
              className="property-input"
            />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
          <div className="property-row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={lockAspectRatio}
                onChange={(e) => setLockAspectRatio(e.target.checked)}
              />
              {t("m.lock.aspect.ratio.370bda")}</label>
          </div>
          <div className="property-row">
            <label htmlFor={`${id}-rotation`}>{t("m.rotation.0f7802")}</label>
            <PropertyNumberInput id={`${id}-rotation`}
              value={rotation}
              onCommit={handleRotationChange}
              min={-360}
              max={360}
              className="property-input"
            />
            <span className="unit">°</span>
          </div>
          <button className="action-button" onClick={handleResetSize}>
            {t("m.reset.size.709a3f")}</button>
        </div>

        {/* Crop Section */}
        {hasCrop && (
          <div className="panel-section">
            <h4>{t("m.crop.c5db3d")}</h4>
            <div className="crop-info">
              <div className="property-row">
                <label>{t("m.top.088caa")}</label>
                <span>{cropBounds.top.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>{t("m.right.3a8231")}</label>
                <span>{cropBounds.right.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>{t("m.bottom.77d589")}</label>
                <span>{cropBounds.bottom.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>{t("m.left.d6f8ca")}</label>
                <span>{cropBounds.left.toFixed(1)}%</span>
              </div>
            </div>
            <button className="action-button" onClick={handleResetCrop}>
              {t("m.reset.crop.ecee53")}</button>
          </div>
        )}

        {/* Appearance Section */}
        <div className="panel-section">
          <h4>{t("m.appearance.41def7")}</h4>
          <div className="property-row">
            <label htmlFor={`${id}-opacity`}>{t("m.opacity.d20ab2")}</label>
            <input id={`${id}-opacity`}
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={handleOpacityChange}
              className="property-slider"
            />
            <PropertyNumberInput
              aria-label={t("m.opacity.d20ab2")}
              value={opacity}
              onCommit={value => updateWithHistory({ opacity: value / 100 })}
              min={0}
              max={100}
              className="property-input small"
            />
            <span className="unit">%</span>
          </div>
        </div>

        {/* Border Section */}
        <div className="panel-section">
          <h4>{t("m.border.5d10d3")}</h4>
          <div className="property-row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={borderEnabled}
                onChange={handleBorderEnabledChange}
              />
              {t("m.enable.border.fa3c12")}</label>
          </div>
          {borderEnabled && (
            <>
              <div className="property-row">
                <label htmlFor={`${id}-border-color`}>{t("m.color.511a00")}</label>
                <input id={`${id}-border-color`}
                  type="color"
                  value={borderColor}
                  onChange={handleBorderColorChange}
                  className="property-color"
                />
              </div>
              <div className="property-row">
                <label htmlFor={`${id}-border-width`}>{t("m.width.bff1e2")}</label>
                <PropertyNumberInput id={`${id}-border-width`}
                  value={borderWidth}
                  onCommit={handleBorderWidthChange}
                  min={0}
                  max={20}
                  step={0.5}
                  className="property-input"
                />
                <span className="unit">{t("m.pt.bc8112")}</span>
              </div>
              <div className="property-row">
                <label htmlFor={`${id}-border-style`}>{t("m.style.4020c0")}</label>
                <select id={`${id}-border-style`}
                  value={borderStyle}
                  onChange={handleBorderStyleChange}
                  className="property-select"
                >
                  <option value="solid">{t("m.solid.d00635")}</option>
                  <option value="dashed">{t("m.dashed.7b0a09")}</option>
                  <option value="dotted">{t("m.dotted.149492")}</option>
                </select>
              </div>
              <div className="property-row">
                <label htmlFor={`${id}-border-radius`}>{t("m.radius.96f54c")}</label>
                <PropertyNumberInput id={`${id}-border-radius`}
                  value={borderRadius}
                  onCommit={handleBorderRadiusChange}
                  min={0}
                  max={100}
                  className="property-input"
                />
                <span className="unit">{t("m.pt.bc8112")}</span>
              </div>
            </>
          )}
        </div>

        {/* Image Info Section */}
        <div className="panel-section">
          <h4>{t("m.image.info.70e72d")}</h4>
          <div className="info-row">
            <label>{t("m.filename.08231f")}</label>
            <span className="info-value" title={filename}>{filename}</span>
          </div>
          <div className="info-row">
            <label>{t("m.original.size.02401a")}</label>
            <span className="info-value">{originalDimensions}</span>
          </div>
          <div className="info-row">
            <label>{t("m.file.size.69a70f")}</label>
            <span className="info-value">{fileSize}</span>
          </div>
          <div className="info-row">
            <label>{t("m.format.d6400d")}</label>
            <span className="info-value">{mimeType}</span>
          </div>
        </div>

        {/* Actions Section */}
        <div className="panel-section actions-section">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
          {replaceError !== null && <div role="alert"><ErrorMessage error={replaceError} operation="Replace image" /></div>}
          <button className="action-button" disabled={replacing} onClick={handleReplaceImage}>
            {t(replacing ? "m.reading.image.8ae8b8" : "m.replace.image.6cba62")}</button>
          {replacing && <button className="action-button" onClick={() => replacement.current?.abort()}>{t("m.cancel.image.loading.6ec197")}</button>}
          <button className="action-button" onClick={handleResetAll}>
            {t("m.reset.all.58f5fb")}</button>
          <button className="action-button danger" onClick={handleDelete}>
            {t("m.delete.image.d86725")}</button>
        </div>
      </div>
    </div>
  );
}
