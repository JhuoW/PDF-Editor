import { useLocale, t } from "../../i18n";
import { useCallback, useId } from 'react';
import type { FreeTextAnnotation, TextStyle } from '../../annotations/types';
import { AVAILABLE_FONTS, FONT_SIZE_PRESETS, DEFAULT_TEXT_STYLE } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import { useTextBoxStore } from '../../store/textBoxStore';
import { parseTipTapHTML, segmentsToTipTapHTML } from '../../utils/tiptapConverter';
import { AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';
import { PropertyNumberInput, PropertyColorInput } from '../Workspace/PropertyInput';
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
  const id = useId();
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

  // Inspector properties apply to the whole text box. Rich-text marks must be
  // updated too, otherwise their explicit values silently override this style.
  const handleStyleChange = useCallback((updates: Partial<TextStyle>) => {
    const previous = useAnnotationStore.getState().getAllAnnotations().find(item => item.id === annotation.id);
    if (!previous || previous.type !== 'freetext') return;
    const previousStyle = previous.style || DEFAULT_TEXT_STYLE;
    const style = { ...previousStyle, ...updates };
    const originalSegments = previous.richContent ?? (previous.htmlContent ? parseTipTapHTML(previous.htmlContent, previousStyle) : [{ text: previous.content, style: previousStyle }]);
    const richContent = originalSegments.map(segment => ({ ...segment, style: { ...segment.style, ...updates } }));
    const htmlContent = segmentsToTipTapHTML(richContent, style);
    const updated = { ...previous, style, richContent, htmlContent };
    updateAnnotation(previous.id, updated);
    recordUpdate(updated, previous);
    // Keep an open editor in sync so its later blur cannot restore old marks.
    const editor = useTextBoxStore.getState().tiptapEditor;
    if (editor && !editor.isDestroyed && editor.view.dom.closest<HTMLElement>('[data-editing-annotation-id]')?.dataset.editingAnnotationId === previous.id) {
      const { from, to } = editor.state.selection;
      editor.commands.setContent(htmlContent, { emitUpdate: false });
      editor.commands.setTextSelection({ from: Math.min(from, editor.state.doc.content.size), to: Math.min(to, editor.state.doc.content.size) });
      Object.assign(editor.view.dom.style, { fontFamily: style.fontFamily, fontSize: `${style.fontSize}px`, color: style.color,
        lineHeight: String(style.lineHeight), letterSpacing: `${style.letterSpacing}px`, textAlign: style.textAlign });
    }
  }, [annotation.id, updateAnnotation, recordUpdate]);

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
          <button className="close-btn" onClick={onClose} title={t("m.close.bbfa77")} aria-label={t("m.close.bbfa77")}>
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* Font Family */}
        <div className="property-group">
          <label htmlFor={`${id}-font`}>{t("m.font.b97c4d")}</label>
          <select id={`${id}-font`}
            value={isMixed.fontFamily ? '' : currentStyle.fontFamily}
            onChange={(e) => {
              if (e.target.value) handleStyleChange({ fontFamily: e.target.value });
            }}
          >
            {isMixed.fontFamily && <option value="" disabled>{t("m.multiple.d28149")}</option>}
            {!AVAILABLE_FONTS.some(font => font === currentStyle.fontFamily) && <option value={currentStyle.fontFamily}>{currentStyle.fontFamily}</option>}
            {AVAILABLE_FONTS.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div className="property-group">
          <label htmlFor={`${id}-size`}>{t("m.size.b71523")}</label>
          <div className="size-input-group">
            <select id={`${id}-size`}
              value={currentStyle.fontSize}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (!isNaN(val)) handleStyleChange({ fontSize: val });
              }}
              className="size-select"
            >
              {isMixed.fontSize && <option value="" disabled>--</option>}
              {!FONT_SIZE_PRESETS.some(size => size === currentStyle.fontSize) && <option value={currentStyle.fontSize}>{currentStyle.fontSize}</option>}
              {FONT_SIZE_PRESETS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <PropertyNumberInput aria-label={t("properties.customFontSize")}
              value={currentStyle.fontSize}
              placeholder={isMixed.fontSize ? '--' : ''}
              min={1}
              max={200}
              onCommit={fontSize => handleStyleChange({ fontSize })}
              className="size-input"
            />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
        </div>

        {/* Font Style Buttons */}
        <div className="property-group">
          <label id={`${id}-style-label`}>{t("m.style.99a0ef")}</label>
          <div className="style-buttons" role="group" aria-labelledby={`${id}-style-label`}>
            <button
              aria-pressed={currentStyle.fontWeight === 'bold'}
              className={getBtnClass(currentStyle.fontWeight === 'bold', isMixed.fontWeight)}
              onClick={() =>
                handleStyleChange({ fontWeight: currentStyle.fontWeight === 'bold' ? 'normal' : 'bold' })
              }
              title={t("m.bold.ctrl.b.022c0e")}
            >
              <strong>{t("m.b.ae4f28")}</strong>
            </button>
            <button
              aria-pressed={currentStyle.fontStyle === 'italic'}
              className={getBtnClass(currentStyle.fontStyle === 'italic', isMixed.fontStyle)}
              onClick={() =>
                handleStyleChange({ fontStyle: currentStyle.fontStyle === 'italic' ? 'normal' : 'italic' })
              }
              title={t("m.italic.ctrl.i.48bead")}
            >
              <em>{t("m.i.ca73ab")}</em>
            </button>
            <button
              aria-pressed={currentStyle.textDecoration === 'underline'}
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
              aria-pressed={currentStyle.textDecoration === 'line-through'}
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
          <label htmlFor={`${id}-color`}>{t("m.color.1d0c83")}</label>
          <div className="color-picker-row">
            <input id={`${id}-color`}
              type="color"
              value={currentStyle.color}
              onChange={(e) => handleStyleChange({ color: e.target.value })}
              className="color-input"
            />
            <PropertyColorInput aria-label={t("properties.colorValue")}
              value={currentStyle.color}
              onCommit={color => handleStyleChange({ color })}
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
                aria-pressed={color === currentStyle.color}
              />
            ))}
          </div>
        </div>

        {/* Text Alignment */}
        <div className="property-group">
          <label id={`${id}-alignment-label`}>{t("m.alignment.7f8c51")}</label>
          <div className="align-buttons" role="group" aria-labelledby={`${id}-alignment-label`}>
            <button
              aria-pressed={currentStyle.textAlign === 'left'}
              className={`align-btn ${currentStyle.textAlign === 'left' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'left' })}
              title={t("m.align.left.ctrl.l.8e8017")}
            >
              <AlignLeft size={16} aria-hidden="true" />
            </button>
            <button
              aria-pressed={currentStyle.textAlign === 'center'}
              className={`align-btn ${currentStyle.textAlign === 'center' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'center' })}
              title={t("m.align.center.ctrl.e.9f0b3d")}
            >
              <AlignCenter size={16} aria-hidden="true" />
            </button>
            <button
              aria-pressed={currentStyle.textAlign === 'right'}
              className={`align-btn ${currentStyle.textAlign === 'right' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'right' })}
              title={t("m.align.right.ctrl.r.3b9272")}
            >
              <AlignRight size={16} aria-hidden="true" />
            </button>
            <button
              aria-pressed={currentStyle.textAlign === 'justify'}
              className={`align-btn ${currentStyle.textAlign === 'justify' ? 'active' : ''}`}
              onClick={() => handleStyleChange({ textAlign: 'justify' })}
              title={t("m.justify.ctrl.j.108611")}
            >
              <AlignJustify size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Vertical Alignment */}
        <div className="property-group">
          <label htmlFor={`${id}-vertical`}>{t("m.vertical.align.22ca5a")}</label>
          <select id={`${id}-vertical`}
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
          <label htmlFor={`${id}-leading`}>{t("m.line.height.ac3292")}</label>
          <div className="slider-group">
            <input id={`${id}-leading`}
              type="range"
              min="1"
              max="3"
              step="0.1"
              value={currentStyle.lineHeight || 1.4}
              onChange={(e) => handleStyleChange({ lineHeight: parseFloat(e.target.value) })}
              className="slider"
            />
            <PropertyNumberInput aria-label={t("m.line.height.ac3292")}
              value={currentStyle.lineHeight || 1.4}
              min={1}
              max={3}
              step={0.1}
              onCommit={lineHeight => handleStyleChange({ lineHeight })}
              className="slider-value"
            />
          </div>
        </div>

        {/* Letter Spacing */}
        <div className="property-group">
          <label htmlFor={`${id}-spacing`}>{t("m.letter.spacing.65346e")}</label>
          <div className="slider-group">
            <input id={`${id}-spacing`}
              type="range"
              min="-5"
              max="20"
              step="0.5"
              value={currentStyle.letterSpacing || 0}
              onChange={(e) => handleStyleChange({ letterSpacing: parseFloat(e.target.value) })}
              className="slider"
            />
            <PropertyNumberInput aria-label={t("m.letter.spacing.65346e")}
              value={currentStyle.letterSpacing || 0}
              min={-5}
              max={20}
              step={0.5}
              onCommit={letterSpacing => handleStyleChange({ letterSpacing })}
              className="slider-value"
            />
            <span className="unit">{t("m.px.07a65d")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
