/**
 * TextEditLayer - Renders text blocks for editing
 * Allows users to click on text blocks and edit them inline
 */

import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useEditingStore } from '../../store/editingStore';
import { useHistoryStore } from '../../store/historyStore';
import { cancelWorkspaceGroup, registerPendingEditor } from '../../store/workspaceHistory';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import type { TextBlock } from '../../editing/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportRect } from '../../utils/viewportMapping';
import './TextEditLayer.css';

interface TextEditLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  onTextLayout?: (blockId: string) => void;
}

const EMPTY_TEXT_BLOCKS: TextBlock[] = [];

export function TextEditLayer({
  page,
  pageNumber,
  scale,
  rotation,
  onTextLayout,
}: TextEditLayerProps) {
  const {
    mode,
    setMode,
    textBlocks,
    setTextBlocks,
    selectedBlockId,
    selectBlock,
    updateBlockText,
    textEdits,
  } = useEditingStore();

  const [analysisError, setAnalysisError] = useState<{ page: PDFPageProxy; message: string } | null>(null);
  const editingGroup = useRef<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Get blocks for this page
  const pageBlocks = textBlocks.get(pageNumber) ?? EMPTY_TEXT_BLOCKS;
  const hasBlocks = textBlocks.has(pageNumber);
  const isLoading = !hasBlocks && analysisError?.page !== page;
  const readOnlyReason = pageBlocks.find(block => !block.editable)?.unsupportedReason;
  const layouts = useMemo(() => new Map(textEdits.map(edit => [edit.blockId, edit.layout])), [textEdits]);

  // Load text blocks when entering text mode
  useEffect(() => {
    if (mode !== 'text') return;

    // Only load if we don't have blocks for this page
    if (hasBlocks) return;

    let cancelled = false;
    detectTextBlocks(page)
      .then((blocks) => {
        if (cancelled) return;
        setAnalysisError(null);
        setTextBlocks(pageNumber, blocks);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to detect text blocks:', err);
        setAnalysisError({ page, message: err instanceof Error ? err.message : 'Could not analyze text' });
      });
    return () => { cancelled = true; };
  }, [mode, page, pageNumber, hasBlocks, setTextBlocks]);

  // Transform block position based on rotation
  const transformRect = useCallback(
    (block: TextBlock) => {
      const { x, y, width, height } = mapViewportRect(
        layouts.get(block.id)?.targetRect ?? block.rect,
        page.getViewport({ scale: 1, rotation: 0 }),
        page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) }),
      );
      return {
        left: x,
        top: y,
        width,
        height,
      };
    },
    [page, rotation, scale, layouts]
  );

  const handleBlockClick = useCallback(
    (block: TextBlock, e: React.MouseEvent) => {
      e.stopPropagation();

      if (!block.editable || editingBlockId === block.id) return;

      useHistoryStore.getState().endGroup();
      editingGroup.current = `text:${block.id}:${crypto.randomUUID()}`;

      selectBlock(block.id);
      setEditingBlockId(block.id);
      setEditText(block.text);
    },
    [editingBlockId, selectBlock]
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setEditText(e.target.value);
      if (editingBlockId && editingGroup.current) updateBlockText(editingBlockId, e.target.value, editingGroup.current);
    },
    [editingBlockId, updateBlockText]
  );

  const handleBlur = useCallback((keepSelection = false) => {
    if (!editingGroup.current) return;
    editingGroup.current = null;
    useHistoryStore.getState().endGroup();
    setEditingBlockId(null);
    if (!keepSelection) selectBlock(null);
  }, [selectBlock]);
  useEffect(() => registerPendingEditor(() => handleBlur()), [handleBlur]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter/Escape first confirm or dismiss an IME candidate, not the edit.
      // Some browsers report the final composition key as keyCode 229.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.key === 'Escape') {
        // Cancel this focus session without leaving its live draft in history.
        const key = editingGroup.current;
        editingGroup.current = null;
        if (key) cancelWorkspaceGroup(key);
        setEditingBlockId(null);
        selectBlock(null);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Save and exit on Enter (Shift+Enter for new line)
        e.preventDefault();
        handleBlur();
      }
    },
    [handleBlur, selectBlock]
  );

  // Focus textarea when editing starts
  useEffect(() => {
    if (editingBlockId && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editingBlockId]);

  // Handle click on the layer (outside any text block) - exit edit mode
  const handleLayerClick = useCallback((e: React.MouseEvent) => {
    // Only handle direct clicks on the layer, not bubbled events from blocks
    if (e.target === e.currentTarget) {
      // Save any pending edit first
      if (editingBlockId) {
        const block = pageBlocks.find((b) => b.id === editingBlockId);
        if (block && editText !== block.text) {
          updateBlockText(editingBlockId, editText);
        }
      }
      // Exit edit mode
      setMode('none');
      setEditingBlockId(null);
      selectBlock(null);
    }
  }, [editingBlockId, editText, pageBlocks, updateBlockText, setMode, selectBlock]);

  // Don't render if not in text mode
  if (mode !== 'text') return null;

  const selectedBlock = pageBlocks.find(block => block.id === selectedBlockId && block.editable);
  const selectedRect = selectedBlock ? transformRect(selectedBlock) : null;
  const viewportWidth = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) }).width;

  return (
    <div className="text-edit-layer" onClick={handleLayerClick}>
      {isLoading && (
        <div className="text-edit-loading">
          <span>Analyzing text...</span>
        </div>
      )}
      {analysisError?.page === page && (
        <div className="text-edit-loading" role="alert">{analysisError.message}</div>
      )}
      {readOnlyReason && <div className="text-edit-readonly" role="status"><span>{readOnlyReason}</span>
        <button type="button" onClick={() => setMode('none')}>Exit text editing</button></div>}

      {pageBlocks.map((block) => {
        const style = transformRect(block);
        const isSelected = selectedBlockId === block.id;
        const isEditing = block.editable && editingBlockId === block.id;
        const layout = layouts.get(block.id);
        const fontSize = (layout?.fontSize ?? block.style.fontSize) * scale;
        const lineHeight = layout?.lineHeight ?? block.style.lineHeight;

        return (
          <div
            key={block.id}
            className={`text-block ${!block.editable ? 'readonly' : ''} ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''}`}
            aria-disabled={!block.editable || undefined}
            title={block.unsupportedReason}
            // A PDF glyph rectangle can be shorter than an HTML line box.
            // Enlarge only the input surface, leaving the PDF removal bounds intact.
            style={isEditing ? { ...style, minHeight: Math.max(32, fontSize * lineHeight + 8) } : style}
            onClick={(e) => handleBlockClick(block, e)}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                className="text-block-editor"
                aria-label={`Edit text on page ${pageNumber}`}
                value={editText}
                onChange={handleTextChange}
                onBlur={event => handleBlur(!!actionsRef.current?.contains(event.relatedTarget))}
                onKeyDown={handleKeyDown}
                style={{
                  fontSize,
                  color: layout?.fontColor ?? block.style.fontColor ?? '#000000',
                  textAlign: layout?.alignment ?? block.style.alignment,
                  lineHeight,
                }}
              />
            ) : (
              <div className="text-block-content">
                {block.text}
              </div>
            )}
          </div>
        );
      })}
      {pageBlocks.some(block => layouts.get(block.id)) && <p className="text-edit-draft-hint" role="status">Layout draft — apply content changes to update the page.</p>}
      {onTextLayout && selectedBlock && selectedRect && <div ref={actionsRef} className="text-edit-actions" style={{ left: Math.max(0, Math.min(selectedRect.left, Number.isFinite(viewportWidth) ? viewportWidth - 140 : selectedRect.left)), top: Math.max(0, selectedRect.top - 38) }}>
        <button type="button" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => {
          event.stopPropagation(); handleBlur(); onTextLayout(selectedBlock.id);
        }}>Text layout…</button>
      </div>}
    </div>
  );
}
