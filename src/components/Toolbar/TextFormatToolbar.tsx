import { useLocale, t } from "../../i18n";
import { useState, useRef, useEffect } from 'react';
import type { TextStyle } from '../../annotations/types';
import { AVAILABLE_FONTS, FONT_SIZE_PRESETS } from '../../annotations/types';
import './TextFormatToolbar.css';

// Mixed state for when selection has multiple different values for a property
export interface MixedState {
  fontFamily?: boolean;
  fontSize?: boolean;
  fontWeight?: boolean;
  fontStyle?: boolean;
  textDecoration?: boolean;
  color?: boolean;
  backgroundColor?: boolean;
  textAlign?: boolean;
  lineHeight?: boolean;
  letterSpacing?: boolean;
}

interface TextFormatToolbarProps {
  style: Partial<TextStyle>;
  onChange: (style: Partial<TextStyle>) => void;
  onClose?: () => void;
  isMixed?: MixedState;
  hasSelection?: boolean;
}

// Color presets for quick selection
const COLOR_PRESETS = [
  '#000000', '#333333', '#666666', '#999999', '#CCCCCC', '#FFFFFF',
  '#FF0000', '#FF6600', '#FFCC00', '#00FF00', '#00CCFF', '#0066FF',
  '#6600FF', '#FF00FF', '#FF6699', '#996633', '#006633', '#003366',
];

// Line height presets
const LINE_HEIGHT_PRESETS = [1.0, 1.2, 1.4, 1.5, 1.6, 1.8, 2.0] as const;

export function TextFormatToolbar({ style, onChange, onClose, isMixed }: TextFormatToolbarProps) {
  useLocale();
  const [showFontDropdown, setShowFontDropdown] = useState(false);
  const [showSizeDropdown, setShowSizeDropdown] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBgColorPicker, setShowBgColorPicker] = useState(false);
  const [showLineHeightDropdown, setShowLineHeightDropdown] = useState(false);
  const sizeValue = isMixed?.fontSize ? '—' : String(style.fontSize ?? 12);
  const [sizeDraft, setSizeDraft] = useState({ source: sizeValue, value: sizeValue });
  if (sizeDraft.source !== sizeValue) setSizeDraft({ source: sizeValue, value: sizeValue });
  const customSize = sizeDraft.source === sizeValue ? sizeDraft.value : sizeValue;
  const setCustomSize = (value: string) => setSizeDraft({ source: sizeValue, value });
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setShowFontDropdown(false);
        setShowSizeDropdown(false);
        setShowColorPicker(false);
        setShowBgColorPicker(false);
        setShowLineHeightDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFontChange = (fontFamily: string) => {
    onChange({ fontFamily });
    setShowFontDropdown(false);
  };

  const handleSizeChange = (fontSize: number) => {
    onChange({ fontSize });
    setCustomSize(fontSize.toString());
    setShowSizeDropdown(false);
  };

  const handleCustomSizeChange = (value: string) => {
    setCustomSize(value);
    const size = parseInt(value, 10);
    if (!isNaN(size) && size >= 1 && size <= 200) {
      onChange({ fontSize: size });
    }
  };

  const toggleBold = () => {
    onChange({ fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold' });
  };

  const toggleItalic = () => {
    onChange({ fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic' });
  };

  const toggleUnderline = () => {
    onChange({ textDecoration: style.textDecoration === 'underline' ? 'none' : 'underline' });
  };

  const toggleStrikethrough = () => {
    onChange({ textDecoration: style.textDecoration === 'line-through' ? 'none' : 'line-through' });
  };

  const handleAlignChange = (textAlign: TextStyle['textAlign']) => {
    onChange({ textAlign });
  };

  const handleColorChange = (color: string) => {
    onChange({ color });
    setShowColorPicker(false);
  };

  const handleBgColorChange = (backgroundColor: string) => {
    onChange({ backgroundColor });
    setShowBgColorPicker(false);
  };

  const handleLineHeightChange = (lineHeight: number) => {
    onChange({ lineHeight });
    setShowLineHeightDropdown(false);
  };

  const handleLetterSpacingChange = (value: string) => {
    const letterSpacing = parseFloat(value);
    if (!isNaN(letterSpacing) && letterSpacing >= -5 && letterSpacing <= 20) {
      onChange({ letterSpacing });
    }
  };

  return (
    <div className="text-format-toolbar" ref={toolbarRef}>
      {/* Font Family */}
      <div className="format-group">
        <button
          className={`format-dropdown-btn ${isMixed?.fontFamily ? 'mixed' : ''}`}
          onClick={() => {
            setShowFontDropdown(!showFontDropdown);
            setShowSizeDropdown(false);
            setShowColorPicker(false);
            setShowBgColorPicker(false);
          }}
          title={t("m.font.family.694eff")}
        >
          <span className="dropdown-label" style={{ fontFamily: isMixed?.fontFamily ? 'inherit' : style.fontFamily }}>
            {isMixed?.fontFamily ? t("m.multiple.740922") : (style.fontFamily || 'Arial')}
          </span>
          <span className="dropdown-arrow">▼</span>
        </button>
        {showFontDropdown && (
          <div className="format-dropdown">
            {AVAILABLE_FONTS.map((font) => (
              <button
                key={font}
                className={`dropdown-item ${!isMixed?.fontFamily && font === style.fontFamily ? 'active' : ''}`}
                style={{ fontFamily: font }}
                onClick={() => handleFontChange(font)}
              >
                {font}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Font Size */}
      <div className="format-group">
        <button
          className={`format-dropdown-btn size-btn ${isMixed?.fontSize ? 'mixed' : ''}`}
          onClick={() => {
            setShowSizeDropdown(!showSizeDropdown);
            setShowFontDropdown(false);
            setShowColorPicker(false);
            setShowBgColorPicker(false);
          }}
          title={t("m.font.size.b456f4")}
        >
          <input
            type="text"
            className="size-input"
            value={customSize}
            onChange={(e) => handleCustomSizeChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCustomSizeChange(customSize);
                setShowSizeDropdown(false);
              }
            }}
          />
          <span className="dropdown-arrow">▼</span>
        </button>
        {showSizeDropdown && (
          <div className="format-dropdown size-dropdown">
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                key={size}
                className={`dropdown-item ${!isMixed?.fontSize && size === style.fontSize ? 'active' : ''}`}
                onClick={() => handleSizeChange(size)}
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="format-separator" />

      {/* Bold, Italic, Underline, Strikethrough */}
      <div className="format-group style-buttons">
        <button
          className={`format-btn ${style.fontWeight === 'bold' ? 'active' : ''} ${isMixed?.fontWeight ? 'partial' : ''}`}
          onClick={toggleBold}
          title={t("m.bold.ctrl.b.022c0e")}
        >
          <strong>{t("m.b.ae4f28")}</strong>
        </button>
        <button
          className={`format-btn ${style.fontStyle === 'italic' ? 'active' : ''} ${isMixed?.fontStyle ? 'partial' : ''}`}
          onClick={toggleItalic}
          title={t("m.italic.ctrl.i.48bead")}
        >
          <em>{t("m.i.ca73ab")}</em>
        </button>
        <button
          className={`format-btn ${style.textDecoration === 'underline' ? 'active' : ''} ${isMixed?.textDecoration ? 'partial' : ''}`}
          onClick={toggleUnderline}
          title={t("m.underline.ctrl.u.a39b55")}
        >
          <u>{t("m.u.b2c7c0")}</u>
        </button>
        <button
          className={`format-btn ${style.textDecoration === 'line-through' ? 'active' : ''} ${isMixed?.textDecoration ? 'partial' : ''}`}
          onClick={toggleStrikethrough}
          title={t("m.strikethrough.ctrl.shift.x.dc7ae9")}
        >
          <s>{t("m.s.02aa62")}</s>
        </button>
      </div>

      <div className="format-separator" />

      {/* Text Alignment */}
      <div className="format-group align-buttons">
        <button
          className={`format-btn ${style.textAlign === 'left' ? 'active' : ''}`}
          onClick={() => handleAlignChange('left')}
          title={t("m.align.left.9fb06a")}
        >
          &#9776;
        </button>
        <button
          className={`format-btn ${style.textAlign === 'center' ? 'active' : ''}`}
          onClick={() => handleAlignChange('center')}
          title={t("m.align.center.472e0d")}
        >
          &#9783;
        </button>
        <button
          className={`format-btn ${style.textAlign === 'right' ? 'active' : ''}`}
          onClick={() => handleAlignChange('right')}
          title={t("m.align.right.2e324b")}
        >
          &#9782;
        </button>
      </div>

      <div className="format-separator" />

      {/* Line Height */}
      <div className="format-group">
        <button
          className="format-dropdown-btn spacing-btn"
          onClick={() => {
            const newState = !showLineHeightDropdown;
            setShowFontDropdown(false);
            setShowSizeDropdown(false);
            setShowColorPicker(false);
            setShowBgColorPicker(false);
            setShowLineHeightDropdown(newState);
          }}
          title={t("m.line.height.ac3292")}
        >
          <span className="spacing-icon">&#8691;</span>
          <span className="spacing-value">{style.lineHeight?.toFixed(1) || '1.4'}</span>
        </button>
        {showLineHeightDropdown && (
          <div className="format-dropdown spacing-dropdown">
            {LINE_HEIGHT_PRESETS.map((lh) => (
              <button
                key={lh}
                className={`dropdown-item ${lh === style.lineHeight ? 'active' : ''}`}
                onClick={() => handleLineHeightChange(lh)}
              >
                {lh.toFixed(1)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Letter Spacing */}
      <div className="format-group">
        <div className="spacing-input-group" title={t("m.letter.spacing.px.a19ab3")}>
          <span className="spacing-label">{t("m.aa.2c419e")}</span>
          <input
            type="number"
            className="spacing-number-input"
            value={style.letterSpacing || 0}
            min="-5"
            max="20"
            step="0.5"
            onChange={(e) => handleLetterSpacingChange(e.target.value)}
          />
        </div>
      </div>

      <div className="format-separator" />

      {/* Text Color */}
      <div className="format-group">
        <button
          className="format-btn color-btn"
          onClick={() => {
            setShowColorPicker(!showColorPicker);
            setShowBgColorPicker(false);
            setShowFontDropdown(false);
            setShowSizeDropdown(false);
          }}
          title={t("m.text.color.3a53d5")}
        >
          <span className="color-icon">{t("m.a.6dcd4c")}</span>
          <span className="color-indicator" style={{ backgroundColor: style.color }} />
        </button>
        {showColorPicker && (
          <div className="color-picker-dropdown">
            <div className="color-presets">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  className={`color-preset ${color === style.color ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => handleColorChange(color)}
                  title={color}
                />
              ))}
            </div>
            <div className="custom-color">
              <label>{t("m.custom.94f40c")}</label>
              <input
                type="color"
                value={style.color}
                onChange={(e) => handleColorChange(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Background Color */}
      <div className="format-group">
        <button
          className="format-btn color-btn"
          onClick={() => {
            setShowBgColorPicker(!showBgColorPicker);
            setShowColorPicker(false);
            setShowFontDropdown(false);
            setShowSizeDropdown(false);
          }}
          title={t("m.background.color.874df4")}
        >
          <span className="bg-color-icon">&#9632;</span>
          <span
            className="color-indicator"
            style={{
              backgroundColor: style.backgroundColor === 'transparent' ? '#fff' : style.backgroundColor,
              border: style.backgroundColor === 'transparent' ? '1px dashed #999' : 'none',
            }}
          />
        </button>
        {showBgColorPicker && (
          <div className="color-picker-dropdown">
            <button
              className={`transparent-btn ${style.backgroundColor === 'transparent' ? 'active' : ''}`}
              onClick={() => handleBgColorChange('transparent')}
            >
              {t("m.no.fill.transparent.20be58")}</button>
            <div className="color-presets">
              {COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  className={`color-preset ${color === style.backgroundColor ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => handleBgColorChange(color)}
                  title={color}
                />
              ))}
            </div>
            <div className="custom-color">
              <label>{t("m.custom.94f40c")}</label>
              <input
                type="color"
                value={style.backgroundColor === 'transparent' ? '#ffffff' : style.backgroundColor}
                onChange={(e) => handleBgColorChange(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {onClose && (
        <>
          <div className="format-separator" />
          <button className="format-btn close-btn" onClick={onClose} title={t("m.close.bbfa77")}>
            ✕
          </button>
        </>
      )}
    </div>
  );
}
