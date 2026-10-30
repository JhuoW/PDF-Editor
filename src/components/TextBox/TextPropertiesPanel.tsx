import { useLocale, t } from "../../i18n";
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
  useLocale();
  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  // Use the annotation's style (default style for the text box)
  const currentStyle = annotation.style || DEFAULT_TEXT_STYLE;

  // No mixed state tracking needed since we're editing the default style
  const isMixed = {
    fontFamily: false,
    fontSize: false,
    fontWeight: false,
    fontStyle: false,
    textDecoration: false,
    color: false,
  };

  // Handle style updates to the annotation's default style
  const handleStyleChange = useCallback((updates: Partial<TextStyle>) => {
    const previousState = { ...annotation };
    const newStyle = { ...(annotation.style || DEFAULT_TEXT_STYLE), ...updates };
    updateAnnotation(annotation.id, { style: newStyle });
    recordUpdate({ ...annotation, style: newStyle }, previousState);
  }, [annotation, updateAnnotation, recordUpdate]);

  // Helper for button classes
  const getBtnClass = (isActive: boolean, isMixedState: boolean) => {
    if (isActive) return 'style-btn active';
    if (isMixedState) return 'style-btn partial';
    return 'style-btn';
  };

  return (
    <div className="text-properties-panel" data-format-toolbar="true">
      <div className="panel-header">
        <h3>{t("m.text.properties.cab6f2")}</h3>
        {onClose && (
          <button className="close-btn" onClick={onClose} title={t("m.close.bbfa77")}>
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* Font Family */}
        <div className="property-group">
          <label>{t("m.font.b97c4d")}</label>
          <select
            value={isMixed.fontFamily ? '' : currentStyle.fontFamily}
            onChange={(e) => {
              if (e.target.value) handleStyleChange({ fontFamily: e.target.value });
            }}
          >
            {isMixed.fontFamily && <option value="" disabled>{t("m.multiple.d28149")}</option>}
            {AVAILABLE_FONTS.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div className="property-group">
          <label>{t("m.size.b71523")}</label>
          <div className="size-input-group">
            <select
              value={isMixed.fontSize ? '' : currentStyle.fontSize}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) handleStyleChange({ fontSize: val });
              }}
              className="size-select"
            >
              {isMixed.fontSize && <option value="" disabled>--</option>}
              {FONT_SIZE_PRESETS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={isMixed.fontSize ? '' : currentStyle.fontSize}
              placeholder={isMixed.fontSize ? '--' : ''}
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
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
        </div>

        {/* Font Style Buttons */}
        <div className="property-group">
          <label>{t("m.style.99a0ef")}</label>
          <div className="style-buttons">
            <button
              className={getBtnClass(currentStyle.fontWeight === 'bold', isMixed.fontWeight)}
              onClick={() =>
                handleStyleChange({ fontWeight: currentStyle.fontWeight === 'bold' ? 'normal' : 'bold' })
              }
              title={t("m.bold.ctrl.b.022c0e")}
            >
              <strong>{t("m.b.ae4f28")}</strong>
            </button>
            <button
              className={getBtnClass(currentStyle.fontStyle === 'italic', isMixed.fontStyle)}
              onClick={() =>
                handleStyleChange({ fontStyle: currentStyle.fontStyle === 'italic' ? 'normal' : 'italic' })
              }
              title={t("m.italic.ctrl.i.48bead")}
            >
              <em>{t("m.i.ca73ab")}</em>
            </button>
            <button
              className={getBtnClass(currentStyle.textDecoration === 'underline', isMixed.textDecoration)}
              onClick={() =>
                handleStyleChange({
                  textDecoration: currentStyle.textDecoration === 'underline' ? 'none' : 'underline',
                })
              }
              title={t("m.underline.ctrl.u.a39b55")}
            >
              <u>{t("m.u.b2c7c0")}</u>
            </button>
            <button
              className={getBtnClass(currentStyle.textDecoration === 'line-through', isMixed.textDecoration)}
              onClick={() =>
                handleStyleChange({
                  textDecoration: currentStyle.textDecoration === 'line-through' ? 'none' : 'line-through',
                })
              }
              title={t("m.strikethrough.a93b9a")}
            >
              <s>{t("m.s.02aa62")}</s>
            </button>
          </div>
        </div>

        {/* Text Color */}
        <div className="property-group">
          <label>{t("m.color.1d0c83")}</label>
          <div className="color-picker-row">
            <input
              type="color"
              value={currentStyle.color}
              onChange={(e) => handleStyleChange({ color: e.target.value })}
              className="color-input"
            />
            <input
              type="text"
              value={isMixed.color ? 'Mixed' : currentStyle.color}
              onChange={(e) => handleStyleChange({ color: e.target.value })}
              className="color-text"
              pattern="^#[0-9A-Fa-f]{6}$"
            />
          </div>
          <div className="color-presets">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                className={`color-preset ${color === currentStyle.color ? 'active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => handleStyleChange({ color })}
                title={color}
              />
            ))}
          </div>
        </div>

        {/* Text Alignment */}
        <div className="property-group">
          <label>{t("m.alignment.7f8c51")}</label>
          <div className="align-buttons">
            <button
              className={`align-btn ${currentStyle.textAlign === 'left' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'left' })}
              title={t("m.align.left.ctrl.l.8e8017")}
            >
              &#9776;
            </button>
            <button
              className={`align-btn ${currentStyle.textAlign === 'center' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'center' })}
              title={t("m.align.center.ctrl.e.9f0b3d")}
            >
              &#9783;
            </button>
            <button
              className={`align-btn ${currentStyle.textAlign === 'right' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'right' })}
              title={t("m.align.right.ctrl.r.3b9272")}
            >
              &#9782;
            </button>
            <button
              className={`align-btn ${currentStyle.textAlign === 'justify' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'justify' })}
              title={t("m.justify.ctrl.j.108611")}
            >
              &#9781;
            </button>
          </div>
        </div>

        {/* Vertical Alignment */}
        <div className="property-group">
          <label>{t("m.vertical.align.22ca5a")}</label>
          <select
            value={currentStyle.verticalAlign}
            onChange={(e) =>
              handleStyleChange({ verticalAlign: e.target.value as TextStyle['verticalAlign'] })
            }
          >
            <option value="top">{t("m.top.cae043")}</option>
            <option value="middle">{t("m.middle.ced028")}</option>
            <option value="bottom">{t("m.bottom.cce7f2")}</option>
          </select>
        </div>

        {/* Line Height */}
        <div className="property-group">
          <label>{t("m.line.height.ac3292")}</label>
          <div className="slider-group">
            <input
              type="range"
              min="1"
              max="3"
              step="0.1"
              value={currentStyle.lineHeight || 1.4}
              onChange={(e) => handleStyleChange({ lineHeight: parseFloat(e.target.value) })}
              className="slider"
            />
            <input
              type="number"
              value={currentStyle.lineHeight?.toFixed(1) || '1.4'}
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
          <label>{t("m.letter.spacing.65346e")}</label>
          <div className="slider-group">
            <input
              type="range"
              min="-5"
              max="20"
              step="0.5"
              value={currentStyle.letterSpacing || 0}
              onChange={(e) => handleStyleChange({ letterSpacing: parseFloat(e.target.value) })}
              className="slider"
            />
            <input
              type="number"
              value={currentStyle.letterSpacing || 0}
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
            <span className="unit">{t("m.px.07a65d")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
