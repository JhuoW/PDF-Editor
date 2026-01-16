import { useCallback, useState } from 'react';
import type { FreeTextAnnotation, BoxStyle } from '../../annotations/types';
import { DEFAULT_BOX_STYLE } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './BoxPropertiesPanel.css';

interface BoxPropertiesPanelProps {
  annotation: FreeTextAnnotation;
  onClose?: () => void;
}

// Color presets
const COLOR_PRESETS = [
  'transparent', '#FFFFFF', '#F5F5F5', '#E0E0E0',
  '#FFE0E0', '#FFF0D0', '#E0FFE0', '#E0F0FF',
  '#F0E0FF', '#FFE0F0', '#000000', '#333333',
];

const BORDER_STYLES: BoxStyle['borderStyle'][] = ['solid', 'dashed', 'dotted', 'none'];

export function BoxPropertiesPanel({ annotation, onClose }: BoxPropertiesPanelProps) {
  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  const boxStyle: BoxStyle = annotation.boxStyle || DEFAULT_BOX_STYLE;
  const [linkPadding, setLinkPadding] = useState(true);
  const [lockAspectRatio, setLockAspectRatio] = useState(false);

  // Update box style with undo support
  const handleBoxStyleChange = useCallback(
    (updates: Partial<BoxStyle>) => {
      const previousState = { ...annotation };
      const newBoxStyle = { ...boxStyle, ...updates };
      updateAnnotation(annotation.id, { boxStyle: newBoxStyle });
      recordUpdate({ ...annotation, boxStyle: newBoxStyle }, previousState);
    },
    [annotation, boxStyle, updateAnnotation, recordUpdate]
  );

  // Update rect with undo support
  const handleRectChange = useCallback(
    (newRect: [number, number, number, number]) => {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { rect: newRect });
      recordUpdate({ ...annotation, rect: newRect }, previousState);
    },
    [annotation, updateAnnotation, recordUpdate]
  );

  // Update rotation with undo support
  const handleRotationChange = useCallback(
    (rotation: number) => {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { rotation });
      recordUpdate({ ...annotation, rotation }, previousState);
    },
    [annotation, updateAnnotation, recordUpdate]
  );

  // Handle dimension change with aspect ratio lock
  const handleDimensionChange = useCallback(
    (dimension: 'width' | 'height', value: number) => {
      const [x, y, width, height] = annotation.rect;

      if (lockAspectRatio && width > 0 && height > 0) {
        const aspectRatio = width / height;
        if (dimension === 'width') {
          const newHeight = value / aspectRatio;
          handleRectChange([x, y, value, newHeight]);
        } else {
          const newWidth = value * aspectRatio;
          handleRectChange([x, y, newWidth, value]);
        }
      } else {
        if (dimension === 'width') {
          handleRectChange([x, y, value, height]);
        } else {
          handleRectChange([x, y, width, value]);
        }
      }
    },
    [annotation.rect, lockAspectRatio, handleRectChange]
  );

  // Handle padding change with link option
  const handlePaddingChange = useCallback(
    (side: 'top' | 'right' | 'bottom' | 'left', value: number) => {
      const padding = boxStyle.padding || { top: 8, right: 8, bottom: 8, left: 8 };

      if (linkPadding) {
        // Apply same value to all sides
        handleBoxStyleChange({
          padding: { top: value, right: value, bottom: value, left: value },
        });
      } else {
        handleBoxStyleChange({
          padding: { ...padding, [side]: value },
        });
      }
    },
    [boxStyle.padding, linkPadding, handleBoxStyleChange]
  );

  const [x, y, width, height] = annotation.rect;
  const rotation = annotation.rotation || 0;

  return (
    <div className="box-properties-panel">
      <div className="panel-header">
        <h3>Box Properties</h3>
        {onClose && (
          <button className="close-btn" onClick={onClose} title="Close">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* Position */}
        <div className="property-section">
          <div className="section-title">Position</div>
          <div className="position-grid">
            <div className="position-field">
              <label>X</label>
              <input
                type="number"
                value={x.toFixed(1)}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    handleRectChange([val, y, width, height]);
                  }
                }}
              />
              <span className="unit">pt</span>
            </div>
            <div className="position-field">
              <label>Y</label>
              <input
                type="number"
                value={y.toFixed(1)}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    handleRectChange([x, val, width, height]);
                  }
                }}
              />
              <span className="unit">pt</span>
            </div>
          </div>
        </div>

        {/* Size */}
        <div className="property-section">
          <div className="section-title">Size</div>
          <div className="size-grid">
            <div className="size-field">
              <label>W</label>
              <input
                type="number"
                value={width.toFixed(1)}
                min={20}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 20) {
                    handleDimensionChange('width', val);
                  }
                }}
              />
              <span className="unit">pt</span>
            </div>
            <div className="size-field">
              <label>H</label>
              <input
                type="number"
                value={height.toFixed(1)}
                min={20}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 20) {
                    handleDimensionChange('height', val);
                  }
                }}
              />
              <span className="unit">pt</span>
            </div>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={lockAspectRatio}
              onChange={(e) => setLockAspectRatio(e.target.checked)}
            />
            Lock aspect ratio
          </label>
        </div>

        {/* Rotation */}
        <div className="property-section">
          <div className="section-title">Rotation</div>
          <div className="rotation-field">
            <input
              type="number"
              value={rotation}
              min={0}
              max={360}
              step={1}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  handleRotationChange(((val % 360) + 360) % 360);
                }
              }}
            />
            <span className="unit">°</span>
            <div className="rotation-presets">
              <button onClick={() => handleRotationChange(0)} title="0°">0</button>
              <button onClick={() => handleRotationChange(90)} title="90°">90</button>
              <button onClick={() => handleRotationChange(180)} title="180°">180</button>
              <button onClick={() => handleRotationChange(270)} title="270°">270</button>
            </div>
          </div>
        </div>

        {/* Background */}
        <div className="property-section">
          <div className="section-title">Background</div>
          <div className="color-row">
            <label>Color</label>
            <div className="color-input-group">
              {boxStyle.backgroundColor !== 'transparent' ? (
                <input
                  type="color"
                  value={boxStyle.backgroundColor}
                  onChange={(e) => handleBoxStyleChange({ backgroundColor: e.target.value })}
                  className="color-input"
                />
              ) : (
                <div className="transparent-indicator" title="Transparent" />
              )}
              <input
                type="text"
                value={boxStyle.backgroundColor}
                onChange={(e) => handleBoxStyleChange({ backgroundColor: e.target.value })}
                className="color-text"
              />
            </div>
          </div>
          <div className="color-presets">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                className={`color-preset ${color === boxStyle.backgroundColor ? 'active' : ''} ${color === 'transparent' ? 'transparent' : ''}`}
                style={{ backgroundColor: color === 'transparent' ? 'white' : color }}
                onClick={() => handleBoxStyleChange({ backgroundColor: color })}
                title={color}
              />
            ))}
          </div>
          <div className="opacity-row">
            <label>Opacity</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={boxStyle.backgroundOpacity ?? 1}
              onChange={(e) =>
                handleBoxStyleChange({ backgroundOpacity: parseFloat(e.target.value) })
              }
              className="opacity-slider"
            />
            <span className="opacity-value">{Math.round((boxStyle.backgroundOpacity ?? 1) * 100)}%</span>
          </div>
        </div>

        {/* Border */}
        <div className="property-section">
          <div className="section-title">Border</div>
          <div className="border-row">
            <label>Color</label>
            <div className="color-input-group">
              <input
                type="color"
                value={boxStyle.borderColor || '#000000'}
                onChange={(e) => handleBoxStyleChange({ borderColor: e.target.value })}
                className="color-input"
              />
              <input
                type="text"
                value={boxStyle.borderColor || '#000000'}
                onChange={(e) => handleBoxStyleChange({ borderColor: e.target.value })}
                className="color-text"
              />
            </div>
          </div>
          <div className="border-grid">
            <div className="border-field">
              <label>Width</label>
              <input
                type="number"
                value={boxStyle.borderWidth ?? 1}
                min={0}
                max={20}
                step={0.5}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0 && val <= 20) {
                    handleBoxStyleChange({ borderWidth: val });
                  }
                }}
              />
              <span className="unit">pt</span>
            </div>
            <div className="border-field">
              <label>Style</label>
              <select
                value={boxStyle.borderStyle || 'solid'}
                onChange={(e) =>
                  handleBoxStyleChange({ borderStyle: e.target.value as BoxStyle['borderStyle'] })
                }
              >
                {BORDER_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style.charAt(0).toUpperCase() + style.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="border-radius-row">
            <label>Radius</label>
            <input
              type="number"
              value={boxStyle.borderRadius ?? 0}
              min={0}
              max={100}
              step={1}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 0 && val <= 100) {
                  handleBoxStyleChange({ borderRadius: val });
                }
              }}
            />
            <span className="unit">pt</span>
          </div>
        </div>

        {/* Padding */}
        <div className="property-section">
          <div className="section-title">
            Padding
            <button
              className={`link-btn ${linkPadding ? 'active' : ''}`}
              onClick={() => setLinkPadding(!linkPadding)}
              title={linkPadding ? 'Unlink sides' : 'Link all sides'}
            >
              {linkPadding ? '🔗' : '⛓️‍💥'}
            </button>
          </div>
          <div className="padding-grid">
            <div className="padding-field top">
              <label>T</label>
              <input
                type="number"
                value={boxStyle.padding?.top ?? 8}
                min={0}
                max={100}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0) {
                    handlePaddingChange('top', val);
                  }
                }}
              />
            </div>
            <div className="padding-field right">
              <label>R</label>
              <input
                type="number"
                value={boxStyle.padding?.right ?? 8}
                min={0}
                max={100}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0) {
                    handlePaddingChange('right', val);
                  }
                }}
              />
            </div>
            <div className="padding-field bottom">
              <label>B</label>
              <input
                type="number"
                value={boxStyle.padding?.bottom ?? 8}
                min={0}
                max={100}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0) {
                    handlePaddingChange('bottom', val);
                  }
                }}
              />
            </div>
            <div className="padding-field left">
              <label>L</label>
              <input
                type="number"
                value={boxStyle.padding?.left ?? 8}
                min={0}
                max={100}
                step={1}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0) {
                    handlePaddingChange('left', val);
                  }
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
