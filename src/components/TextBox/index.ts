// Components
export { TextBoxContextMenu } from './TextBoxContextMenu';
export { TextPropertiesPanel } from './TextPropertiesPanel';
export { BoxPropertiesPanel } from './BoxPropertiesPanel';
export { RichTextEditor, useSelectionStyle } from './RichTextEditor';
export {
  TipTapEditor,
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
} from './TipTapEditor';
export type { TipTapEditorRef, TipTapEditorProps } from './TipTapEditor';

// Hooks
export {
  useTextBoxCreation,
  useTextBoxEditing,
  useTextBoxManipulation,
  useTextBoxKeyboard,
} from './hooks';
