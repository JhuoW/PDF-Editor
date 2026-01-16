import { useEffect, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { Extension } from '@tiptap/core';
import type { TextStyle as PDFTextStyle } from '../../annotations/types';
import { useTextBoxStore } from '../../store/textBoxStore';
import './TipTapEditor.css';

// Custom font size extension
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

const FontSize = Extension.create({
  name: 'fontSize',

  addOptions() {
    return {
      types: ['textStyle'],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: element => element.style.fontSize?.replace(/['"]+/g, ''),
            renderHTML: attributes => {
              if (!attributes.fontSize) {
                return {};
              }
              return {
                style: `font-size: ${attributes.fontSize}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize: (fontSize: string) => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize }).run();
      },
      unsetFontSize: () => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
      },
    };
  },
});

export interface TipTapEditorProps {
  initialContent?: string;
  defaultStyle: PDFTextStyle;
  width: number;
  height: number;
  padding?: number;
  onContentChange?: (html: string, text: string) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
}

export interface TipTapEditorRef {
  editor: Editor | null;
  getHTML: () => string;
  getText: () => string;
  focus: () => void;
  setContent: (html: string) => void;
}

export const TipTapEditor = forwardRef<TipTapEditorRef, TipTapEditorProps>(
  function TipTapEditor(
    {
      initialContent = '',
      defaultStyle,
      width,
      height,
      padding = 8,
      onContentChange,
      onBlur,
      autoFocus = true,
    },
    ref
  ) {
    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Disable some features we don't need
          blockquote: false,
          codeBlock: false,
          heading: false,
          horizontalRule: false,
          listItem: false,
          bulletList: false,
          orderedList: false,
        }),
        TextStyle,
        Color,
        FontFamily,
        FontSize,
        Underline,
        Highlight.configure({
          multicolor: true,
        }),
        TextAlign.configure({
          types: ['paragraph'],
          alignments: ['left', 'center', 'right', 'justify'],
        }),
      ],
      content: initialContent || '<p></p>',
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'tiptap-editor-content',
          style: `
            font-family: ${defaultStyle.fontFamily};
            font-size: ${defaultStyle.fontSize}px;
            color: ${defaultStyle.color};
            line-height: ${defaultStyle.lineHeight};
            letter-spacing: ${defaultStyle.letterSpacing}px;
            text-align: ${defaultStyle.textAlign};
          `,
        },
      },
      onUpdate: ({ editor }) => {
        onContentChange?.(editor.getHTML(), editor.getText());
      },
      onTransaction: ({ editor }) => {
        // Always update on any transaction to capture formatting changes
        // This ensures that applying bold/italic/etc. without content changes still updates
        onContentChange?.(editor.getHTML(), editor.getText());
      },
      onBlur: () => {
        // Delay blur handling to check if focus moved to toolbar
        setTimeout(() => {
          const activeElement = document.activeElement;
          const isToolbarElement = activeElement?.closest('.textbox-format-toolbar-container') ||
                                   activeElement?.closest('.tiptap-toolbar') ||
                                   activeElement?.closest('[data-format-toolbar="true"]');

          // Also check if focus is on the editor container itself
          const isEditorElement = activeElement?.closest('.tiptap-editor-container') ||
                                  activeElement?.closest('.freetext-editor-container');

          if (!isToolbarElement && !isEditorElement) {
            onBlur?.();
          }
        }, 100);
      },
    });

    // Expose editor methods via ref
    useImperativeHandle(ref, () => ({
      editor,
      getHTML: () => editor?.getHTML() || '',
      getText: () => editor?.getText() || '',
      focus: () => editor?.commands.focus(),
      setContent: (html: string) => editor?.commands.setContent(html),
    }), [editor]);

    // Update global store when editor is ready (for header toolbar)
    const { setTiptapEditor } = useTextBoxStore();
    useEffect(() => {
      if (editor) {
        setTiptapEditor(editor);
      }
      return () => {
        setTiptapEditor(null);
      };
    }, [editor, setTiptapEditor]);

    // Track if initial styles have been applied (to prevent re-applying on re-renders)
    const initialStylesApplied = useRef(false);

    // Apply default styles when editor is ready (only once)
    useEffect(() => {
      if (editor && !initialContent && !initialStylesApplied.current) {
        // Set initial formatting for new text - only do this once
        initialStylesApplied.current = true;
        editor.chain()
          .setFontFamily(defaultStyle.fontFamily)
          .setFontSize(`${defaultStyle.fontSize}px`)
          .setColor(defaultStyle.color)
          .setTextAlign(defaultStyle.textAlign)
          .run();
      }
    }, [editor, defaultStyle, initialContent]);

    // Handle click to focus
    const handleContainerClick = useCallback(() => {
      editor?.commands.focus();
    }, [editor]);

    if (!editor) {
      return null;
    }

    return (
      <div
        className="tiptap-editor-container"
        style={{
          width,
          height,
          padding,
          boxSizing: 'border-box',
        }}
        onClick={handleContainerClick}
        data-format-toolbar="true"
      >
        <EditorContent editor={editor} />
      </div>
    );
  }
);

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

export default TipTapEditor;
