import { useLocale } from "../../i18n";
import { useEffect, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import type { TextStyle as PDFTextStyle } from '../../annotations/types';
import { useTextBoxStore } from '../../store/textBoxStore';
import './TipTapEditor.css';

function editorStyle(defaultStyle: PDFTextStyle): string {
  // Each field is one CSS value, including styles restored from a document.
  // Assign properties individually so a semicolon cannot add declarations.
  const style = document.createElement('span').style;
  style.fontFamily = defaultStyle.fontFamily;
  style.fontSize = `${defaultStyle.fontSize}px`;
  style.color = defaultStyle.color;
  style.lineHeight = String(defaultStyle.lineHeight);
  style.letterSpacing = `${defaultStyle.letterSpacing}px`;
  style.textAlign = defaultStyle.textAlign;
  return style.cssText;
}

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
  useLocale();
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentOnBlur = useRef(onBlur);
    useEffect(() => { currentOnBlur.current = onBlur; }, [onBlur]);
    useEffect(() => () => {
      if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    }, []);

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
          underline: false,
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
          style: editorStyle(defaultStyle),
        },
      },
      onUpdate: ({ editor }) => {
        onContentChange?.(editor.getHTML(), editor.getText());
      },
      onBlur: () => {
        // Delay blur handling to check if focus moved to toolbar
        if (blurTimer.current !== null) clearTimeout(blurTimer.current);
        blurTimer.current = setTimeout(() => {
          blurTimer.current = null;
          const activeElement = document.activeElement;
          const isToolbarElement = activeElement?.closest('.textbox-format-toolbar-container') ||
                                   activeElement?.closest('.tiptap-toolbar') ||
                                   activeElement?.closest('[data-format-toolbar="true"]');

          // Also check if focus is on the editor container itself
          const isEditorElement = activeElement?.closest('.tiptap-editor-container') ||
                                  activeElement?.closest('.freetext-editor-container');

          if (!isToolbarElement && !isEditorElement) {
            currentOnBlur.current?.();
          }
        }, 100);
      },
      onFocus: () => {
        if (blurTimer.current !== null) clearTimeout(blurTimer.current);
        blurTimer.current = null;
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

export default TipTapEditor;
