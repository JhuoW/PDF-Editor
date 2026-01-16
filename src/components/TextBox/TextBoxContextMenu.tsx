import { useState, useEffect, useRef } from 'react';
import type { FreeTextAnnotation } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import './TextBoxContextMenu.css';

interface TextBoxContextMenuProps {
  annotation: FreeTextAnnotation;
  position: { x: number; y: number };
  onClose: () => void;
  onEditText: () => void;
}

export function TextBoxContextMenu({
  annotation,
  position,
  onClose,
  onEditText,
}: TextBoxContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showRotateSubmenu, setShowRotateSubmenu] = useState(false);

  const { updateAnnotation, deleteAnnotation } = useAnnotationStore();
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
      id: `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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

      <div className="menu-separator" />

      <div
        className="menu-item has-submenu"
        onMouseEnter={() => {
          setShowRotateSubmenu(true);
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
