// Components
export { TextBoxContextMenu } from './TextBoxContextMenu';
export { TextPropertiesPanel } from './TextPropertiesPanel';
export { BoxPropertiesPanel } from './BoxPropertiesPanel';
export { RichTextEditor } from './RichTextEditor';
export { useSelectionStyle } from './hooks/useSelectionStyle';
export { TipTapEditor } from './TipTapEditor';
export {
  getEditorFormattingState,
  applyFormatting,
  toggleBold,
  toggleItalic,
  toggleUnderline,
  toggleStrikethrough,
  setFontFamily,
  setFontSize,
  setColor,
  setTextAlign,
  setHighlight,
} from './tiptapFormatting';
export type { TipTapEditorRef, TipTapEditorProps } from './TipTapEditor';

// Hooks
export {
  useTextBoxCreation,
  useTextBoxEditing,
  useTextBoxManipulation,
  useTextBoxKeyboard,
} from './hooks';
