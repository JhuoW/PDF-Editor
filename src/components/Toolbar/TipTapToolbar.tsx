import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { AVAILABLE_FONTS, FONT_SIZE_PRESETS } from '../../annotations/types';
import {
  getEditorFormattingState,
  toggleBold,
  toggleItalic,
  toggleUnderline,
  toggleStrikethrough,
  setFontFamily,
  setFontSize,
  setColor,
  setTextAlign,
} from '../TextBox/TipTapEditor';
import './TextFormatToolbar.css';

interface TipTapToolbarProps {
  editor: Editor | null;
  onClose?: () => void;
}

const COLOR_PRESETS = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
];

export function TipTapToolbar({ editor, onClose }: TipTapToolbarProps) {
  // Force re-render when editor selection changes
  const [, setUpdateTrigger] = useState(0);

  useEffect(() => {
    if (!editor) return;

    const handleUpdate = () => {
      setUpdateTrigger(prev => prev + 1);
    };

    editor.on('selectionUpdate', handleUpdate);
    editor.on('transaction', handleUpdate);

    return () => {
      editor.off('selectionUpdate', handleUpdate);
      editor.off('transaction', handleUpdate);
    };
  }, [editor]);

  const state = getEditorFormattingState(editor);

  const handleFontFamilyChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setFontFamily(editor, e.target.value);
  }, [editor]);

  const handleFontSizeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const size = parseInt(e.target.value, 10);
    if (!isNaN(size)) {
      setFontSize(editor, size);
    }
  }, [editor]);

  const handleCustomFontSize = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const size = parseInt(e.target.value, 10);
    if (!isNaN(size) && size >= 1 && size <= 200) {
      setFontSize(editor, size);
    }
  }, [editor]);

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setColor(editor, e.target.value);
  }, [editor]);

  const handleAlignChange = useCallback((align: 'left' | 'center' | 'right' | 'justify') => {
    setTextAlign(editor, align);
  }, [editor]);

  // Prevent mousedown from stealing focus
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'SELECT';
    if (!isInput) {
      e.preventDefault();
    }
  }, []);

  if (!editor) return null;

  return (
    <div
      className="text-format-toolbar tiptap-toolbar"
      onMouseDown={handleMouseDown}
      data-format-toolbar="true"
    >
      {/* Font Family */}
      <div className="toolbar-group">
        <select
          className="font-family-select"
          value={state.fontFamily}
          onChange={handleFontFamilyChange}
          title="Font Family"
        >
          {AVAILABLE_FONTS.map((font) => (
            <option key={font} value={font} style={{ fontFamily: font }}>
              {font}
            </option>
          ))}
        </select>
      </div>

      {/* Font Size */}
      <div className="toolbar-group">
        <select
          className="font-size-select"
          value={state.fontSize}
          onChange={handleFontSizeChange}
          title="Font Size"
        >
          {FONT_SIZE_PRESETS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="font-size-input"
          value={state.fontSize}
          min={1}
          max={200}
          onChange={handleCustomFontSize}
          title="Custom Font Size"
        />
      </div>

      <div className="toolbar-divider" />

      {/* Text Style Buttons */}
      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${state.isBold ? 'active' : ''}`}
          onClick={() => toggleBold(editor)}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </button>
        <button
          className={`toolbar-btn ${state.isItalic ? 'active' : ''}`}
          onClick={() => toggleItalic(editor)}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </button>
        <button
          className={`toolbar-btn ${state.isUnderline ? 'active' : ''}`}
          onClick={() => toggleUnderline(editor)}
          title="Underline (Ctrl+U)"
        >
          <u>U</u>
        </button>
        <button
          className={`toolbar-btn ${state.isStrikethrough ? 'active' : ''}`}
          onClick={() => toggleStrikethrough(editor)}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
      </div>

      <div className="toolbar-divider" />

      {/* Text Color */}
      <div className="toolbar-group">
        <div className="color-picker-wrapper">
          <input
            type="color"
            className="color-picker"
            value={state.color}
            onChange={handleColorChange}
            title="Text Color"
          />
          <span
            className="color-indicator"
            style={{ backgroundColor: state.color }}
          />
        </div>
        <div className="color-presets-dropdown">
          {COLOR_PRESETS.map((color) => (
            <button
              key={color}
              className={`color-preset-btn ${color === state.color ? 'active' : ''}`}
              style={{ backgroundColor: color }}
              onClick={() => setColor(editor, color)}
              title={color}
            />
          ))}
        </div>
      </div>

      <div className="toolbar-divider" />

      {/* Text Alignment */}
      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${state.textAlign === 'left' ? 'active' : ''}`}
          onClick={() => handleAlignChange('left')}
          title="Align Left"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h18v2H3V3zm0 4h12v2H3V7zm0 4h18v2H3v-2zm0 4h12v2H3v-2zm0 4h18v2H3v-2z"/>
          </svg>
        </button>
        <button
          className={`toolbar-btn ${state.textAlign === 'center' ? 'active' : ''}`}
          onClick={() => handleAlignChange('center')}
          title="Align Center"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h18v2H3V3zm3 4h12v2H6V7zm-3 4h18v2H3v-2zm3 4h12v2H6v-2zm-3 4h18v2H3v-2z"/>
          </svg>
        </button>
        <button
          className={`toolbar-btn ${state.textAlign === 'right' ? 'active' : ''}`}
          onClick={() => handleAlignChange('right')}
          title="Align Right"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h18v2H3V3zm6 4h12v2H9V7zm-6 4h18v2H3v-2zm6 4h12v2H9v-2zm-6 4h18v2H3v-2z"/>
          </svg>
        </button>
        <button
          className={`toolbar-btn ${state.textAlign === 'justify' ? 'active' : ''}`}
          onClick={() => handleAlignChange('justify')}
          title="Justify"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h18v2H3V3zm0 4h18v2H3V7zm0 4h18v2H3v-2zm0 4h18v2H3v-2zm0 4h18v2H3v-2z"/>
          </svg>
        </button>
      </div>

      {onClose && (
        <>
          <div className="toolbar-divider" />
          <button className="toolbar-btn close-btn" onClick={onClose} title="Close">
            &times;
          </button>
        </>
      )}
    </div>
  );
}

export default TipTapToolbar;
