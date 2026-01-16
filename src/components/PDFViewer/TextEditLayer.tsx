/**
 * TextEditLayer - Renders text blocks for editing
 * Allows users to click on text blocks and edit them inline
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useEditingStore } from '../../store/editingStore';
import { detectTextBlocks } from '../../editing/TextBlockDetector';
import type { TextBlock } from '../../editing/types';
import './TextEditLayer.css';

interface TextEditLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
}

export function TextEditLayer({
  page,
  pageNumber,
  scale,
  rotation,
}: TextEditLayerProps) {
  const {
    mode,
    setMode,
    textBlocks,
    setTextBlocks,
    selectedBlockId,
    selectBlock,
    updateBlockText,
  } = useEditingStore();

  const [isLoading, setIsLoading] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Get blocks for this page
  const pageBlocks = textBlocks.get(pageNumber) || [];

  // Load text blocks when entering text mode
  useEffect(() => {
    if (mode !== 'text') return;

    // Only load if we don't have blocks for this page
    if (textBlocks.has(pageNumber)) return;

    setIsLoading(true);
    detectTextBlocks(page)
      .then((blocks) => {
        setTextBlocks(pageNumber, blocks);
      })
      .catch((err) => {
        console.error('Failed to detect text blocks:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [mode, page, pageNumber, textBlocks, setTextBlocks]);

  // Transform block position based on rotation
  const transformRect = useCallback(
    (block: TextBlock) => {
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const pageWidth = viewport.width;
      const pageHeight = viewport.height;

      let { x, y, width, height } = block.rect;

      // Apply rotation transformation
      switch (rotation) {
        case 90:
          [x, y] = [y, pageWidth - x - width];
          [width, height] = [height, width];
          break;
        case 180:
          x = pageWidth - x - width;
          y = pageHeight - y - height;
          break;
        case 270:
          [x, y] = [pageHeight - y - height, x];
          [width, height] = [height, width];
          break;
      }

      return {
        left: x * scale,
        top: y * scale,
        width: width * scale,
        height: height * scale,
      };
    },
    [page, rotation, scale]
  );

  const handleBlockClick = useCallback(
    (block: TextBlock, e: React.MouseEvent) => {
      e.stopPropagation();

      if (editingBlockId === block.id) return;

      // If clicking a different block while editing, save current edit
      if (editingBlockId && editText !== '') {
        const currentBlock = pageBlocks.find((b) => b.id === editingBlockId);
        if (currentBlock && editText !== currentBlock.text) {
          updateBlockText(editingBlockId, editText);
        }
      }

      selectBlock(block.id);
      setEditingBlockId(block.id);
      setEditText(block.text);
    },
    [editingBlockId, editText, pageBlocks, selectBlock, updateBlockText]
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setEditText(e.target.value);
    },
    []
  );

  const handleBlur = useCallback(() => {
    if (editingBlockId && editText !== '') {
      const block = pageBlocks.find((b) => b.id === editingBlockId);
      if (block && editText !== block.text) {
        updateBlockText(editingBlockId, editText);
      }
    }
    setEditingBlockId(null);
    selectBlock(null);
  }, [editingBlockId, editText, pageBlocks, updateBlockText, selectBlock]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Cancel editing, revert to original
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
      if (editingBlockId && editText !== '') {
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

  return (
    <div className="text-edit-layer" onClick={handleLayerClick}>
      {isLoading && (
        <div className="text-edit-loading">
          <span>Analyzing text...</span>
        </div>
      )}

      {pageBlocks.map((block) => {
        const style = transformRect(block);
        const isSelected = selectedBlockId === block.id;
        const isEditing = editingBlockId === block.id;

        return (
          <div
            key={block.id}
            className={`text-block ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''}`}
            style={style}
            onClick={(e) => handleBlockClick(block, e)}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                className="text-block-editor"
                value={editText}
                onChange={handleTextChange}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                style={{
                  fontSize: block.style.fontSize * scale * 0.75,
                  textAlign: block.style.alignment,
                  lineHeight: block.style.lineHeight,
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
    </div>
  );
}
