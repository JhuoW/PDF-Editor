import { useCallback, useRef, useEffect } from 'react';
import { useTextBoxStore } from '../../../store/textBoxStore';
import { useAnnotationStore } from '../../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../../store/annotationHistoryStore';
import type { FreeTextAnnotation } from '../../../annotations/types';

// Blinking cursor interval (530ms as per spec)
const CURSOR_BLINK_INTERVAL = 530;

// Text editing batch timeout (3 seconds)
const EDIT_BATCH_TIMEOUT = 3000;

export function useTextBoxEditing() {
  const {
    editingTextBoxId,
    cursor,
    startEditing,
    stopEditing,
    setCursor,
    setCursorPosition,
    setSelection,
    clearSelection,
    startEditBatch,
    endEditBatch,
  } = useTextBoxStore();

  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  // Ref to store the original content before editing batch
  const originalContentRef = useRef<string | null>(null);
  const originalAnnotationRef = useRef<FreeTextAnnotation | null>(null);
  const blinkIntervalRef = useRef<number | null>(null);
  const batchTimeoutRef = useRef<number | null>(null);

  // Get the currently editing annotation
  const getEditingAnnotation = useCallback((): FreeTextAnnotation | null => {
    if (!editingTextBoxId) return null;

    // Search all pages for the annotation
    const allAnnotations = useAnnotationStore.getState().getAllAnnotations();
    const annotation = allAnnotations.find(
      (a) => a.id === editingTextBoxId && a.type === 'freetext'
    );

    return annotation as FreeTextAnnotation | null;
  }, [editingTextBoxId]);

  // Start editing a text box
  const handleStartEditing = useCallback(
    (textBoxId: string) => {
      const allAnnotations = useAnnotationStore.getState().getAllAnnotations();
      const annotation = allAnnotations.find(
        (a) => a.id === textBoxId && a.type === 'freetext'
      ) as FreeTextAnnotation | undefined;

      if (!annotation) return;

      // Store original state for undo batching
      originalContentRef.current = annotation.content || '';
      originalAnnotationRef.current = { ...annotation };

      // Start editing and position cursor at end
      startEditing(textBoxId);
      setCursorPosition(annotation.content?.length || 0);
      startEditBatch();
    },
    [startEditing, setCursorPosition, startEditBatch]
  );

  // Stop editing and commit changes
  const handleStopEditing = useCallback(() => {
    if (!editingTextBoxId) return;

    const annotation = getEditingAnnotation();
    const originalAnnotation = originalAnnotationRef.current;

    // Record the update if content changed
    if (annotation && originalAnnotation && annotation.content !== originalAnnotation.content) {
      recordUpdate(annotation, originalAnnotation);
    }

    // Clean up
    originalContentRef.current = null;
    originalAnnotationRef.current = null;

    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = null;
    }

    stopEditing();
  }, [editingTextBoxId, getEditingAnnotation, recordUpdate, stopEditing]);

  // Handle text input
  const handleTextInput = useCallback(
    (text: string) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';
      const { position, selectionStart, selectionEnd } = cursor;

      let newContent: string;
      let newPosition: number;

      if (selectionStart !== null && selectionEnd !== null) {
        // Replace selection
        const start = Math.min(selectionStart, selectionEnd);
        const end = Math.max(selectionStart, selectionEnd);
        newContent = content.slice(0, start) + text + content.slice(end);
        newPosition = start + text.length;
        clearSelection();
      } else {
        // Insert at cursor
        newContent = content.slice(0, position) + text + content.slice(position);
        newPosition = position + text.length;
      }

      updateAnnotation(annotation.id, { content: newContent });
      setCursorPosition(newPosition);

      // Reset batch timeout
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current);
      }
      batchTimeoutRef.current = window.setTimeout(() => {
        endEditBatch();
        startEditBatch();
      }, EDIT_BATCH_TIMEOUT);
    },
    [getEditingAnnotation, cursor, updateAnnotation, setCursorPosition, clearSelection, endEditBatch, startEditBatch]
  );

  // Handle backspace
  const handleBackspace = useCallback(() => {
    const annotation = getEditingAnnotation();
    if (!annotation) return;

    const content = annotation.content || '';
    const { position, selectionStart, selectionEnd } = cursor;

    let newContent: string;
    let newPosition: number;

    if (selectionStart !== null && selectionEnd !== null) {
      // Delete selection
      const start = Math.min(selectionStart, selectionEnd);
      const end = Math.max(selectionStart, selectionEnd);
      newContent = content.slice(0, start) + content.slice(end);
      newPosition = start;
      clearSelection();
    } else if (position > 0) {
      // Delete character before cursor
      newContent = content.slice(0, position - 1) + content.slice(position);
      newPosition = position - 1;
    } else {
      return;
    }

    updateAnnotation(annotation.id, { content: newContent });
    setCursorPosition(newPosition);
  }, [getEditingAnnotation, cursor, updateAnnotation, setCursorPosition, clearSelection]);

  // Handle delete
  const handleDelete = useCallback(() => {
    const annotation = getEditingAnnotation();
    if (!annotation) return;

    const content = annotation.content || '';
    const { position, selectionStart, selectionEnd } = cursor;

    let newContent: string;
    let newPosition: number;

    if (selectionStart !== null && selectionEnd !== null) {
      // Delete selection
      const start = Math.min(selectionStart, selectionEnd);
      const end = Math.max(selectionStart, selectionEnd);
      newContent = content.slice(0, start) + content.slice(end);
      newPosition = start;
      clearSelection();
    } else if (position < content.length) {
      // Delete character after cursor
      newContent = content.slice(0, position) + content.slice(position + 1);
      newPosition = position;
    } else {
      return;
    }

    updateAnnotation(annotation.id, { content: newContent });
    setCursorPosition(newPosition);
  }, [getEditingAnnotation, cursor, updateAnnotation, setCursorPosition, clearSelection]);

  // Move cursor left
  const handleMoveCursorLeft = useCallback(
    (shiftKey: boolean = false, ctrlKey: boolean = false) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';
      const { position, selectionStart, selectionEnd } = cursor;

      let newPosition: number;

      if (ctrlKey) {
        // Move by word
        const beforeCursor = content.slice(0, position);
        const wordMatch = beforeCursor.match(/\S+\s*$/);
        newPosition = wordMatch ? position - wordMatch[0].length : 0;
      } else {
        newPosition = Math.max(0, position - 1);
      }

      if (shiftKey) {
        // Extend selection
        const start = selectionStart ?? position;
        setSelection(start, newPosition);
      } else {
        // Clear selection and move cursor
        if (selectionStart !== null && selectionEnd !== null) {
          // Move to start of selection
          newPosition = Math.min(selectionStart, selectionEnd);
        }
        clearSelection();
        setCursorPosition(newPosition);
      }
    },
    [getEditingAnnotation, cursor, setSelection, clearSelection, setCursorPosition]
  );

  // Move cursor right
  const handleMoveCursorRight = useCallback(
    (shiftKey: boolean = false, ctrlKey: boolean = false) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';
      const { position, selectionStart, selectionEnd } = cursor;

      let newPosition: number;

      if (ctrlKey) {
        // Move by word
        const afterCursor = content.slice(position);
        const wordMatch = afterCursor.match(/^\s*\S+/);
        newPosition = wordMatch ? position + wordMatch[0].length : content.length;
      } else {
        newPosition = Math.min(content.length, position + 1);
      }

      if (shiftKey) {
        // Extend selection
        const start = selectionStart ?? position;
        setSelection(start, newPosition);
      } else {
        // Clear selection and move cursor
        if (selectionStart !== null && selectionEnd !== null) {
          // Move to end of selection
          newPosition = Math.max(selectionStart, selectionEnd);
        }
        clearSelection();
        setCursorPosition(newPosition);
      }
    },
    [getEditingAnnotation, cursor, setSelection, clearSelection, setCursorPosition]
  );

  // Move cursor to start of line
  const handleMoveCursorHome = useCallback(
    (shiftKey: boolean = false, ctrlKey: boolean = false) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';
      const { position, selectionStart } = cursor;

      let newPosition: number;

      if (ctrlKey) {
        // Move to start of content
        newPosition = 0;
      } else {
        // Move to start of current line
        const beforeCursor = content.slice(0, position);
        const lastNewline = beforeCursor.lastIndexOf('\n');
        newPosition = lastNewline === -1 ? 0 : lastNewline + 1;
      }

      if (shiftKey) {
        const start = selectionStart ?? position;
        setSelection(start, newPosition);
      } else {
        clearSelection();
        setCursorPosition(newPosition);
      }
    },
    [getEditingAnnotation, cursor, setSelection, clearSelection, setCursorPosition]
  );

  // Move cursor to end of line
  const handleMoveCursorEnd = useCallback(
    (shiftKey: boolean = false, ctrlKey: boolean = false) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';
      const { position, selectionStart } = cursor;

      let newPosition: number;

      if (ctrlKey) {
        // Move to end of content
        newPosition = content.length;
      } else {
        // Move to end of current line
        const afterCursor = content.slice(position);
        const nextNewline = afterCursor.indexOf('\n');
        newPosition = nextNewline === -1 ? content.length : position + nextNewline;
      }

      if (shiftKey) {
        const start = selectionStart ?? position;
        setSelection(start, newPosition);
      } else {
        clearSelection();
        setCursorPosition(newPosition);
      }
    },
    [getEditingAnnotation, cursor, setSelection, clearSelection, setCursorPosition]
  );

  // Select all text
  const handleSelectAll = useCallback(() => {
    const annotation = getEditingAnnotation();
    if (!annotation) return;

    const content = annotation.content || '';
    setSelection(0, content.length);
  }, [getEditingAnnotation, setSelection]);

  // Set cursor position from click
  const handleClickPosition = useCallback(
    (charIndex: number, shiftKey: boolean = false) => {
      const { position, selectionStart } = cursor;

      if (shiftKey) {
        // Extend selection from current position
        const start = selectionStart ?? position;
        setSelection(start, charIndex);
      } else {
        clearSelection();
        setCursorPosition(charIndex);
      }
    },
    [cursor, setSelection, clearSelection, setCursorPosition]
  );

  // Double-click to select word
  const handleDoubleClickWord = useCallback(
    (charIndex: number) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';

      // Find word boundaries
      let start = charIndex;
      let end = charIndex;

      // Find start of word
      while (start > 0 && /\S/.test(content[start - 1])) {
        start--;
      }

      // Find end of word
      while (end < content.length && /\S/.test(content[end])) {
        end++;
      }

      if (start !== end) {
        setSelection(start, end);
      }
    },
    [getEditingAnnotation, setSelection]
  );

  // Triple-click to select line/paragraph
  const handleTripleClickLine = useCallback(
    (charIndex: number) => {
      const annotation = getEditingAnnotation();
      if (!annotation) return;

      const content = annotation.content || '';

      // Find line boundaries
      let start = charIndex;
      let end = charIndex;

      // Find start of line
      while (start > 0 && content[start - 1] !== '\n') {
        start--;
      }

      // Find end of line
      while (end < content.length && content[end] !== '\n') {
        end++;
      }

      setSelection(start, end);
    },
    [getEditingAnnotation, setSelection]
  );

  // Get selected text
  const getSelectedText = useCallback((): string => {
    const annotation = getEditingAnnotation();
    if (!annotation) return '';

    const { selectionStart, selectionEnd } = cursor;
    if (selectionStart === null || selectionEnd === null) return '';

    const content = annotation.content || '';
    const start = Math.min(selectionStart, selectionEnd);
    const end = Math.max(selectionStart, selectionEnd);

    return content.slice(start, end);
  }, [getEditingAnnotation, cursor]);

  // Handle cut
  const handleCut = useCallback(async () => {
    const selectedText = getSelectedText();
    if (!selectedText) return;

    try {
      await navigator.clipboard.writeText(selectedText);
      handleBackspace(); // Delete the selection
    } catch (err) {
      console.error('Failed to cut:', err);
    }
  }, [getSelectedText, handleBackspace]);

  // Handle copy
  const handleCopy = useCallback(async () => {
    const selectedText = getSelectedText();
    if (!selectedText) return;

    try {
      await navigator.clipboard.writeText(selectedText);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [getSelectedText]);

  // Handle paste
  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        handleTextInput(text);
      }
    } catch (err) {
      console.error('Failed to paste:', err);
    }
  }, [handleTextInput]);

  // Toggle cursor blink
  useEffect(() => {
    if (editingTextBoxId) {
      blinkIntervalRef.current = window.setInterval(() => {
        setCursor({ isBlinking: !useTextBoxStore.getState().cursor.isBlinking });
      }, CURSOR_BLINK_INTERVAL);

      return () => {
        if (blinkIntervalRef.current) {
          clearInterval(blinkIntervalRef.current);
          blinkIntervalRef.current = null;
        }
      };
    }
  }, [editingTextBoxId, setCursor]);

  // Cancel editing on escape
  const handleCancel = useCallback(() => {
    if (!editingTextBoxId) return;

    const annotation = getEditingAnnotation();
    const originalAnnotation = originalAnnotationRef.current;

    // Restore original content if we started with something
    if (annotation && originalAnnotation) {
      updateAnnotation(annotation.id, { content: originalAnnotation.content });
    }

    // Clean up
    originalContentRef.current = null;
    originalAnnotationRef.current = null;

    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current);
      batchTimeoutRef.current = null;
    }

    stopEditing();
  }, [editingTextBoxId, getEditingAnnotation, updateAnnotation, stopEditing]);

  return {
    editingTextBoxId,
    cursor,
    isEditing: editingTextBoxId !== null,
    getEditingAnnotation,
    startEditing: handleStartEditing,
    stopEditing: handleStopEditing,
    cancelEditing: handleCancel,
    handleTextInput,
    handleBackspace,
    handleDelete,
    handleMoveCursorLeft,
    handleMoveCursorRight,
    handleMoveCursorHome,
    handleMoveCursorEnd,
    handleSelectAll,
    handleClickPosition,
    handleDoubleClickWord,
    handleTripleClickLine,
    getSelectedText,
    handleCut,
    handleCopy,
    handlePaste,
  };
}
