import { useCallback, useState, useRef } from 'react';
import type { ImageAnnotation } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './ImagePropertiesPanel.css';

interface ImagePropertiesPanelProps {
  annotation: ImageAnnotation;
  onClose: () => void;
}

export function ImagePropertiesPanel({ annotation, onClose }: ImagePropertiesPanelProps) {
  const { updateAnnotation, deleteAnnotation } = useAnnotationStore();
  const { recordUpdate, recordDelete } = useAnnotationHistoryStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local state for form values
  const [lockAspectRatio, setLockAspectRatio] = useState(true);

  // Calculate display values
  const x = Math.round(annotation.rect[0]);
  const y = Math.round(annotation.rect[1]);
  const width = Math.round(annotation.rect[2]);
  const height = Math.round(annotation.rect[3]);
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
  const filename = annotation.originalFilename || 'Unknown';
  const fileSize = annotation.originalFileSize
    ? annotation.originalFileSize > 1024 * 1024
      ? `${(annotation.originalFileSize / (1024 * 1024)).toFixed(2)} MB`
      : `${(annotation.originalFileSize / 1024).toFixed(2)} KB`
    : 'Unknown';
  const originalDimensions = `${annotation.originalWidth} × ${annotation.originalHeight}`;
  const mimeType = annotation.mimeType || 'Unknown';

  // Update with undo support
  const updateWithHistory = useCallback((updates: Partial<ImageAnnotation>) => {
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, updates);
    recordUpdate({ ...annotation, ...updates }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Position handlers
  const handleXChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newX = parseFloat(e.target.value) || 0;
    updateWithHistory({ rect: [newX, annotation.rect[1], annotation.rect[2], annotation.rect[3]] });
  }, [annotation, updateWithHistory]);

  const handleYChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newY = parseFloat(e.target.value) || 0;
    updateWithHistory({ rect: [annotation.rect[0], newY, annotation.rect[2], annotation.rect[3]] });
  }, [annotation, updateWithHistory]);

  // Size handlers
  const handleWidthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newWidth = parseFloat(e.target.value) || 10;
    let newHeight = annotation.rect[3];
    if (lockAspectRatio) {
      const aspectRatio = annotation.rect[2] / annotation.rect[3];
      newHeight = newWidth / aspectRatio;
    }
    updateWithHistory({ rect: [annotation.rect[0], annotation.rect[1], newWidth, newHeight] });
  }, [annotation, updateWithHistory, lockAspectRatio]);

  const handleHeightChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newHeight = parseFloat(e.target.value) || 10;
    let newWidth = annotation.rect[2];
    if (lockAspectRatio) {
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
  const handleRotationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newRotation = (parseFloat(e.target.value) || 0) % 360;
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

  const handleBorderWidthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newWidth = Math.max(0, parseFloat(e.target.value) || 0);
    updateWithHistory({ borderWidth: newWidth });
  }, [updateWithHistory]);

  const handleBorderColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateWithHistory({ borderColor: e.target.value });
  }, [updateWithHistory]);

  const handleBorderStyleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateWithHistory({ borderStyle: e.target.value as 'solid' | 'dashed' | 'dotted' | 'none' });
  }, [updateWithHistory]);

  const handleBorderRadiusChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newRadius = Math.max(0, parseFloat(e.target.value) || 0);
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

  const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        updateWithHistory({
          imageData: reader.result as string,
          originalWidth: img.naturalWidth,
          originalHeight: img.naturalHeight,
          originalFilename: file.name,
          originalFileSize: file.size,
          mimeType: file.type,
          cropBounds: undefined, // Reset crop when replacing
        });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }, [updateWithHistory]);

  // Delete image
  const handleDelete = useCallback(() => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  }, [annotation, deleteAnnotation, recordDelete, onClose]);

  return (
    <div className="image-properties-panel">
      <div className="panel-header">
        <h3>Image Properties</h3>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      <div className="panel-content">
        {/* Position & Size Section */}
        <div className="panel-section">
          <h4>Position & Size</h4>
          <div className="property-row">
            <label>X:</label>
            <input
              type="number"
              value={x}
              onChange={handleXChange}
              className="property-input"
            />
            <span className="unit">pt</span>
          </div>
          <div className="property-row">
            <label>Y:</label>
            <input
              type="number"
              value={y}
              onChange={handleYChange}
              className="property-input"
            />
            <span className="unit">pt</span>
          </div>
          <div className="property-row">
            <label>Width:</label>
            <input
              type="number"
              value={width}
              onChange={handleWidthChange}
              min={10}
              className="property-input"
            />
            <span className="unit">pt</span>
          </div>
          <div className="property-row">
            <label>Height:</label>
            <input
              type="number"
              value={height}
              onChange={handleHeightChange}
              min={10}
              className="property-input"
            />
            <span className="unit">pt</span>
          </div>
          <div className="property-row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={lockAspectRatio}
                onChange={(e) => setLockAspectRatio(e.target.checked)}
              />
              Lock aspect ratio
            </label>
          </div>
          <div className="property-row">
            <label>Rotation:</label>
            <input
              type="number"
              value={rotation}
              onChange={handleRotationChange}
              min={-360}
              max={360}
              className="property-input"
            />
            <span className="unit">°</span>
          </div>
          <button className="action-button" onClick={handleResetSize}>
            Reset Size
          </button>
        </div>

        {/* Crop Section */}
        {hasCrop && (
          <div className="panel-section">
            <h4>Crop</h4>
            <div className="crop-info">
              <div className="property-row">
                <label>Top:</label>
                <span>{cropBounds.top.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>Right:</label>
                <span>{cropBounds.right.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>Bottom:</label>
                <span>{cropBounds.bottom.toFixed(1)}%</span>
              </div>
              <div className="property-row">
                <label>Left:</label>
                <span>{cropBounds.left.toFixed(1)}%</span>
              </div>
            </div>
            <button className="action-button" onClick={handleResetCrop}>
              Reset Crop
            </button>
          </div>
        )}

        {/* Appearance Section */}
        <div className="panel-section">
          <h4>Appearance</h4>
          <div className="property-row">
            <label>Opacity:</label>
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              onChange={handleOpacityChange}
              className="property-slider"
            />
            <input
              type="number"
              value={opacity}
              onChange={handleOpacityChange}
              min={0}
              max={100}
              className="property-input small"
            />
            <span className="unit">%</span>
          </div>
        </div>

        {/* Border Section */}
        <div className="panel-section">
          <h4>Border</h4>
          <div className="property-row checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={borderEnabled}
                onChange={handleBorderEnabledChange}
              />
              Enable border
            </label>
          </div>
          {borderEnabled && (
            <>
              <div className="property-row">
                <label>Color:</label>
                <input
                  type="color"
                  value={borderColor}
                  onChange={handleBorderColorChange}
                  className="property-color"
                />
              </div>
              <div className="property-row">
                <label>Width:</label>
                <input
                  type="number"
                  value={borderWidth}
                  onChange={handleBorderWidthChange}
                  min={0}
                  max={20}
                  step={0.5}
                  className="property-input"
                />
                <span className="unit">pt</span>
              </div>
              <div className="property-row">
                <label>Style:</label>
                <select
                  value={borderStyle}
                  onChange={handleBorderStyleChange}
                  className="property-select"
                >
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                </select>
              </div>
              <div className="property-row">
                <label>Radius:</label>
                <input
                  type="number"
                  value={borderRadius}
                  onChange={handleBorderRadiusChange}
                  min={0}
                  max={100}
                  className="property-input"
                />
                <span className="unit">pt</span>
              </div>
            </>
          )}
        </div>

        {/* Image Info Section */}
        <div className="panel-section">
          <h4>Image Info</h4>
          <div className="info-row">
            <label>Filename:</label>
            <span className="info-value" title={filename}>{filename}</span>
          </div>
          <div className="info-row">
            <label>Original Size:</label>
            <span className="info-value">{originalDimensions}</span>
          </div>
          <div className="info-row">
            <label>File Size:</label>
            <span className="info-value">{fileSize}</span>
          </div>
          <div className="info-row">
            <label>Format:</label>
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
          <button className="action-button" onClick={handleReplaceImage}>
            Replace Image
          </button>
          <button className="action-button" onClick={handleResetAll}>
            Reset All
          </button>
          <button className="action-button danger" onClick={handleDelete}>
            Delete Image
          </button>
        </div>
      </div>
    </div>
  );
}
