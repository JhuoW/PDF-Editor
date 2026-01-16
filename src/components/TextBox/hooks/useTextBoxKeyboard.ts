import { useEffect, useCallback } from 'react';
import { useTextBoxEditing } from './useTextBoxEditing';
import { useTextBoxManipulation } from './useTextBoxManipulation';
import { useAnnotationStore } from '../../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../../store/annotationHistoryStore';
import type { FreeTextAnnotation, TextStyle } from '../../../annotations/types';
import { DEFAULT_TEXT_STYLE } from '../../../annotations/types';

interface UseTextBoxKeyboardOptions {
  enabled?: boolean;
}

export function useTextBoxKeyboard(options: UseTextBoxKeyboardOptions = {}) {
  const { enabled = true } = options;

  const {
    isEditing,
    stopEditing,
    cancelEditing,
    handleTextInput,
    handleBackspace,
    handleDelete,
    handleMoveCursorLeft,
    handleMoveCursorRight,
    handleMoveCursorHome,
    handleMoveCursorEnd,
    handleSelectAll,
    handleCut,
    handleCopy,
    handlePaste,
    getEditingAnnotation,
  } = useTextBoxEditing();

  const {
    selectedAnnotationId,
    nudge,
    bringToFront,
    sendToBack,
    bringForward,
    sendBackward,
    deleteSelected,
    duplicate,
    getSelectedAnnotation,
  } = useTextBoxManipulation();

  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  // Get style from annotation
  const getAnnotationStyle = useCallback((annotation: FreeTextAnnotation): TextStyle => {
    return annotation.style || DEFAULT_TEXT_STYLE;
  }, []);

  // Toggle text formatting
  const toggleFormat = useCallback(
    (property: keyof TextStyle, value1: any, value2: any) => {
      const annotation = isEditing
        ? getEditingAnnotation()
        : (getSelectedAnnotation() as FreeTextAnnotation | null);

      if (!annotation) return;

      const currentStyle = getAnnotationStyle(annotation);
      const currentValue = currentStyle[property];
      const newValue = currentValue === value1 ? value2 : value1;

      const previousState = { ...annotation };
      const newStyle = { ...currentStyle, [property]: newValue };

      updateAnnotation(annotation.id, { style: newStyle });
      recordUpdate({ ...annotation, style: newStyle }, previousState);
    },
    [isEditing, getEditingAnnotation, getSelectedAnnotation, getAnnotationStyle, updateAnnotation, recordUpdate]
  );

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      // If editing text
      if (isEditing) {
        // Escape to cancel editing
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelEditing();
          return;
        }

        // Ctrl+Enter to finish editing
        if (e.key === 'Enter' && isCtrl) {
          e.preventDefault();
          stopEditing();
          return;
        }

        // Navigation keys
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            handleMoveCursorLeft(isShift, isCtrl);
            return;
          case 'ArrowRight':
            e.preventDefault();
            handleMoveCursorRight(isShift, isCtrl);
            return;
          case 'Home':
            e.preventDefault();
            handleMoveCursorHome(isShift, isCtrl);
            return;
          case 'End':
            e.preventDefault();
            handleMoveCursorEnd(isShift, isCtrl);
            return;
          case 'Backspace':
            e.preventDefault();
            handleBackspace();
            return;
          case 'Delete':
            e.preventDefault();
            handleDelete();
            return;
          case 'Enter':
            if (!isCtrl) {
              e.preventDefault();
              handleTextInput('\n');
            }
            return;
          case 'Tab':
            e.preventDefault();
            handleTextInput('\t');
            return;
        }

        // Ctrl shortcuts
        if (isCtrl) {
          switch (e.key.toLowerCase()) {
            case 'a':
              e.preventDefault();
              handleSelectAll();
              return;
            case 'x':
              e.preventDefault();
              handleCut();
              return;
            case 'c':
              e.preventDefault();
              handleCopy();
              return;
            case 'v':
              e.preventDefault();
              handlePaste();
              return;
            case 'b':
              e.preventDefault();
              toggleFormat('fontWeight', 'bold', 'normal');
              return;
            case 'i':
              e.preventDefault();
              toggleFormat('fontStyle', 'italic', 'normal');
              return;
            case 'u':
              e.preventDefault();
              toggleFormat('textDecoration', 'underline', 'none');
              return;
          }

          // Ctrl+Shift shortcuts
          if (isShift) {
            switch (e.key.toLowerCase()) {
              case 'x':
              case 's':
                e.preventDefault();
                toggleFormat('textDecoration', 'line-through', 'none');
                return;
              case '.':
              case '>':
                e.preventDefault();
                // Increase font size
                const annotation1 = getEditingAnnotation();
                if (annotation1) {
                  const style = getAnnotationStyle(annotation1);
                  const newSize = Math.min(style.fontSize + 2, 200);
                  const previousState = { ...annotation1 };
                  const newStyle = { ...style, fontSize: newSize };
                  updateAnnotation(annotation1.id, { style: newStyle });
                  recordUpdate({ ...annotation1, style: newStyle }, previousState);
                }
                return;
              case ',':
              case '<':
                e.preventDefault();
                // Decrease font size
                const annotation2 = getEditingAnnotation();
                if (annotation2) {
                  const style = getAnnotationStyle(annotation2);
                  const newSize = Math.max(style.fontSize - 2, 1);
                  const previousState = { ...annotation2 };
                  const newStyle = { ...style, fontSize: newSize };
                  updateAnnotation(annotation2.id, { style: newStyle });
                  recordUpdate({ ...annotation2, style: newStyle }, previousState);
                }
                return;
            }
          }
        }

        // Regular character input (skip if Ctrl is held)
        if (!isCtrl && e.key.length === 1) {
          e.preventDefault();
          handleTextInput(e.key);
          return;
        }

        return;
      }

      // Not editing - handle selected text box shortcuts
      if (!selectedAnnotationId) return;

      const selectedAnnotation = getSelectedAnnotation();
      if (!selectedAnnotation || selectedAnnotation.type !== 'freetext') return;

      // Arrow keys for nudging (only when not editing)
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          nudge('up', isShift);
          return;
        case 'ArrowDown':
          e.preventDefault();
          nudge('down', isShift);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          nudge('left', isShift);
          return;
        case 'ArrowRight':
          e.preventDefault();
          nudge('right', isShift);
          return;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelected();
          return;
        case 'Escape':
          e.preventDefault();
          useAnnotationStore.getState().selectAnnotation(null);
          return;
      }

      // Enter to start editing
      if (e.key === 'Enter' && !isCtrl) {
        e.preventDefault();
        useTextBoxEditing().startEditing(selectedAnnotationId);
        return;
      }

      // Ctrl shortcuts for selected (non-editing) text box
      if (isCtrl) {
        switch (e.key.toLowerCase()) {
          case 'd':
            e.preventDefault();
            duplicate();
            return;
          case 'c':
            e.preventDefault();
            navigator.clipboard.writeText(selectedAnnotation.content || '');
            return;
          case 'x':
            e.preventDefault();
            navigator.clipboard.writeText(selectedAnnotation.content || '');
            deleteSelected();
            return;
          case ']':
            e.preventDefault();
            if (isShift) {
              bringToFront();
            } else {
              bringForward();
            }
            return;
          case '[':
            e.preventDefault();
            if (isShift) {
              sendToBack();
            } else {
              sendBackward();
            }
            return;
          case 'b':
            e.preventDefault();
            toggleFormat('fontWeight', 'bold', 'normal');
            return;
          case 'i':
            e.preventDefault();
            toggleFormat('fontStyle', 'italic', 'normal');
            return;
          case 'u':
            e.preventDefault();
            toggleFormat('textDecoration', 'underline', 'none');
            return;
        }

        // Alignment shortcuts
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          const style = getAnnotationStyle(selectedAnnotation);
          const previousState = { ...selectedAnnotation };
          const newStyle = { ...style, textAlign: 'left' as const };
          updateAnnotation(selectedAnnotation.id, { style: newStyle });
          recordUpdate({ ...selectedAnnotation, style: newStyle }, previousState);
          return;
        }
        if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          const style = getAnnotationStyle(selectedAnnotation);
          const previousState = { ...selectedAnnotation };
          const newStyle = { ...style, textAlign: 'center' as const };
          updateAnnotation(selectedAnnotation.id, { style: newStyle });
          recordUpdate({ ...selectedAnnotation, style: newStyle }, previousState);
          return;
        }
        if (e.key.toLowerCase() === 'r') {
          e.preventDefault();
          const style = getAnnotationStyle(selectedAnnotation);
          const previousState = { ...selectedAnnotation };
          const newStyle = { ...style, textAlign: 'right' as const };
          updateAnnotation(selectedAnnotation.id, { style: newStyle });
          recordUpdate({ ...selectedAnnotation, style: newStyle }, previousState);
          return;
        }
        if (e.key.toLowerCase() === 'j') {
          e.preventDefault();
          const style = getAnnotationStyle(selectedAnnotation);
          const previousState = { ...selectedAnnotation };
          const newStyle = { ...style, textAlign: 'justify' as const };
          updateAnnotation(selectedAnnotation.id, { style: newStyle });
          recordUpdate({ ...selectedAnnotation, style: newStyle }, previousState);
          return;
        }
      }
    },
    [
      enabled,
      isEditing,
      selectedAnnotationId,
      cancelEditing,
      stopEditing,
      handleMoveCursorLeft,
      handleMoveCursorRight,
      handleMoveCursorHome,
      handleMoveCursorEnd,
      handleBackspace,
      handleDelete,
      handleTextInput,
      handleSelectAll,
      handleCut,
      handleCopy,
      handlePaste,
      toggleFormat,
      getEditingAnnotation,
      getSelectedAnnotation,
      getAnnotationStyle,
      updateAnnotation,
      recordUpdate,
      nudge,
      deleteSelected,
      duplicate,
      bringToFront,
      sendToBack,
      bringForward,
      sendBackward,
    ]
  );

  // Attach keyboard listener
  useEffect(() => {
    if (!enabled) return;

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleKeyDown]);

  return {
    isEditing,
    selectedAnnotationId,
  };
}
