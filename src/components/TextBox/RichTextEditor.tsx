import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { RichTextSegment, TextStyle } from '../../annotations/types';
import { useTextBoxStore } from '../../store/textBoxStore';
import {
  getStyleAtPosition,
  getSelectionStyle,
  applyStyleToRange,
  insertTextAtPosition,
  deleteTextInRange,
  normalizeSegments,
  getPlainText,
  findWordBoundary,
} from '../../utils/richText';
import './RichTextEditor.css';

interface RichTextEditorProps {
  segments: RichTextSegment[];
  defaultStyle: TextStyle;
  width: number;
  height: number;
  scale: number;
  padding?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  onChange: (segments: RichTextSegment[]) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
}

interface CharPosition {
  charIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lineIndex: number;
}

interface LineMetrics {
  startIndex: number;
  endIndex: number;
  y: number;
  height: number;
  baseline: number;
  width: number;
}

export function RichTextEditor({
  segments,
  defaultStyle,
  width,
  height,
  scale,
  padding = 8,
  textAlign = 'left',
  onChange,
  onBlur,
  autoFocus = true,
}: RichTextEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [charPositions, setCharPositions] = useState<CharPosition[]>([]);
  const [lineMetrics, setLineMetrics] = useState<LineMetrics[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);

  const {
    cursor,
    pendingFormat,
    setCursorPosition,
    setSelection,
    clearSelection,
    clearPendingFormat,
  } = useTextBoxStore();

  const plainText = useMemo(() => getPlainText(segments), [segments]);

  // Blink cursor
  useEffect(() => {
    if (!isFocused) return;

    const interval = setInterval(() => {
      setCursorVisible(v => !v);
    }, 530);

    return () => clearInterval(interval);
  }, [isFocused]);

  // Reset cursor visibility when position changes
  useEffect(() => {
    setCursorVisible(true);
  }, [cursor.position, cursor.selectionStart, cursor.selectionEnd]);

  // Measure and layout text
  const measureAndLayout = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const contentWidth = width - padding * 2;
    const positions: CharPosition[] = [];
    const lines: LineMetrics[] = [];

    let x = 0;
    let y = padding;
    let lineStartIndex = 0;
    let lineHeight = defaultStyle.fontSize * 1.2;
    let lineWidth = 0;
    let currentLinePositions: CharPosition[] = [];
    let charIndex = 0;

    // Helper to finalize a line
    const finalizeLine = () => {
      if (currentLinePositions.length === 0) return;

      // Apply text alignment
      let offsetX = 0;
      if (textAlign === 'center') {
        offsetX = (contentWidth - lineWidth) / 2;
      } else if (textAlign === 'right') {
        offsetX = contentWidth - lineWidth;
      }

      // Update positions with alignment offset
      currentLinePositions.forEach(pos => {
        pos.x += offsetX + padding;
        positions.push(pos);
      });

      lines.push({
        startIndex: lineStartIndex,
        endIndex: charIndex - 1,
        y,
        height: lineHeight,
        baseline: y + lineHeight * 0.8,
        width: lineWidth,
      });

      y += lineHeight;
      x = 0;
      lineStartIndex = charIndex;
      lineWidth = 0;
      currentLinePositions = [];
      lineHeight = defaultStyle.fontSize * 1.2;
    };

    // Process each segment
    for (const segment of segments) {
      const style = { ...defaultStyle, ...segment.style };
      const fontSize = style.fontSize || defaultStyle.fontSize;
      const fontStr = `${style.fontWeight || 'normal'} ${style.fontStyle || 'normal'} ${fontSize}px ${style.fontFamily || defaultStyle.fontFamily}`;
      ctx.font = fontStr;

      lineHeight = Math.max(lineHeight, fontSize * 1.2);

      for (let i = 0; i < segment.text.length; i++) {
        const char = segment.text[i];

        // Handle newlines
        if (char === '\n') {
          currentLinePositions.push({
            charIndex,
            x,
            y,
            width: 0,
            height: lineHeight,
            lineIndex: lines.length,
          });
          charIndex++;
          finalizeLine();
          continue;
        }

        const charWidth = ctx.measureText(char).width;

        // Check if we need to wrap
        if (x + charWidth > contentWidth && x > 0) {
          // Try to break at word boundary
          let breakPoint = currentLinePositions.length;
          for (let j = currentLinePositions.length - 1; j >= 0; j--) {
            const pos = currentLinePositions[j];
            const charAtPos = plainText[pos.charIndex];
            if (charAtPos === ' ' || charAtPos === '-') {
              breakPoint = j + 1;
              break;
            }
          }

          if (breakPoint < currentLinePositions.length && breakPoint > 0) {
            // Break at word boundary
            const positionsToKeep = currentLinePositions.slice(0, breakPoint);
            const positionsToMove = currentLinePositions.slice(breakPoint);

            lineWidth = positionsToKeep.reduce((sum, p) => sum + p.width, 0);
            currentLinePositions = positionsToKeep;
            finalizeLine();

            // Move remaining positions to new line
            x = 0;
            positionsToMove.forEach(pos => {
              pos.x = x;
              pos.y = y;
              pos.lineIndex = lines.length;
              x += pos.width;
              lineWidth += pos.width;
              currentLinePositions.push(pos);
            });
          } else {
            finalizeLine();
          }
        }

        currentLinePositions.push({
          charIndex,
          x,
          y,
          width: charWidth,
          height: lineHeight,
          lineIndex: lines.length,
        });

        x += charWidth;
        lineWidth = Math.max(lineWidth, x);
        charIndex++;
      }
    }

    // Finalize last line
    if (currentLinePositions.length > 0 || lines.length === 0) {
      finalizeLine();
    }

    // Add a position for the end of text (for cursor at end)
    if (positions.length === 0 || positions[positions.length - 1].charIndex < plainText.length) {
      const lastLine = lines[lines.length - 1] || { y: padding, height: defaultStyle.fontSize * 1.2 };
      // Calculate the x position based on the last character position
      let endX = padding;
      if (positions.length > 0) {
        const lastPos = positions[positions.length - 1];
        endX = lastPos.x + lastPos.width;
      }
      positions.push({
        charIndex: plainText.length,
        x: endX,
        y: lastLine.y,
        width: 0,
        height: lastLine.height,
        lineIndex: Math.max(0, lines.length - 1),
      });
    }

    setCharPositions(positions);
    setLineMetrics(lines);
  }, [segments, width, padding, textAlign, defaultStyle, plainText]);

  // Render the canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw selection background
    if (cursor.selectionStart !== null && cursor.selectionEnd !== null) {
      const selStart = Math.min(cursor.selectionStart, cursor.selectionEnd);
      const selEnd = Math.max(cursor.selectionStart, cursor.selectionEnd);

      ctx.fillStyle = 'rgba(50, 151, 253, 0.3)';

      for (const pos of charPositions) {
        if (pos.charIndex >= selStart && pos.charIndex < selEnd) {
          ctx.fillRect(pos.x * scale, pos.y * scale, pos.width * scale, pos.height * scale);
        }
      }
    }

    // Draw text
    let charIndex = 0;
    for (const segment of segments) {
      const style = { ...defaultStyle, ...segment.style };
      const fontSize = style.fontSize || defaultStyle.fontSize;
      const fontStr = `${style.fontWeight || 'normal'} ${style.fontStyle || 'normal'} ${fontSize * scale}px ${style.fontFamily || defaultStyle.fontFamily}`;
      ctx.font = fontStr;
      ctx.fillStyle = style.color || '#000000';

      for (let i = 0; i < segment.text.length; i++) {
        const char = segment.text[i];
        if (char === '\n') {
          charIndex++;
          continue;
        }

        const pos = charPositions.find(p => p.charIndex === charIndex);
        if (pos) {
          // Draw underline/strikethrough
          if (style.textDecoration === 'underline') {
            ctx.strokeStyle = style.color || '#000000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pos.x * scale, (pos.y + pos.height - 2) * scale);
            ctx.lineTo((pos.x + pos.width) * scale, (pos.y + pos.height - 2) * scale);
            ctx.stroke();
          } else if (style.textDecoration === 'line-through') {
            ctx.strokeStyle = style.color || '#000000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pos.x * scale, (pos.y + pos.height / 2) * scale);
            ctx.lineTo((pos.x + pos.width) * scale, (pos.y + pos.height / 2) * scale);
            ctx.stroke();
          }

          // Draw character
          const baseline = pos.y + pos.height * 0.8;
          ctx.fillText(char, pos.x * scale, baseline * scale);
        }

        charIndex++;
      }
    }

    // Draw cursor
    if (isFocused && cursorVisible && cursor.selectionStart === null) {
      const cursorPos = charPositions.find(p => p.charIndex === cursor.position);
      if (cursorPos) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(
          cursorPos.x * scale - 1,
          cursorPos.y * scale,
          2,
          cursorPos.height * scale
        );
      }
    }
  }, [segments, charPositions, cursor, cursorVisible, isFocused, scale, defaultStyle]);

  // Initial measurement
  useEffect(() => {
    measureAndLayout();
  }, [measureAndLayout]);

  // Re-render when state changes
  useEffect(() => {
    render();
  }, [render]);

  // Auto-focus
  useEffect(() => {
    if (autoFocus && hiddenInputRef.current) {
      hiddenInputRef.current.focus();
      setIsFocused(true);
    }
  }, [autoFocus]);

  // Get character index from mouse position
  const getCharIndexAtPoint = useCallback((clientX: number, clientY: number): number => {
    const container = containerRef.current;
    if (!container) return 0;

    const rect = container.getBoundingClientRect();
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;

    // Find the line
    let targetLine = lineMetrics.length - 1;
    for (let i = 0; i < lineMetrics.length; i++) {
      const line = lineMetrics[i];
      if (y < line.y + line.height) {
        targetLine = i;
        break;
      }
    }

    // Find position on line
    const linePositions = charPositions.filter(p => p.lineIndex === targetLine);
    if (linePositions.length === 0) return plainText.length;

    for (const pos of linePositions) {
      if (x < pos.x + pos.width / 2) {
        return pos.charIndex;
      }
    }

    // Return end of line
    const lastPos = linePositions[linePositions.length - 1];
    return lastPos.charIndex + 1;
  }, [charPositions, lineMetrics, scale, plainText.length]);

  // Mouse handlers for selection
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    hiddenInputRef.current?.focus();
    setIsFocused(true);

    const charIndex = getCharIndexAtPoint(e.clientX, e.clientY);

    if (e.shiftKey && cursor.position !== null) {
      // Extend selection
      const start = Math.min(cursor.position, charIndex);
      const end = Math.max(cursor.position, charIndex);
      setSelection(start, end);
    } else if (e.detail === 2) {
      // Double-click: select word
      const start = findWordBoundary(plainText, charIndex, 'start');
      const end = findWordBoundary(plainText, charIndex, 'end');
      setSelection(start, end);
      setSelectionAnchor(null);
    } else if (e.detail === 3) {
      // Triple-click: select line
      const lineIndex = charPositions.find(p => p.charIndex === charIndex)?.lineIndex ?? 0;
      const line = lineMetrics[lineIndex];
      if (line) {
        setSelection(line.startIndex, line.endIndex + 1);
      }
      setSelectionAnchor(null);
    } else {
      // Single click: position cursor
      setCursorPosition(charIndex);
      clearSelection();
      setSelectionAnchor(charIndex);
      setIsSelecting(true);
    }

    // Clear pending format on click (cursor move)
    clearPendingFormat();
  }, [getCharIndexAtPoint, cursor.position, plainText, charPositions, lineMetrics, setCursorPosition, setSelection, clearSelection, clearPendingFormat]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || selectionAnchor === null) return;

    const charIndex = getCharIndexAtPoint(e.clientX, e.clientY);
    const start = Math.min(selectionAnchor, charIndex);
    const end = Math.max(selectionAnchor, charIndex);

    if (start !== end) {
      setSelection(start, end);
    } else {
      clearSelection();
    }
  }, [isSelecting, selectionAnchor, getCharIndexAtPoint, setSelection, clearSelection]);

  const handleMouseUp = useCallback(() => {
    setIsSelecting(false);
  }, []);

  // Keyboard handlers
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    // Prevent default for handled keys
    const handledKeys = [
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      'Home', 'End', 'Backspace', 'Delete', 'Enter'
    ];
    // These keys are only handled with Ctrl modifier
    const ctrlOnlyKeys = ['a', 'b', 'i', 'u'];

    if (handledKeys.includes(e.key)) {
      e.preventDefault();
    }
    // Only prevent default for a, b, i, u when Ctrl is pressed
    if (isCtrl && ctrlOnlyKeys.includes(e.key.toLowerCase())) {
      e.preventDefault();
    }

    const hasSelection = cursor.selectionStart !== null && cursor.selectionEnd !== null;
    const selStart = hasSelection ? Math.min(cursor.selectionStart!, cursor.selectionEnd!) : cursor.position;
    const selEnd = hasSelection ? Math.max(cursor.selectionStart!, cursor.selectionEnd!) : cursor.position;

    // Navigation keys
    if (e.key === 'ArrowLeft') {
      if (isCtrl) {
        // Move word by word
        const newPos = findWordBoundary(plainText, cursor.position - 1, 'start');
        if (isShift) {
          const anchor = cursor.selectionStart ?? cursor.position;
          setSelection(Math.min(anchor, newPos), Math.max(anchor, newPos));
        } else {
          setCursorPosition(newPos);
          clearSelection();
        }
      } else if (isShift) {
        // Extend selection
        const newPos = Math.max(0, cursor.position - 1);
        const anchor = cursor.selectionStart ?? cursor.position;
        if (newPos < anchor) {
          setSelection(newPos, anchor);
        } else {
          setSelection(anchor, newPos);
        }
        useTextBoxStore.getState().setCursor({ position: newPos });
      } else {
        if (hasSelection) {
          setCursorPosition(selStart);
        } else {
          setCursorPosition(Math.max(0, cursor.position - 1));
        }
        clearSelection();
      }
      clearPendingFormat();
      return;
    }

    if (e.key === 'ArrowRight') {
      if (isCtrl) {
        const newPos = findWordBoundary(plainText, cursor.position, 'end');
        if (isShift) {
          const anchor = cursor.selectionEnd ?? cursor.position;
          setSelection(Math.min(anchor, newPos), Math.max(anchor, newPos));
        } else {
          setCursorPosition(newPos);
          clearSelection();
        }
      } else if (isShift) {
        const newPos = Math.min(plainText.length, cursor.position + 1);
        const anchor = cursor.selectionEnd ?? cursor.position;
        if (newPos > anchor) {
          setSelection(anchor, newPos);
        } else {
          setSelection(newPos, anchor);
        }
        useTextBoxStore.getState().setCursor({ position: newPos });
      } else {
        if (hasSelection) {
          setCursorPosition(selEnd);
        } else {
          setCursorPosition(Math.min(plainText.length, cursor.position + 1));
        }
        clearSelection();
      }
      clearPendingFormat();
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const currentPos = charPositions.find(p => p.charIndex === cursor.position);
      if (!currentPos) return;

      const targetLineIndex = e.key === 'ArrowUp'
        ? Math.max(0, currentPos.lineIndex - 1)
        : Math.min(lineMetrics.length - 1, currentPos.lineIndex + 1);

      const targetLinePositions = charPositions.filter(p => p.lineIndex === targetLineIndex);
      if (targetLinePositions.length === 0) return;

      // Find closest x position
      let closestPos = targetLinePositions[0];
      let closestDist = Math.abs(closestPos.x - currentPos.x);
      for (const pos of targetLinePositions) {
        const dist = Math.abs(pos.x - currentPos.x);
        if (dist < closestDist) {
          closestDist = dist;
          closestPos = pos;
        }
      }

      if (isShift) {
        const anchor = cursor.selectionStart ?? cursor.position;
        setSelection(Math.min(anchor, closestPos.charIndex), Math.max(anchor, closestPos.charIndex));
        useTextBoxStore.getState().setCursor({ position: closestPos.charIndex });
      } else {
        setCursorPosition(closestPos.charIndex);
        clearSelection();
      }
      clearPendingFormat();
      return;
    }

    if (e.key === 'Home') {
      const currentPos = charPositions.find(p => p.charIndex === cursor.position);
      const targetLine = lineMetrics[currentPos?.lineIndex ?? 0];
      const newPos = isCtrl ? 0 : (targetLine?.startIndex ?? 0);

      if (isShift) {
        const anchor = cursor.selectionEnd ?? cursor.position;
        setSelection(newPos, anchor);
      } else {
        setCursorPosition(newPos);
        clearSelection();
      }
      clearPendingFormat();
      return;
    }

    if (e.key === 'End') {
      const currentPos = charPositions.find(p => p.charIndex === cursor.position);
      const targetLine = lineMetrics[currentPos?.lineIndex ?? 0];
      const newPos = isCtrl ? plainText.length : (targetLine?.endIndex ?? plainText.length) + 1;

      if (isShift) {
        const anchor = cursor.selectionStart ?? cursor.position;
        setSelection(anchor, newPos);
      } else {
        setCursorPosition(Math.min(newPos, plainText.length));
        clearSelection();
      }
      clearPendingFormat();
      return;
    }

    // Select all
    if (isCtrl && e.key.toLowerCase() === 'a') {
      setSelection(0, plainText.length);
      return;
    }

    // Format shortcuts
    if (isCtrl && e.key.toLowerCase() === 'b') {
      applyFormat({ fontWeight: 'bold' });
      return;
    }
    if (isCtrl && e.key.toLowerCase() === 'i') {
      applyFormat({ fontStyle: 'italic' });
      return;
    }
    if (isCtrl && e.key.toLowerCase() === 'u') {
      applyFormat({ textDecoration: 'underline' });
      return;
    }

    // Deletion
    if (e.key === 'Backspace') {
      if (hasSelection) {
        const newSegments = deleteTextInRange(segments, selStart, selEnd);
        onChange(normalizeSegments(newSegments));
        setCursorPosition(selStart);
        clearSelection();
      } else if (cursor.position > 0) {
        const deleteStart = isCtrl
          ? findWordBoundary(plainText, cursor.position - 1, 'start')
          : cursor.position - 1;
        const newSegments = deleteTextInRange(segments, deleteStart, cursor.position);
        onChange(normalizeSegments(newSegments));
        setCursorPosition(deleteStart);
      }
      clearPendingFormat();
      return;
    }

    if (e.key === 'Delete') {
      if (hasSelection) {
        const newSegments = deleteTextInRange(segments, selStart, selEnd);
        onChange(normalizeSegments(newSegments));
        setCursorPosition(selStart);
        clearSelection();
      } else if (cursor.position < plainText.length) {
        const deleteEnd = isCtrl
          ? findWordBoundary(plainText, cursor.position, 'end')
          : cursor.position + 1;
        const newSegments = deleteTextInRange(segments, cursor.position, deleteEnd);
        onChange(normalizeSegments(newSegments));
      }
      clearPendingFormat();
      return;
    }

    // Enter key
    if (e.key === 'Enter') {
      insertChar('\n');
      return;
    }
  }, [cursor, plainText, segments, charPositions, lineMetrics, onChange, setCursorPosition, setSelection, clearSelection, clearPendingFormat]);

  // Insert text at cursor position (handles single char or multiple chars)
  const insertText = useCallback((text: string) => {
    if (!text) return;

    const hasSelection = cursor.selectionStart !== null && cursor.selectionEnd !== null;
    const selStart = hasSelection ? Math.min(cursor.selectionStart!, cursor.selectionEnd!) : cursor.position;
    const selEnd = hasSelection ? Math.max(cursor.selectionStart!, cursor.selectionEnd!) : cursor.position;

    // Determine style for new text
    let style: TextStyle;
    if (pendingFormat) {
      const baseStyle = getStyleAtPosition(segments, selStart) || defaultStyle;
      style = { ...baseStyle, ...pendingFormat };
    } else {
      style = getStyleAtPosition(segments, selStart > 0 ? selStart - 1 : selStart) || defaultStyle;
    }

    let newSegments = segments;

    // Delete selection first if any
    if (hasSelection) {
      newSegments = deleteTextInRange(newSegments, selStart, selEnd);
    }

    // Insert the entire text at once
    newSegments = insertTextAtPosition(newSegments, selStart, text, style);

    onChange(normalizeSegments(newSegments));
    setCursorPosition(selStart + text.length);
    clearSelection();
    clearPendingFormat();
  }, [cursor, pendingFormat, segments, defaultStyle, onChange, setCursorPosition, clearSelection, clearPendingFormat]);

  // Text input handler
  const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const text = input.value;
    input.value = '';

    if (text) {
      insertText(text);
    }
  }, [insertText]);

  // Helper for single char insertion (used by Enter key)
  const insertChar = useCallback((char: string) => {
    insertText(char);
  }, [insertText]);

  // Apply format to selection or set pending format
  const applyFormat = useCallback((format: Partial<TextStyle>) => {
    const hasSelection = cursor.selectionStart !== null && cursor.selectionEnd !== null;

    if (hasSelection) {
      const selStart = Math.min(cursor.selectionStart!, cursor.selectionEnd!);
      const selEnd = Math.max(cursor.selectionStart!, cursor.selectionEnd!);

      // Check current format to toggle
      const currentStyle = getSelectionStyle(segments, selStart, selEnd);
      const toggledFormat: Partial<TextStyle> = {};

      for (const [key, value] of Object.entries(format)) {
        const currentValue = currentStyle.style[key as keyof TextStyle];
        if (key === 'fontWeight') {
          toggledFormat.fontWeight = currentValue === 'bold' ? 'normal' : 'bold';
        } else if (key === 'fontStyle') {
          toggledFormat.fontStyle = currentValue === 'italic' ? 'normal' : 'italic';
        } else if (key === 'textDecoration') {
          toggledFormat.textDecoration = currentValue === value ? 'none' : value as TextStyle['textDecoration'];
        } else {
          (toggledFormat as any)[key] = value;
        }
      }

      const newSegments = applyStyleToRange(segments, selStart, selEnd, toggledFormat);
      onChange(normalizeSegments(newSegments));
    } else {
      // Set pending format
      const currentStyle = getStyleAtPosition(segments, cursor.position) || defaultStyle;
      const toggledFormat: Partial<TextStyle> = {};

      for (const [key, value] of Object.entries(format)) {
        if (key === 'fontWeight') {
          const current = pendingFormat?.fontWeight ?? currentStyle.fontWeight;
          toggledFormat.fontWeight = current === 'bold' ? 'normal' : 'bold';
        } else if (key === 'fontStyle') {
          const current = pendingFormat?.fontStyle ?? currentStyle.fontStyle;
          toggledFormat.fontStyle = current === 'italic' ? 'normal' : 'italic';
        } else if (key === 'textDecoration') {
          const current = pendingFormat?.textDecoration ?? currentStyle.textDecoration;
          toggledFormat.textDecoration = current === value ? 'none' : value as TextStyle['textDecoration'];
        } else {
          (toggledFormat as any)[key] = value;
        }
      }

      useTextBoxStore.getState().mergePendingFormat(toggledFormat);
    }
  }, [cursor, segments, defaultStyle, pendingFormat, onChange]);

  // Handle blur with delayed check to properly detect toolbar clicks
  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // Check if focus is moving to the format toolbar
    // If so, don't trigger onBlur (which would finish editing and hide the toolbar)
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    const isMovingToToolbar = relatedTarget?.closest('[data-format-toolbar="true"]') !== null;

    if (isMovingToToolbar) {
      // Focus is moving to the toolbar, keep editing state active
      return;
    }

    // Use a small delay to check if a toolbar interaction is happening
    // This handles cases where relatedTarget is null (e.g., clicking on buttons)
    setTimeout(() => {
      // Check if focus went to a toolbar element or if document.activeElement is in toolbar
      const activeElement = document.activeElement as HTMLElement | null;
      const isInToolbar = activeElement?.closest('[data-format-toolbar="true"]') !== null;

      // Also check if there's a recently clicked toolbar element
      const toolbarElements = document.querySelectorAll('[data-format-toolbar="true"]');
      let isClickInToolbar = false;
      toolbarElements.forEach((toolbar) => {
        if (toolbar.contains(document.activeElement)) {
          isClickInToolbar = true;
        }
      });

      if (isInToolbar || isClickInToolbar) {
        // Focus went to toolbar, refocus the hidden input to maintain editing state
        hiddenInputRef.current?.focus();
        return;
      }

      // Also check properties panels
      const isInPropertiesPanel = activeElement?.closest('.properties-panel-overlay') !== null ||
                                   activeElement?.closest('.text-properties-panel') !== null ||
                                   activeElement?.closest('.box-properties-panel') !== null;

      if (isInPropertiesPanel) {
        // Don't close if interacting with properties panel
        return;
      }

      setIsFocused(false);
      onBlur?.();
    }, 10);
  }, [onBlur]);

  return (
    <div
      ref={containerRef}
      className="rich-text-editor"
      style={{
        width: width * scale,
        height: height * scale,
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <canvas
        ref={canvasRef}
        width={width * scale}
        height={height * scale}
        className="rich-text-canvas"
      />
      <input
        ref={hiddenInputRef}
        type="text"
        className="rich-text-hidden-input"
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    </div>
  );
}

// Export a hook to get the current selection style for toolbar display
export function useSelectionStyle(segments: RichTextSegment[], defaultStyle: TextStyle) {
  const { cursor, pendingFormat } = useTextBoxStore();

  return useMemo(() => {
    if (pendingFormat) {
      const baseStyle = getStyleAtPosition(segments, cursor.position) || defaultStyle;
      return {
        style: { ...baseStyle, ...pendingFormat },
        isMixed: {
          fontFamily: false,
          fontSize: false,
          fontWeight: false,
          fontStyle: false,
          textDecoration: false,
          color: false,
        },
      };
    }

    const hasSelection = cursor.selectionStart !== null && cursor.selectionEnd !== null;

    if (hasSelection) {
      const selStart = Math.min(cursor.selectionStart!, cursor.selectionEnd!);
      const selEnd = Math.max(cursor.selectionStart!, cursor.selectionEnd!);
      return getSelectionStyle(segments, selStart, selEnd);
    }

    return {
      style: getStyleAtPosition(segments, cursor.position > 0 ? cursor.position - 1 : 0) || defaultStyle,
      isMixed: {
        fontFamily: false,
        fontSize: false,
        fontWeight: false,
        fontStyle: false,
        textDecoration: false,
        color: false,
      },
    };
  }, [segments, cursor, pendingFormat, defaultStyle]);
}
