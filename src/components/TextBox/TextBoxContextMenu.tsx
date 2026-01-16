import { useState, useEffect, useRef } from 'react';
import type { FreeTextAnnotation, TextStyle } from '../../annotations/types';
import { DEFAULT_TEXT_STYLE } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './TextBoxContextMenu.css';

interface TextBoxContextMenuProps {
  annotation: FreeTextAnnotation;
  position: { x: number; y: number };
  onClose: () => void;
  onEditText: () => void;
  onShowTextProperties?: () => void;
  onShowBoxProperties?: () => void;
}

export function TextBoxContextMenu({
  annotation,
  position,
  onClose,
  onEditText,
  onShowTextProperties,
  onShowBoxProperties,
}: TextBoxContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showRotateSubmenu, setShowRotateSubmenu] = useState(false);
  const [showAlignSubmenu, setShowAlignSubmenu] = useState(false);
  const [showLayerSubmenu, setShowLayerSubmenu] = useState(false);

  const { updateAnnotation, deleteAnnotation, getAnnotationsForPage } = useAnnotationStore();
  const { recordUpdate, recordDelete } = useAnnotationHistoryStore();

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCut = () => {
    // Copy to clipboard then delete
    navigator.clipboard.writeText(annotation.content || '');
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(annotation.content || '');
    onClose();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const previousState = { ...annotation };
        const newContent = (annotation.content || '') + text;
        updateAnnotation(annotation.id, { content: newContent });
        recordUpdate({ ...annotation, content: newContent }, previousState);
      }
    } catch (err) {
      console.error('Failed to paste:', err);
    }
    onClose();
  };

  const handleDuplicate = () => {
    // Create a copy with offset position
    const newRect: [number, number, number, number] = [
      annotation.rect[0] + 20,
      annotation.rect[1] - 20,
      annotation.rect[2],
      annotation.rect[3],
    ];

    const duplicated: FreeTextAnnotation = {
      ...annotation,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      rect: newRect,
      createdAt: new Date(),
      modifiedAt: new Date(),
    };

    useAnnotationStore.getState().addAnnotation(duplicated);
    useAnnotationHistoryStore.getState().recordAdd(duplicated);
    onClose();
  };

  const handleDelete = () => {
    recordDelete(annotation);
    deleteAnnotation(annotation.id);
    onClose();
  };

  const handleRotate = (degrees: number) => {
    const previousState = { ...annotation };
    let newRotation = ((annotation.rotation || 0) + degrees) % 360;
    if (newRotation < 0) newRotation += 360;
    updateAnnotation(annotation.id, { rotation: newRotation });
    recordUpdate({ ...annotation, rotation: newRotation }, previousState);
    onClose();
  };

  const handleLockPosition = () => {
    const previousState = { ...annotation };
    const newLocked = !annotation.isLocked;
    updateAnnotation(annotation.id, { isLocked: newLocked });
    recordUpdate({ ...annotation, isLocked: newLocked }, previousState);
    onClose();
  };

  // Z-index / Layer operations
  const handleBringToFront = () => {
    const pageAnnotations = getAnnotationsForPage(annotation.pageNumber);
    const maxZIndex = Math.max(
      ...pageAnnotations.map((a) => (a as FreeTextAnnotation).zIndex || 0),
      0
    );
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: maxZIndex + 1 });
    recordUpdate({ ...annotation, zIndex: maxZIndex + 1 }, previousState);
    onClose();
  };

  const handleSendToBack = () => {
    const pageAnnotations = getAnnotationsForPage(annotation.pageNumber);
    const minZIndex = Math.min(
      ...pageAnnotations.map((a) => (a as FreeTextAnnotation).zIndex || 0),
      0
    );
    const previousState = { ...annotation };
    updateAnnotation(annotation.id, { zIndex: minZIndex - 1 });
    recordUpdate({ ...annotation, zIndex: minZIndex - 1 }, previousState);
    onClose();
  };

  const handleBringForward = () => {
    const previousState = { ...annotation };
    const currentZ = annotation.zIndex || 0;
    updateAnnotation(annotation.id, { zIndex: currentZ + 1 });
    recordUpdate({ ...annotation, zIndex: currentZ + 1 }, previousState);
    onClose();
  };

  const handleSendBackward = () => {
    const previousState = { ...annotation };
    const currentZ = annotation.zIndex || 0;
    updateAnnotation(annotation.id, { zIndex: currentZ - 1 });
    recordUpdate({ ...annotation, zIndex: currentZ - 1 }, previousState);
    onClose();
  };

  // Alignment operations
  const getAnnotationStyle = (ann: FreeTextAnnotation): TextStyle => {
    return ann.style || DEFAULT_TEXT_STYLE;
  };

  const handleAlignText = (textAlign: TextStyle['textAlign']) => {
    const previousState = { ...annotation };
    const currentStyle = getAnnotationStyle(annotation);
    const newStyle = { ...currentStyle, textAlign };
    updateAnnotation(annotation.id, { style: newStyle });
    recordUpdate({ ...annotation, style: newStyle }, previousState);
    onClose();
  };

  // Adjust menu position to stay within viewport
  const adjustedPosition = { ...position };
  if (typeof window !== 'undefined') {
    const menuWidth = 200;
    const menuHeight = 400;
    if (position.x + menuWidth > window.innerWidth) {
      adjustedPosition.x = window.innerWidth - menuWidth - 10;
    }
    if (position.y + menuHeight > window.innerHeight) {
      adjustedPosition.y = window.innerHeight - menuHeight - 10;
    }
  }

  return (
    <div
      ref={menuRef}
      className="textbox-context-menu"
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      <button className="menu-item" onClick={handleCut}>
        <span className="menu-label">Cut</span>
        <span className="menu-shortcut">Ctrl+X</span>
      </button>
      <button className="menu-item" onClick={handleCopy}>
        <span className="menu-label">Copy</span>
        <span className="menu-shortcut">Ctrl+C</span>
      </button>
      <button className="menu-item" onClick={handlePaste}>
        <span className="menu-label">Paste</span>
        <span className="menu-shortcut">Ctrl+V</span>
      </button>
      <button className="menu-item" onClick={handleDuplicate}>
        <span className="menu-label">Duplicate</span>
        <span className="menu-shortcut">Ctrl+D</span>
      </button>

      <div className="menu-separator" />

      <button className="menu-item" onClick={handleDelete}>
        <span className="menu-label">Delete</span>
        <span className="menu-shortcut">Del</span>
      </button>

      <div className="menu-separator" />

      <button className="menu-item" onClick={onEditText}>
        <span className="menu-label">Edit Text</span>
      </button>
      {onShowTextProperties && (
        <button className="menu-item" onClick={() => { onShowTextProperties(); onClose(); }}>
          <span className="menu-label">Text Properties...</span>
        </button>
      )}
      {onShowBoxProperties && (
        <button className="menu-item" onClick={() => { onShowBoxProperties(); onClose(); }}>
          <span className="menu-label">Box Properties...</span>
        </button>
      )}

      <div className="menu-separator" />

      {/* Layer / Z-index submenu */}
      <div
        className="menu-item has-submenu"
        onMouseEnter={() => {
          setShowLayerSubmenu(true);
          setShowRotateSubmenu(false);
          setShowAlignSubmenu(false);
        }}
        onMouseLeave={() => setShowLayerSubmenu(false)}
      >
        <span className="menu-label">Arrange</span>
        <span className="submenu-arrow">&#9654;</span>
        {showLayerSubmenu && (
          <div className="submenu">
            <button className="menu-item" onClick={handleBringToFront}>
              <span className="menu-label">Bring to Front</span>
              <span className="menu-shortcut">Ctrl+Shift+]</span>
            </button>
            <button className="menu-item" onClick={handleSendToBack}>
              <span className="menu-label">Send to Back</span>
              <span className="menu-shortcut">Ctrl+Shift+[</span>
            </button>
            <button className="menu-item" onClick={handleBringForward}>
              <span className="menu-label">Bring Forward</span>
              <span className="menu-shortcut">Ctrl+]</span>
            </button>
            <button className="menu-item" onClick={handleSendBackward}>
              <span className="menu-label">Send Backward</span>
              <span className="menu-shortcut">Ctrl+[</span>
            </button>
          </div>
        )}
      </div>

      {/* Alignment submenu */}
      <div
        className="menu-item has-submenu"
        onMouseEnter={() => {
          setShowAlignSubmenu(true);
          setShowRotateSubmenu(false);
          setShowLayerSubmenu(false);
        }}
        onMouseLeave={() => setShowAlignSubmenu(false)}
      >
        <span className="menu-label">Align Text</span>
        <span className="submenu-arrow">&#9654;</span>
        {showAlignSubmenu && (
          <div className="submenu">
            <button className="menu-item" onClick={() => handleAlignText('left')}>
              <span className="menu-label">Align Left</span>
              <span className="menu-shortcut">Ctrl+L</span>
            </button>
            <button className="menu-item" onClick={() => handleAlignText('center')}>
              <span className="menu-label">Align Center</span>
              <span className="menu-shortcut">Ctrl+E</span>
            </button>
            <button className="menu-item" onClick={() => handleAlignText('right')}>
              <span className="menu-label">Align Right</span>
              <span className="menu-shortcut">Ctrl+R</span>
            </button>
            <button className="menu-item" onClick={() => handleAlignText('justify')}>
              <span className="menu-label">Justify</span>
              <span className="menu-shortcut">Ctrl+J</span>
            </button>
          </div>
        )}
      </div>

      {/* Rotate submenu */}
      <div
        className="menu-item has-submenu"
        onMouseEnter={() => {
          setShowRotateSubmenu(true);
          setShowAlignSubmenu(false);
          setShowLayerSubmenu(false);
        }}
        onMouseLeave={() => setShowRotateSubmenu(false)}
      >
        <span className="menu-label">Rotate</span>
        <span className="submenu-arrow">&#9654;</span>
        {showRotateSubmenu && (
          <div className="submenu">
            <button className="menu-item" onClick={() => handleRotate(90)}>
              Rotate 90° CW
            </button>
            <button className="menu-item" onClick={() => handleRotate(-90)}>
              Rotate 90° CCW
            </button>
            <button className="menu-item" onClick={() => handleRotate(180)}>
              Rotate 180°
            </button>
            <button className="menu-item" onClick={() => handleRotate(-(annotation.rotation || 0))}>
              Reset Rotation
            </button>
          </div>
        )}
      </div>

      <div className="menu-separator" />

      <button className="menu-item" onClick={handleLockPosition}>
        <span className="menu-label">{annotation.isLocked ? 'Unlock' : 'Lock'} Position</span>
      </button>
    </div>
  );
}
