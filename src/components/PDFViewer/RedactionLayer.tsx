import { useLocale, t } from "../../i18n";
/**
 * RedactionLayer - Allows users to mark areas for redaction
 * Shows pending redactions as outlined boxes, applied as solid black
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportPoint, mapViewportRect } from '../../utils/viewportMapping';
import { useEditingStore } from '../../store/editingStore';
import type { RedactionArea } from '../../editing/types';
import './RedactionLayer.css';

interface RedactionLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
}

export function RedactionLayer({
  page,
  pageNumber,
  scale,
  rotation,
}: RedactionLayerProps) {
  useLocale();
  const {
    mode,
    redactions,
    selectedRedactionId,
    addRedaction,
    removeRedaction,
    selectRedaction,
    updateRedaction,
  } = useEditingStore();

  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawEnd, setDrawEnd] = useState<{ x: number; y: number } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Get redactions for this page
  const pageRedactions = redactions.filter((r) => r.pageNumber === pageNumber);

  const transformRect = useCallback((rect: RedactionArea['rect']) => {
    const unrotated = page.getViewport({ scale: 1, rotation: 0 });
    const display = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });
    const mapped = mapViewportRect(rect, unrotated, display);
    return { left: mapped.x, top: mapped.y, width: mapped.width, height: mapped.height };
  }, [page, rotation, scale]);

  const inverseTransformPoint = useCallback((x: number, y: number) => {
    const unrotated = page.getViewport({ scale: 1, rotation: 0 });
    const display = page.getViewport({ scale, rotation: getEffectiveRotation(page, rotation) });
    return mapViewportPoint(x, y, display, unrotated);
  }, [page, rotation, scale]);

  // Pointer events cover mouse, pen and touch. A second finger turns the
  // gesture into a pinch/scroll, so the unfinished rectangle is dropped.
  const activePointer = useRef<number | null>(null);
  const localPoint = (e: React.PointerEvent) => {
    const rect = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const cancelDrawing = useCallback(() => {
    activePointer.current = null;
    setIsDrawing(false);
    setDrawStart(null);
    setDrawEnd(null);
  }, []);

  // Escape abandons the rectangle being drawn (focus usually stays elsewhere).
  useEffect(() => {
    if (!isDrawing) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelDrawing(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDrawing, cancelDrawing]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (mode !== 'redact' || !layerRef.current) return;
      if (activePointer.current !== null) { cancelDrawing(); return; }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Existing boxes and their controls handle their own clicks.
      if ((e.target as HTMLElement).closest('.redaction-box')) return;
      const point = localPoint(e);
      activePointer.current = e.pointerId;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      setIsDrawing(true);
      setDrawStart(point);
      setDrawEnd(point);
      selectRedaction(null);
    },
    [mode, selectRedaction, cancelDrawing]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing || !drawStart || e.pointerId !== activePointer.current || !layerRef.current) return;
      setDrawEnd(localPoint(e));
    },
    [isDrawing, drawStart]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    if (!isDrawing || !drawStart || !drawEnd) {
      cancelDrawing();
      return;
    }

    // Calculate rectangle in screen coordinates
    const minX = Math.min(drawStart.x, drawEnd.x);
    const minY = Math.min(drawStart.y, drawEnd.y);
    const width = Math.abs(drawEnd.x - drawStart.x);
    const height = Math.abs(drawEnd.y - drawStart.y);

    // Only create redaction if it has some size
    if (width > 5 && height > 5) {
      // Convert to PDF coordinates
      const start = inverseTransformPoint(minX, minY);
      const end = inverseTransformPoint(minX + width, minY + height);

      const pdfRect = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };

      addRedaction({
        pageNumber,
        rect: pdfRect,
        overlayColor: '#000000',
      });
    }

    cancelDrawing();
  }, [isDrawing, drawStart, drawEnd, pageNumber, addRedaction, inverseTransformPoint, cancelDrawing]);

  const handleRedactionClick = useCallback(
    (redaction: RedactionArea, e: React.MouseEvent) => {
      e.stopPropagation();
      selectRedaction(redaction.id);
    },
    [selectRedaction]
  );

  const handleDelete = useCallback(
    (redactionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      removeRedaction(redactionId);
    },
    [removeRedaction]
  );

  const handleOverlayTextChange = useCallback(
    (redactionId: string, overlayText: string) => {
      updateRedaction(redactionId, { overlayText });
    },
    [updateRedaction]
  );

  // Don't render if not in redact mode
  if (mode !== 'redact') return null;

  // Calculate drawing rectangle
  let drawRect = null;
  if (isDrawing && drawStart && drawEnd) {
    drawRect = {
      left: Math.min(drawStart.x, drawEnd.x),
      top: Math.min(drawStart.y, drawEnd.y),
      width: Math.abs(drawEnd.x - drawStart.x),
      height: Math.abs(drawEnd.y - drawStart.y),
    };
  }

  return (
    <div
      ref={layerRef}
      className="redaction-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelDrawing}
      onLostPointerCapture={event => { if (event.pointerId === activePointer.current) cancelDrawing(); }}
    >
      {/* Existing redactions */}
      {pageRedactions.map((redaction) => {
        const style = transformRect(redaction.rect);
        const isSelected = selectedRedactionId === redaction.id;

        return (
          <div
            key={redaction.id}
            className={`redaction-box ${redaction.applied ? 'applied' : 'pending'} ${isSelected ? 'selected' : ''}`}
            style={{
              ...style,
              backgroundColor: redaction.applied ? redaction.overlayColor : 'transparent',
            }}
            onClick={(e) => handleRedactionClick(redaction, e)}
            {...(!redaction.applied ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': t("m.redact.910892"),
              'aria-pressed': isSelected,
              onFocus: () => selectRedaction(redaction.id),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); removeRedaction(redaction.id); }
              },
            } : {})}
          >
            {!redaction.applied && (
              <>
                <span className="redaction-label">{t("m.redact.910892")}</span>
                {isSelected && (
                  <div className="redaction-controls">
                    <input
                      type="text"
                      placeholder={t("m.overlay.text.eae931")}
                      value={redaction.overlayText || ''}
                      onChange={(e) => handleOverlayTextChange(redaction.id, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="redaction-overlay-input"
                    />
                    <button
                      type="button"
                      aria-label={t("m.remove.redaction.5b83df")}
                      className="redaction-delete-btn"
                      onClick={(e) => handleDelete(redaction.id, e)}
                      title={t("m.remove.redaction.5b83df")}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </>
            )}
            {redaction.applied && redaction.overlayText && (
              <span className="redaction-overlay-text">{redaction.overlayText}</span>
            )}
          </div>
        );
      })}

      {/* Drawing preview */}
      {drawRect && (
        <div
          className="redaction-box drawing"
          style={drawRect}
        >
          <span className="redaction-label">{t("m.redact.910892")}</span>
        </div>
      )}
    </div>
  );
}
