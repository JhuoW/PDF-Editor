import { useCallback } from 'react';
import type { FreeTextAnnotation, TextStyle } from '../../annotations/types';
import { AVAILABLE_FONTS, FONT_SIZE_PRESETS, DEFAULT_TEXT_STYLE } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './TextPropertiesPanel.css';

interface TextPropertiesPanelProps {
  annotation: FreeTextAnnotation;
  onClose?: () => void;
}

// Color presets
const COLOR_PRESETS = [
  '#000000', '#333333', '#666666', '#999999',
  '#FF0000', '#FF6600', '#FFCC00', '#00FF00',
  '#00CCFF', '#0066FF', '#6600FF', '#FF00FF',
];

export function TextPropertiesPanel({ annotation, onClose }: TextPropertiesPanelProps) {
  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  const style: TextStyle = annotation.style || DEFAULT_TEXT_STYLE;

  // Update style with undo support
  const handleStyleChange = useCallback(
    (updates: Partial<TextStyle>) => {
      const previousState = { ...annotation };
      const newStyle = { ...style, ...updates };
      updateAnnotation(annotation.id, { style: newStyle });
      recordUpdate({ ...annotation, style: newStyle }, previousState);
    },
    [annotation, style, updateAnnotation, recordUpdate]
  );

  return (
    <div className="text-properties-panel">
      <div className="panel-header">
        <h3>Text Properties</h3>
        {onClose && (
          <button className="close-btn" onClick={onClose} title="Close">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* Font Family */}
        <div className="property-group">
          <label>Font</label>
          <select
            value={style.fontFamily}
            onChange={(e) => handleStyleChange({ fontFamily: e.target.value })}
          >
            {AVAILABLE_FONTS.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div className="property-group">
          <label>Size</label>
          <div className="size-input-group">
            <select
              value={style.fontSize}
              onChange={(e) => handleStyleChange({ fontSize: parseInt(e.target.value, 10) })}
              className="size-select"
            >
              {FONT_SIZE_PRESETS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={style.fontSize}
              min={1}
              max={200}
              onChange={(e) => {
                const size = parseInt(e.target.value, 10);
                if (!isNaN(size) && size >= 1 && size <= 200) {
                  handleStyleChange({ fontSize: size });
                }
              }}
              className="size-input"
            />
            <span className="unit">pt</span>
          </div>
        </div>

        {/* Font Style Buttons */}
        <div className="property-group">
          <label>Style</label>
          <div className="style-buttons">
            <button
              className={`style-btn ${style.fontWeight === 'bold' ? 'active' : ''}`}
              onClick={() =>
                handleStyleChange({ fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold' })
              }
              title="Bold (Ctrl+B)"
            >
              <strong>B</strong>
            </button>
            <button
              className={`style-btn ${style.fontStyle === 'italic' ? 'active' : ''}`}
              onClick={() =>
                handleStyleChange({ fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic' })
              }
              title="Italic (Ctrl+I)"
            >
              <em>I</em>
            </button>
            <button
              className={`style-btn ${style.textDecoration === 'underline' ? 'active' : ''}`}
              onClick={() =>
                handleStyleChange({
                  textDecoration: style.textDecoration === 'underline' ? 'none' : 'underline',
                })
              }
              title="Underline (Ctrl+U)"
            >
              <u>U</u>
            </button>
            <button
              className={`style-btn ${style.textDecoration === 'line-through' ? 'active' : ''}`}
              onClick={() =>
                handleStyleChange({
                  textDecoration: style.textDecoration === 'line-through' ? 'none' : 'line-through',
                })
              }
              title="Strikethrough"
            >
              <s>S</s>
            </button>
          </div>
        </div>

        {/* Text Color */}
        <div className="property-group">
          <label>Color</label>
          <div className="color-picker-row">
            <input
              type="color"
              value={style.color}
              onChange={(e) => handleStyleChange({ color: e.target.value })}
              className="color-input"
            />
            <input
              type="text"
              value={style.color}
              onChange={(e) => handleStyleChange({ color: e.target.value })}
              className="color-text"
              pattern="^#[0-9A-Fa-f]{6}$"
            />
          </div>
          <div className="color-presets">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                className={`color-preset ${color === style.color ? 'active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => handleStyleChange({ color })}
                title={color}
              />
            ))}
          </div>
        </div>

        {/* Text Alignment */}
        <div className="property-group">
          <label>Alignment</label>
          <div className="align-buttons">
            <button
              className={`align-btn ${style.textAlign === 'left' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'left' })}
              title="Align Left (Ctrl+L)"
            >
              &#9776;
            </button>
            <button
              className={`align-btn ${style.textAlign === 'center' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'center' })}
              title="Align Center (Ctrl+E)"
            >
              &#9783;
            </button>
            <button
              className={`align-btn ${style.textAlign === 'right' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'right' })}
              title="Align Right (Ctrl+R)"
            >
              &#9782;
            </button>
            <button
              className={`align-btn ${style.textAlign === 'justify' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'justify' })}
              title="Justify (Ctrl+J)"
            >
              &#9781;
            </button>
          </div>
        </div>

        {/* Vertical Alignment */}
        <div className="property-group">
          <label>Vertical Align</label>
          <select
            value={style.verticalAlign}
            onChange={(e) =>
              handleStyleChange({ verticalAlign: e.target.value as TextStyle['verticalAlign'] })
            }
          >
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>

        {/* Line Height */}
        <div className="property-group">
          <label>Line Height</label>
          <div className="slider-group">
            <input
              type="range"
              min="1"
              max="3"
              step="0.1"
              value={style.lineHeight}
              onChange={(e) => handleStyleChange({ lineHeight: parseFloat(e.target.value) })}
              className="slider"
            />
            <input
              type="number"
              value={style.lineHeight?.toFixed(1) || '1.4'}
              min={1}
              max={3}
              step={0.1}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= 1 && val <= 3) {
                  handleStyleChange({ lineHeight: val });
                }
              }}
              className="slider-value"
            />
          </div>
        </div>

        {/* Letter Spacing */}
        <div className="property-group">
          <label>Letter Spacing</label>
          <div className="slider-group">
            <input
              type="range"
              min="-5"
              max="20"
              step="0.5"
              value={style.letterSpacing || 0}
              onChange={(e) => handleStyleChange({ letterSpacing: parseFloat(e.target.value) })}
              className="slider"
            />
            <input
              type="number"
              value={style.letterSpacing || 0}
              min={-5}
              max={20}
              step={0.5}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val) && val >= -5 && val <= 20) {
                  handleStyleChange({ letterSpacing: val });
                }
              }}
              className="slider-value"
            />
            <span className="unit">px</span>
          </div>
        </div>
      </div>
    </div>
  );
}
