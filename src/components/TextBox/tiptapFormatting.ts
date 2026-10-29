import type { Editor } from '@tiptap/react';
import type { TextStyle as PDFTextStyle } from '../../annotations/types';

// Utility functions for format detection and application
export function getEditorFormattingState(editor: Editor | null) {
  if (!editor) {
    return {
      isBold: false,
      isItalic: false,
      isUnderline: false,
      isStrikethrough: false,
      fontFamily: 'Helvetica',
      fontSize: 14,
      color: '#000000',
      textAlign: 'left' as const,
      highlightColor: null as string | null,
    };
  }

  return {
    isBold: editor.isActive('bold'),
    isItalic: editor.isActive('italic'),
    isUnderline: editor.isActive('underline'),
    isStrikethrough: editor.isActive('strike'),
    fontFamily: editor.getAttributes('textStyle').fontFamily || 'Helvetica',
    fontSize: parseInt(editor.getAttributes('textStyle').fontSize || '14', 10),
    color: editor.getAttributes('textStyle').color || '#000000',
    textAlign: editor.getAttributes('paragraph').textAlign || 'left',
    highlightColor: editor.getAttributes('highlight').color || null,
  };
}

// Commands to apply formatting
export function applyFormatting(editor: Editor | null, format: Partial<PDFTextStyle>) {
  if (!editor) return;

  const chain = editor.chain().focus();

  if (format.fontWeight !== undefined) {
    if (format.fontWeight === 'bold') {
      chain.setBold();
    } else {
      chain.unsetBold();
    }
  }

  if (format.fontStyle !== undefined) {
    if (format.fontStyle === 'italic') {
      chain.setItalic();
    } else {
      chain.unsetItalic();
    }
  }

  if (format.textDecoration !== undefined) {
    if (format.textDecoration === 'underline') {
      chain.setUnderline();
    } else if (format.textDecoration === 'line-through') {
      chain.setStrike();
    } else {
      chain.unsetUnderline().unsetStrike();
    }
  }

  if (format.fontFamily !== undefined) {
    chain.setFontFamily(format.fontFamily);
  }

  if (format.fontSize !== undefined) {
    chain.setFontSize(`${format.fontSize}px`);
  }

  if (format.color !== undefined) {
    chain.setColor(format.color);
  }

  if (format.textAlign !== undefined) {
    chain.setTextAlign(format.textAlign);
  }

  chain.run();
}

// Toggle formatting commands
export function toggleBold(editor: Editor | null) {
  editor?.chain().focus().toggleBold().run();
}

export function toggleItalic(editor: Editor | null) {
  editor?.chain().focus().toggleItalic().run();
}

export function toggleUnderline(editor: Editor | null) {
  editor?.chain().focus().toggleUnderline().run();
}

export function toggleStrikethrough(editor: Editor | null) {
  editor?.chain().focus().toggleStrike().run();
}

export function setFontFamily(editor: Editor | null, fontFamily: string) {
  editor?.chain().focus().setFontFamily(fontFamily).run();
}

export function setFontSize(editor: Editor | null, fontSize: number) {
  editor?.chain().focus().setFontSize(`${fontSize}px`).run();
}

export function setColor(editor: Editor | null, color: string) {
  editor?.chain().focus().setColor(color).run();
}

export function setTextAlign(editor: Editor | null, align: 'left' | 'center' | 'right' | 'justify') {
  editor?.chain().focus().setTextAlign(align).run();
}

export function setHighlight(editor: Editor | null, color: string | null) {
  if (color) {
    editor?.chain().focus().setHighlight({ color }).run();
  } else {
    editor?.chain().focus().unsetHighlight().run();
  }
}
