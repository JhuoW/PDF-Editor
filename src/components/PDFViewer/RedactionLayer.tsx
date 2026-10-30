import { useLocale, t } from "../../i18n";
/**
 * RedactionLayer - Allows users to mark areas for redaction
 * Shows pending redactions as outlined boxes, applied as solid black
 */

import { useCallback, useState, useRef } from 'react';
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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== 'redact') return;

      // Ignore if clicking on an existing redaction
      if ((e.target as HTMLElement).classList.contains('redaction-box')) return;

      const rect = layerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setIsDrawing(true);
      setDrawStart({ x, y });
      setDrawEnd({ x, y });
      selectRedaction(null);
    },
    [mode, selectRedaction]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDrawing || !drawStart) return;

      const rect = layerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setDrawEnd({ x, y });
    },
    [isDrawing, drawStart]
  );

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !drawStart || !drawEnd) {
      setIsDrawing(false);
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

    setIsDrawing(false);
    setDrawStart(null);
    setDrawEnd(null);
  }, [isDrawing, drawStart, drawEnd, pageNumber, addRedaction, inverseTransformPoint]);

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
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
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
