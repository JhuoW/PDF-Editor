import { useState, useRef, useEffect } from 'react';
import type { TextStyle } from '../../annotations/types';
import { AVAILABLE_FONTS, FONT_SIZE_PRESETS } from '../../annotations/types';
import './TextFormatToolbar.css';

interface TextFormatToolbarProps {
  style: TextStyle;
  onChange: (style: Partial<TextStyle>) => void;
  onClose?: () => void;
}

// Color presets for quick selection
const COLOR_PRESETS = [
  '#000000', '#333333', '#666666', '#999999', '#CCCCCC', '#FFFFFF',
  '#FF0000', '#FF6600', '#FFCC00', '#00FF00', '#00CCFF', '#0066FF',
  '#6600FF', '#FF00FF', '#FF6699', '#996633', '#006633', '#003366',
];

export function TextFormatToolbar({ style, onChange, onClose }: TextFormatToolbarProps) {
  const [showFontDropdown, setShowFontDropdown] = useState(false);
  const [showSizeDropdown, setShowSizeDropdown] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showBgColorPicker, setShowBgColorPicker] = useState(false);
  const [customSize, setCustomSize] = useState(style.fontSize.toString());
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setShowFontDropdown(false);
        setShowSizeDropdown(false);
        setShowColorPicker(false);
        setShowBgColorPicker(false);
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

  return (
    <div className="text-format-toolbar" ref={toolbarRef}>
      {/* Font Family */}
      <div className="format-group">
        <button
          className="format-dropdown-btn"
          onClick={() => {
            setShowFontDropdown(!showFontDropdown);
            setShowSizeDropdown(false);
            setShowColorPicker(false);
            setShowBgColorPicker(false);
          }}
          title="Font Family"
        >
          <span className="dropdown-label" style={{ fontFamily: style.fontFamily }}>
            {style.fontFamily}
          </span>
          <span className="dropdown-arrow">▼</span>
        </button>
        {showFontDropdown && (
          <div className="format-dropdown">
            {AVAILABLE_FONTS.map((font) => (
              <button
                key={font}
                className={`dropdown-item ${font === style.fontFamily ? 'active' : ''}`}
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
          className="format-dropdown-btn size-btn"
          onClick={() => {
            setShowSizeDropdown(!showSizeDropdown);
            setShowFontDropdown(false);
            setShowColorPicker(false);
            setShowBgColorPicker(false);
          }}
          title="Font Size"
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
                className={`dropdown-item ${size === style.fontSize ? 'active' : ''}`}
                onClick={() => handleSizeChange(size)}
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="format-separator" />

      {/* Bold, Italic, Underline */}
      <div className="format-group style-buttons">
        <button
          className={`format-btn ${style.fontWeight === 'bold' ? 'active' : ''}`}
          onClick={toggleBold}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </button>
        <button
          className={`format-btn ${style.fontStyle === 'italic' ? 'active' : ''}`}
          onClick={toggleItalic}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </button>
        <button
          className={`format-btn ${style.textDecoration === 'underline' ? 'active' : ''}`}
          onClick={toggleUnderline}
          title="Underline (Ctrl+U)"
        >
          <u>U</u>
        </button>
      </div>

      <div className="format-separator" />

      {/* Text Alignment */}
      <div className="format-group align-buttons">
        <button
          className={`format-btn ${style.textAlign === 'left' ? 'active' : ''}`}
          onClick={() => handleAlignChange('left')}
          title="Align Left"
        >
          &#9776;
        </button>
        <button
          className={`format-btn ${style.textAlign === 'center' ? 'active' : ''}`}
          onClick={() => handleAlignChange('center')}
          title="Align Center"
        >
          &#9783;
        </button>
        <button
          className={`format-btn ${style.textAlign === 'right' ? 'active' : ''}`}
          onClick={() => handleAlignChange('right')}
          title="Align Right"
        >
          &#9782;
        </button>
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
          title="Text Color"
        >
          <span className="color-icon">A</span>
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
              <label>Custom:</label>
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
          title="Background Color"
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
              No Fill (Transparent)
            </button>
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
              <label>Custom:</label>
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
          <button className="format-btn close-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </>
      )}
    </div>
  );
}
