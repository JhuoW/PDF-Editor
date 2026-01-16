import { useEffect, useRef, useState, useCallback } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import {
  createInkAnnotation,
  createRectangleAnnotation,
  createEllipseAnnotation,
  createLineAnnotation,
  createStickyNoteAnnotation,
  createStampAnnotation,
  createFreeTextAnnotation,
} from '../../store/annotationStore';
import type { Annotation, FreeTextAnnotation, TextStyle, RichTextSegment } from '../../annotations/types';
import { DEFAULT_TEXT_STYLE } from '../../annotations/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { TextFormatToolbar } from '../Toolbar/TextFormatToolbar';
import { TextBoxContextMenu, RichTextEditor, BoxPropertiesPanel, TextPropertiesPanel } from '../TextBox';
import { useTextBoxStore } from '../../store/textBoxStore';
import {
  textToSegments,
  getPlainText,
  applyStyleToRange,
  normalizeSegments,
  getSelectionStyle,
} from '../../utils/richText';
import './DrawingAnnotationLayer.css';

interface DrawingAnnotationLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
}

interface Point {
  x: number;
  y: number;
}

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null;

export function DrawingAnnotationLayer({
  page,
  pageNumber,
  scale,
  rotation,
}: DrawingAnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPath, setCurrentPath] = useState<Point[]>([]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Text editing state
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingSegments, setEditingSegments] = useState<RichTextSegment[]>([]);
  const useRichTextEditor = true; // Enable rich text editing by default
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragAnnotationStart, setDragAnnotationStart] = useState<[number, number] | null>(null);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<ResizeHandle>(null);
  const [resizeStart, setResizeStart] = useState<Point | null>(null);
  const [resizeAnnotationRect, setResizeAnnotationRect] = useState<[number, number, number, number] | null>(null);

  // Rotation state
  const [isRotating, setIsRotating] = useState(false);
  const [rotationStart, setRotationStart] = useState<Point | null>(null);
  const [rotationCenter, setRotationCenter] = useState<Point | null>(null);
  const [initialRotation, setInitialRotation] = useState<number>(0);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    annotation: FreeTextAnnotation;
    position: { x: number; y: number };
  } | null>(null);

  // Properties panel state
  const [showTextPropertiesPanel, setShowTextPropertiesPanel] = useState(false);
  const [showBoxPropertiesPanel, setShowBoxPropertiesPanel] = useState(false);

  // Store original annotation state for undo (before drag/resize modifications)
  const originalAnnotationRef = useRef<Annotation | null>(null);

  // Ref to track if we just finished drag/resize (for click handler)
  const justFinishedInteraction = useRef(false);

  const {
    currentTool,
    toolSettings,
    getAnnotationsForPage,
    addAnnotation,
    updateAnnotation,
    selectedAnnotationId,
    selectAnnotation,
    deleteAnnotation,
  } = useAnnotationStore();

  const { recordAdd, recordUpdate, recordDelete } = useAnnotationHistoryStore();

  const annotations = getAnnotationsForPage(pageNumber);
  const selectedAnnotation = annotations.find(a => a.id === selectedAnnotationId);

  // Calculate effective rotation and viewport
  useEffect(() => {
    if (!page) return;
    const effectiveRotation = getEffectiveRotation(page, rotation);
    const viewport = page.getViewport({ scale, rotation: effectiveRotation });
    setDimensions({ width: viewport.width, height: viewport.height });
  }, [page, scale, rotation]);

  // Convert screen coordinates to PDF coordinates
  const screenToPdfCoords = useCallback(
    (screenX: number, screenY: number): Point => {
      const effectiveRotation = getEffectiveRotation(page, rotation);
      const viewport = page.getViewport({ scale, rotation: effectiveRotation });
      const pdfX = screenX / scale;
      const pdfY = (viewport.height - screenY) / scale;
      return { x: pdfX, y: pdfY };
    },
    [page, scale, rotation]
  );

  // Convert PDF coordinates to screen coordinates
  const pdfToScreenCoords = useCallback(
    (pdfX: number, pdfY: number): Point => {
      const effectiveRotation = getEffectiveRotation(page, rotation);
      const viewport = page.getViewport({ scale, rotation: effectiveRotation });
      const screenX = pdfX * scale;
      const screenY = viewport.height - pdfY * scale;
      return { x: screenX, y: screenY };
    },
    [page, scale, rotation]
  );

  // Get style from annotation (handle legacy format)
  const getAnnotationStyle = (annotation: FreeTextAnnotation): TextStyle => {
    if (annotation.style) {
      return annotation.style;
    }
    // Legacy format conversion
    return {
      ...DEFAULT_TEXT_STYLE,
      fontSize: annotation.fontSize || DEFAULT_TEXT_STYLE.fontSize,
      fontFamily: annotation.fontFamily || DEFAULT_TEXT_STYLE.fontFamily,
      color: annotation.textColor || annotation.color || DEFAULT_TEXT_STYLE.color,
      backgroundColor: annotation.backgroundColor || 'transparent',
      borderColor: annotation.borderColor || DEFAULT_TEXT_STYLE.borderColor,
      borderWidth: annotation.borderWidth || DEFAULT_TEXT_STYLE.borderWidth,
    };
  };

  // Render a single annotation
  const renderAnnotation = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation,
    isSelected: boolean
  ) => {
    ctx.save();

    switch (annotation.type) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        renderTextMarkup(ctx, annotation);
        break;
      case 'ink':
        renderInk(ctx, annotation);
        break;
      case 'rectangle':
        renderRectangle(ctx, annotation, isSelected);
        break;
      case 'ellipse':
        renderEllipse(ctx, annotation, isSelected);
        break;
      case 'line':
      case 'arrow':
        renderLine(ctx, annotation, isSelected);
        break;
      case 'sticky-note':
        renderStickyNote(ctx, annotation, isSelected);
        break;
      case 'stamp':
        renderStamp(ctx, annotation, isSelected);
        break;
      case 'freetext':
        renderFreeText(ctx, annotation, isSelected);
        break;
    }

    ctx.restore();
  };

  // Render text markup
  const renderTextMarkup = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'highlight' | 'underline' | 'strikeout' }
  ) => {
    const { quadPoints, color, opacity, type } = annotation;

    for (const quad of quadPoints) {
      const points = [];
      for (let i = 0; i < quad.length; i += 2) {
        const screen = pdfToScreenCoords(quad[i], quad[i + 1]);
        points.push(screen);
      }

      if (type === 'highlight') {
        ctx.fillStyle = color;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.fill();
      } else if (type === 'underline') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
      } else if (type === 'strikeout') {
        const midY = (points[0].y + points[2].y) / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.moveTo(points[0].x, midY);
        ctx.lineTo(points[1].x, midY);
        ctx.stroke();
      }
    }
  };

  // Render ink annotation
  const renderInk = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'ink' }
  ) => {
    const { paths, color, strokeWidth } = annotation;

    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const path of paths) {
      if (path.length < 2) continue;

      ctx.beginPath();
      const start = pdfToScreenCoords(path[0][0], path[0][1]);
      ctx.moveTo(start.x, start.y);

      for (let i = 1; i < path.length; i++) {
        const point = pdfToScreenCoords(path[i][0], path[i][1]);
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
  };

  // Render rectangle
  const renderRectangle = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'rectangle' },
    isSelected: boolean
  ) => {
    const { rect, strokeColor, strokeWidth, fillColor, opacity } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    ctx.globalAlpha = opacity;

    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fillRect(topLeft.x, topLeft.y, width, height);
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height);
    }
  };

  // Render ellipse
  const renderEllipse = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'ellipse' },
    isSelected: boolean
  ) => {
    const { rect, strokeColor, strokeWidth, fillColor, opacity } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    const centerX = topLeft.x + width / 2;
    const centerY = topLeft.y + height / 2;

    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2);

    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height);
    }
  };

  // Render line/arrow
  const renderLine = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'line' | 'arrow' },
    isSelected: boolean
  ) => {
    const { start, end, color, strokeWidth, endArrow } = annotation;
    const startScreen = pdfToScreenCoords(start[0], start[1]);
    const endScreen = pdfToScreenCoords(end[0], end[1]);

    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(startScreen.x, startScreen.y);
    ctx.lineTo(endScreen.x, endScreen.y);
    ctx.stroke();

    if (endArrow || annotation.type === 'arrow') {
      const angle = Math.atan2(endScreen.y - startScreen.y, endScreen.x - startScreen.x);
      const arrowLength = 15;
      const arrowAngle = Math.PI / 6;

      ctx.beginPath();
      ctx.moveTo(endScreen.x, endScreen.y);
      ctx.lineTo(
        endScreen.x - arrowLength * Math.cos(angle - arrowAngle),
        endScreen.y - arrowLength * Math.sin(angle - arrowAngle)
      );
      ctx.moveTo(endScreen.x, endScreen.y);
      ctx.lineTo(
        endScreen.x - arrowLength * Math.cos(angle + arrowAngle),
        endScreen.y - arrowLength * Math.sin(angle + arrowAngle)
      );
      ctx.stroke();
    }

    if (isSelected) {
      ctx.fillStyle = '#0066FF';
      ctx.beginPath();
      ctx.arc(startScreen.x, startScreen.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(endScreen.x, endScreen.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Render sticky note
  const renderStickyNote = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'sticky-note' },
    isSelected: boolean
  ) => {
    const { position, color } = annotation;
    const screen = pdfToScreenCoords(position.x, position.y);

    const size = 24;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + size, screen.y);
    ctx.lineTo(screen.x + size, screen.y + size - 6);
    ctx.lineTo(screen.x + size - 6, screen.y + size);
    ctx.lineTo(screen.x, screen.y + size);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(screen.x + size - 6, screen.y + size);
    ctx.lineTo(screen.x + size - 6, screen.y + size - 6);
    ctx.lineTo(screen.x + size, screen.y + size - 6);
    ctx.stroke();

    if (isSelected) {
      ctx.strokeStyle = '#0066FF';
      ctx.lineWidth = 2;
      ctx.strokeRect(screen.x - 2, screen.y - 2, size + 4, size + 4);
    }
  };

  // Render stamp
  const renderStamp = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'stamp' },
    isSelected: boolean
  ) => {
    const { rect, stampName, stampType, customImageData, color } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    if (stampType === 'custom' && customImageData) {
      const img = new Image();
      img.src = customImageData;
      ctx.drawImage(img, topLeft.x, topLeft.y, width, height);
    } else {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3;
      ctx.font = `bold ${Math.min(height * 0.4, 24)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.strokeRect(topLeft.x + 2, topLeft.y + 2, width - 4, height - 4);
      ctx.fillText(stampName.toUpperCase(), topLeft.x + width / 2, topLeft.y + height / 2);
    }

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height);
    }
  };

  // Render free text with full styling including boxStyle
  const renderFreeText = (
    ctx: CanvasRenderingContext2D,
    annotation: FreeTextAnnotation,
    isSelected: boolean
  ) => {
    const { rect, content, rotation = 0, boxStyle } = annotation;
    const style = getAnnotationStyle(annotation);

    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    // Get box styling (with defaults)
    const bgColor = boxStyle?.backgroundColor || style.backgroundColor || 'transparent';
    const bgOpacity = boxStyle?.backgroundOpacity ?? 1;
    const borderColor = boxStyle?.borderColor || style.borderColor || '#000000';
    const borderWidth = boxStyle?.borderWidth ?? style.borderWidth ?? 1;
    const borderStyle = boxStyle?.borderStyle || 'solid';
    const borderRadius = (boxStyle?.borderRadius || 0) * scale;
    const padding = boxStyle?.padding || { top: 8, right: 8, bottom: 8, left: 8 };
    const shadow = boxStyle?.shadow;

    // Calculate center for rotation
    const centerX = topLeft.x + width / 2;
    const centerY = topLeft.y + height / 2;

    // Apply rotation
    ctx.save();
    if (rotation !== 0) {
      ctx.translate(centerX, centerY);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);
    }

    // Draw shadow if specified
    if (shadow && shadow.blur > 0) {
      ctx.shadowColor = shadow.color;
      ctx.shadowBlur = shadow.blur * scale;
      ctx.shadowOffsetX = shadow.offsetX * scale;
      ctx.shadowOffsetY = shadow.offsetY * scale;
    }

    // Draw background with border radius
    if (bgColor && bgColor !== 'transparent') {
      ctx.globalAlpha = bgOpacity;
      ctx.fillStyle = bgColor;

      if (borderRadius > 0) {
        // Draw rounded rectangle
        ctx.beginPath();
        ctx.moveTo(topLeft.x + borderRadius, topLeft.y);
        ctx.lineTo(topLeft.x + width - borderRadius, topLeft.y);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y, topLeft.x + width, topLeft.y + borderRadius);
        ctx.lineTo(topLeft.x + width, topLeft.y + height - borderRadius);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y + height, topLeft.x + width - borderRadius, topLeft.y + height);
        ctx.lineTo(topLeft.x + borderRadius, topLeft.y + height);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y + height, topLeft.x, topLeft.y + height - borderRadius);
        ctx.lineTo(topLeft.x, topLeft.y + borderRadius);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y, topLeft.x + borderRadius, topLeft.y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(topLeft.x, topLeft.y, width, height);
      }
      ctx.globalAlpha = 1;
    }

    // Reset shadow for border
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Draw border with border radius
    if (borderWidth > 0 && borderStyle !== 'none') {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;

      // Set dash pattern based on style
      if (borderStyle === 'dashed') {
        ctx.setLineDash([6, 3]);
      } else if (borderStyle === 'dotted') {
        ctx.setLineDash([2, 2]);
      } else {
        ctx.setLineDash([]);
      }

      if (borderRadius > 0) {
        // Draw rounded rectangle border
        ctx.beginPath();
        ctx.moveTo(topLeft.x + borderRadius, topLeft.y);
        ctx.lineTo(topLeft.x + width - borderRadius, topLeft.y);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y, topLeft.x + width, topLeft.y + borderRadius);
        ctx.lineTo(topLeft.x + width, topLeft.y + height - borderRadius);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y + height, topLeft.x + width - borderRadius, topLeft.y + height);
        ctx.lineTo(topLeft.x + borderRadius, topLeft.y + height);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y + height, topLeft.x, topLeft.y + height - borderRadius);
        ctx.lineTo(topLeft.x, topLeft.y + borderRadius);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y, topLeft.x + borderRadius, topLeft.y);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(topLeft.x, topLeft.y, width, height);
      }

      ctx.setLineDash([]);
    }

    // Draw text with padding
    const paddingLeft = padding.left * scale;
    const paddingRight = padding.right * scale;
    const paddingTop = padding.top * scale;
    const paddingBottom = padding.bottom * scale;

    const fontSize = style.fontSize * scale;
    let fontStyle = '';
    if (style.fontWeight === 'bold') fontStyle += 'bold ';
    if (style.fontStyle === 'italic') fontStyle += 'italic ';

    ctx.font = `${fontStyle}${fontSize}px ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';

    // Text area dimensions (inside padding)
    const textAreaWidth = width - paddingLeft - paddingRight;
    const textAreaX = topLeft.x + paddingLeft;

    // Text alignment
    let textX = textAreaX;
    if (style.textAlign === 'center') {
      ctx.textAlign = 'center';
      textX = textAreaX + textAreaWidth / 2;
    } else if (style.textAlign === 'right') {
      ctx.textAlign = 'right';
      textX = textAreaX + textAreaWidth;
    } else {
      ctx.textAlign = 'left';
    }

    // Render text with word wrapping
    const lines = content.split('\n');
    const lineHeight = fontSize * (style.lineHeight || 1.2);
    let y = topLeft.y + paddingTop;

    // Calculate total text height for vertical alignment
    let totalTextHeight = 0;
    const wrappedLines: string[] = [];

    for (const line of lines) {
      const words = line.split(' ');
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);

        if (metrics.width > textAreaWidth && currentLine) {
          wrappedLines.push(currentLine);
          totalTextHeight += lineHeight;
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine) {
        wrappedLines.push(currentLine);
        totalTextHeight += lineHeight;
      }
    }

    // Apply vertical alignment
    const textAreaHeight = height - paddingTop - paddingBottom;
    if (style.verticalAlign === 'middle') {
      y = topLeft.y + paddingTop + (textAreaHeight - totalTextHeight) / 2;
    } else if (style.verticalAlign === 'bottom') {
      y = topLeft.y + height - paddingBottom - totalTextHeight;
    }

    // Draw wrapped lines
    for (const line of wrappedLines) {
      if (y + fontSize > topLeft.y + height - paddingBottom) break;

      // Draw text decoration (underline or strikethrough)
      if (style.textDecoration === 'underline' || style.textDecoration === 'line-through') {
        const lineMetrics = ctx.measureText(line);
        const decoY = style.textDecoration === 'underline' ? y + fontSize + 2 : y + fontSize / 2;
        let decoX1: number, decoX2: number;

        if (style.textAlign === 'center') {
          decoX1 = textX - lineMetrics.width / 2;
          decoX2 = textX + lineMetrics.width / 2;
        } else if (style.textAlign === 'right') {
          decoX1 = textX - lineMetrics.width;
          decoX2 = textX;
        } else {
          decoX1 = textX;
          decoX2 = textX + lineMetrics.width;
        }

        ctx.beginPath();
        ctx.moveTo(decoX1, decoY);
        ctx.lineTo(decoX2, decoY);
        ctx.strokeStyle = style.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillText(line, textX, y);
      y += lineHeight;
    }

    // Restore context before drawing selection handles (so handles are not rotated)
    ctx.restore();

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height, true); // Show rotation handle for freetext
    }
  };

  // Render selection handles
  const renderSelectionHandles = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    showRotationHandle: boolean = false
  ) => {
    const handleSize = 8;
    ctx.fillStyle = '#0066FF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;

    // Draw selection border
    ctx.strokeStyle = '#0066FF';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x - 1, y - 1, width + 2, height + 2);
    ctx.setLineDash([]);

    const handles = [
      { x: x, y: y, cursor: 'nw' },
      { x: x + width / 2, y: y, cursor: 'n' },
      { x: x + width, y: y, cursor: 'ne' },
      { x: x + width, y: y + height / 2, cursor: 'e' },
      { x: x + width, y: y + height, cursor: 'se' },
      { x: x + width / 2, y: y + height, cursor: 's' },
      { x: x, y: y + height, cursor: 'sw' },
      { x: x, y: y + height / 2, cursor: 'w' },
    ];

    ctx.fillStyle = '#0066FF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;

    for (const handle of handles) {
      ctx.fillRect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
      ctx.strokeRect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize
      );
    }

    // Draw rotation handle (only for freetext annotations)
    if (showRotationHandle) {
      const rotHandleY = y - 25;
      const rotHandleX = x + width / 2;

      // Draw line from top center to rotation handle
      ctx.strokeStyle = '#0066FF';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(rotHandleX, y);
      ctx.lineTo(rotHandleX, rotHandleY + 8);
      ctx.stroke();

      // Draw rotation handle (circle)
      ctx.fillStyle = '#0066FF';
      ctx.beginPath();
      ctx.arc(rotHandleX, rotHandleY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // Draw rotation icon inside the circle
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rotHandleX, rotHandleY, 3, -Math.PI / 4, Math.PI);
      ctx.stroke();
      // Arrow head
      ctx.beginPath();
      ctx.moveTo(rotHandleX - 3, rotHandleY - 1);
      ctx.lineTo(rotHandleX - 1, rotHandleY - 3);
      ctx.lineTo(rotHandleX - 1, rotHandleY);
      ctx.stroke();
    }
  };

  // Render drawing preview
  const renderDrawingPreview = (ctx: CanvasRenderingContext2D) => {
    if (!startPoint) return;

    ctx.strokeStyle = toolSettings.color;
    ctx.fillStyle = toolSettings.color;
    ctx.lineWidth = toolSettings.strokeWidth;
    ctx.globalAlpha = toolSettings.opacity;

    if (currentTool === 'ink' && currentPath.length > 0) {
      ctx.beginPath();
      ctx.moveTo(currentPath[0].x, currentPath[0].y);
      for (let i = 1; i < currentPath.length; i++) {
        ctx.lineTo(currentPath[i].x, currentPath[i].y);
      }
      ctx.stroke();
    } else if (currentTool === 'rectangle' && startPoint) {
      const width = (currentPath[currentPath.length - 1]?.x || startPoint.x) - startPoint.x;
      const height = (currentPath[currentPath.length - 1]?.y || startPoint.y) - startPoint.y;
      ctx.strokeRect(startPoint.x, startPoint.y, width, height);
    } else if (currentTool === 'ellipse' && startPoint) {
      const endX = currentPath[currentPath.length - 1]?.x || startPoint.x;
      const endY = currentPath[currentPath.length - 1]?.y || startPoint.y;
      const centerX = (startPoint.x + endX) / 2;
      const centerY = (startPoint.y + endY) / 2;
      const radiusX = Math.abs(endX - startPoint.x) / 2;
      const radiusY = Math.abs(endY - startPoint.y) / 2;

      ctx.beginPath();
      ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if ((currentTool === 'line' || currentTool === 'arrow') && startPoint) {
      const endX = currentPath[currentPath.length - 1]?.x || startPoint.x;
      const endY = currentPath[currentPath.length - 1]?.y || startPoint.y;

      ctx.beginPath();
      ctx.moveTo(startPoint.x, startPoint.y);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      if (currentTool === 'arrow') {
        const angle = Math.atan2(endY - startPoint.y, endX - startPoint.x);
        const arrowLength = 15;
        const arrowAngle = Math.PI / 6;

        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowLength * Math.cos(angle - arrowAngle),
          endY - arrowLength * Math.sin(angle - arrowAngle)
        );
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowLength * Math.cos(angle + arrowAngle),
          endY - arrowLength * Math.sin(angle + arrowAngle)
        );
        ctx.stroke();
      }
    } else if (currentTool === 'freetext' && startPoint) {
      const endX = currentPath[currentPath.length - 1]?.x || startPoint.x;
      const endY = currentPath[currentPath.length - 1]?.y || startPoint.y;
      const width = Math.abs(endX - startPoint.x) || 150;
      const height = Math.abs(endY - startPoint.y) || 40;
      const x = Math.min(startPoint.x, endX);
      const y = Math.min(startPoint.y, endY);

      ctx.strokeStyle = '#0066FF';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);
    }
  };

  // Render annotations on canvas - placed after render functions to avoid "used before defined" errors
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Sort annotations by z-index (lower z-index renders first, so higher z-index appears on top)
    const sortedAnnotations = [...annotations].sort((a, b) => {
      const zIndexA = (a as FreeTextAnnotation).zIndex || 0;
      const zIndexB = (b as FreeTextAnnotation).zIndex || 0;
      return zIndexA - zIndexB;
    });

    for (const annotation of sortedAnnotations) {
      // Don't render text box on canvas if it's being edited
      if (annotation.id === editingAnnotationId && annotation.type === 'freetext') continue;
      renderAnnotation(ctx, annotation, selectedAnnotationId === annotation.id);
    }

    if (isDrawing && currentTool !== 'select') {
      renderDrawingPreview(ctx);
    }
  }, [annotations, dimensions, scale, selectedAnnotationId, isDrawing, currentPath, startPoint, currentTool, toolSettings, editingAnnotationId]);

  // Get resize handle at position
  const getResizeHandleAt = (x: number, y: number, annotation: Annotation): ResizeHandle => {
    if (!('rect' in annotation)) return null;

    const rect = (annotation as { rect: [number, number, number, number] }).rect;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    const handleSize = 10;

    const handles: { x: number; y: number; cursor: ResizeHandle }[] = [
      { x: topLeft.x, y: topLeft.y, cursor: 'nw' },
      { x: topLeft.x + width / 2, y: topLeft.y, cursor: 'n' },
      { x: topLeft.x + width, y: topLeft.y, cursor: 'ne' },
      { x: topLeft.x + width, y: topLeft.y + height / 2, cursor: 'e' },
      { x: topLeft.x + width, y: topLeft.y + height, cursor: 'se' },
      { x: topLeft.x + width / 2, y: topLeft.y + height, cursor: 's' },
      { x: topLeft.x, y: topLeft.y + height, cursor: 'sw' },
      { x: topLeft.x, y: topLeft.y + height / 2, cursor: 'w' },
    ];

    for (const handle of handles) {
      if (Math.abs(x - handle.x) <= handleSize / 2 && Math.abs(y - handle.y) <= handleSize / 2) {
        return handle.cursor;
      }
    }

    return null;
  };

  // Check if point is on rotation handle (only for freetext)
  const isOnRotationHandle = (x: number, y: number, annotation: Annotation): boolean => {
    if (annotation.type !== 'freetext' || !('rect' in annotation)) return false;

    const rect = (annotation as { rect: [number, number, number, number] }).rect;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const rotHandleX = topLeft.x + width / 2;
    const rotHandleY = topLeft.y - 25;

    // Check if within 8 pixels of rotation handle center
    const distance = Math.sqrt(Math.pow(x - rotHandleX, 2) + Math.pow(y - rotHandleY, 2));
    return distance <= 8;
  };

  // Get rotation center for an annotation
  const getAnnotationCenter = (annotation: Annotation): Point | null => {
    if (!('rect' in annotation)) return null;

    const rect = (annotation as { rect: [number, number, number, number] }).rect;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    return {
      x: (topLeft.x + bottomRight.x) / 2,
      y: (topLeft.y + bottomRight.y) / 2,
    };
  };

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check for rotation handle on selected freetext annotation
    if (selectedAnnotation && selectedAnnotation.type === 'freetext' && isOnRotationHandle(x, y, selectedAnnotation)) {
      // Store original state for undo BEFORE any modifications
      originalAnnotationRef.current = JSON.parse(JSON.stringify(selectedAnnotation));
      const center = getAnnotationCenter(selectedAnnotation);
      if (center) {
        setIsRotating(true);
        setRotationStart({ x, y });
        setRotationCenter(center);
        setInitialRotation((selectedAnnotation as FreeTextAnnotation).rotation || 0);
      }
      return;
    }

    // Check for resize handle on selected annotation (works in any tool mode)
    if (selectedAnnotation && 'rect' in selectedAnnotation) {
      const handle = getResizeHandleAt(x, y, selectedAnnotation);
      if (handle) {
        // Store original state for undo BEFORE any modifications
        originalAnnotationRef.current = JSON.parse(JSON.stringify(selectedAnnotation));
        setIsResizing(true);
        setResizeHandle(handle);
        setResizeStart({ x, y });
        setResizeAnnotationRect([...selectedAnnotation.rect] as [number, number, number, number]);
        return;
      }
    }

    // Check for drag start on selected annotation (works in any tool mode)
    if (selectedAnnotation && isPointInAnnotation(x, y, selectedAnnotation)) {
      // Store original state for undo BEFORE any modifications
      originalAnnotationRef.current = JSON.parse(JSON.stringify(selectedAnnotation));
      setIsDragging(true);
      setDragStart({ x, y });
      // Store the annotation's starting position based on type
      if ('rect' in selectedAnnotation) {
        const annRect = (selectedAnnotation as { rect: [number, number, number, number] }).rect;
        setDragAnnotationStart([annRect[0], annRect[1]]);
      } else if (selectedAnnotation.type === 'sticky-note') {
        const pos = (selectedAnnotation as { position: { x: number; y: number } }).position;
        setDragAnnotationStart([pos.x, pos.y]);
      } else if (selectedAnnotation.type === 'line' || selectedAnnotation.type === 'arrow') {
        const start = (selectedAnnotation as { start: [number, number] }).start;
        setDragAnnotationStart([start[0], start[1]]);
      } else if (selectedAnnotation.type === 'ink') {
        // For ink, we'll use [0, 0] as reference and apply delta to all paths
        setDragAnnotationStart([0, 0]);
      }
      return;
    }

    // Check if clicking on any existing annotation - select it instead of drawing
    for (const annotation of annotations) {
      if (isPointInAnnotation(x, y, annotation)) {
        selectAnnotation(annotation.id);
        // Store original state for undo BEFORE any modifications
        originalAnnotationRef.current = JSON.parse(JSON.stringify(annotation));
        setIsDragging(true);
        setDragStart({ x, y });
        // Store the annotation's starting position based on type
        if ('rect' in annotation) {
          const annRect = (annotation as { rect: [number, number, number, number] }).rect;
          setDragAnnotationStart([annRect[0], annRect[1]]);
        } else if (annotation.type === 'sticky-note') {
          const pos = (annotation as { position: { x: number; y: number } }).position;
          setDragAnnotationStart([pos.x, pos.y]);
        } else if (annotation.type === 'line' || annotation.type === 'arrow') {
          const start = (annotation as { start: [number, number] }).start;
          setDragAnnotationStart([start[0], start[1]]);
        } else if (annotation.type === 'ink') {
          // For ink, we'll use [0, 0] as reference and apply delta to all paths
          setDragAnnotationStart([0, 0]);
        }
        return;
      }
    }

    if (currentTool === 'select') return;

    // Deselect any annotation when starting to draw
    selectAnnotation(null);
    setIsDrawing(true);
    setStartPoint({ x, y });
    setCurrentPath([{ x, y }]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Handle rotation
    if (isRotating && rotationStart && rotationCenter && selectedAnnotation) {
      // Calculate angle from center to current point
      const currentAngle = Math.atan2(y - rotationCenter.y, x - rotationCenter.x);
      const startAngle = Math.atan2(rotationStart.y - rotationCenter.y, rotationStart.x - rotationCenter.x);
      const deltaAngle = (currentAngle - startAngle) * (180 / Math.PI);

      let newRotation = initialRotation + deltaAngle;

      // Snap to 15° increments if Shift is held
      if (e.shiftKey) {
        newRotation = Math.round(newRotation / 15) * 15;
      }

      // Normalize to 0-360
      newRotation = ((newRotation % 360) + 360) % 360;

      updateAnnotation(selectedAnnotation.id, { rotation: newRotation });
      return;
    }

    // Handle resize
    if (isResizing && resizeHandle && resizeStart && resizeAnnotationRect && selectedAnnotation) {
      const deltaX = (x - resizeStart.x) / scale;
      const deltaY = -(y - resizeStart.y) / scale; // Invert Y for PDF coords

      let newRect = [...resizeAnnotationRect] as [number, number, number, number];

      switch (resizeHandle) {
        case 'nw':
          newRect[0] += deltaX;
          newRect[1] += deltaY;
          newRect[2] -= deltaX;
          newRect[3] -= deltaY;
          break;
        case 'n':
          newRect[1] += deltaY;
          newRect[3] -= deltaY;
          break;
        case 'ne':
          newRect[1] += deltaY;
          newRect[2] += deltaX;
          newRect[3] -= deltaY;
          break;
        case 'e':
          newRect[2] += deltaX;
          break;
        case 'se':
          newRect[2] += deltaX;
          newRect[3] += deltaY;
          break;
        case 's':
          newRect[3] += deltaY;
          break;
        case 'sw':
          newRect[0] += deltaX;
          newRect[2] -= deltaX;
          newRect[3] += deltaY;
          break;
        case 'w':
          newRect[0] += deltaX;
          newRect[2] -= deltaX;
          break;
      }

      // Ensure minimum size
      if (newRect[2] >= 20 && newRect[3] >= 20) {
        updateAnnotation(selectedAnnotation.id, { rect: newRect });
      }
      return;
    }

    // Handle drag
    if (isDragging && dragStart && dragAnnotationStart && selectedAnnotation) {
      const deltaX = (x - dragStart.x) / scale;
      const deltaY = -(y - dragStart.y) / scale; // Invert Y for PDF coords

      if ('rect' in selectedAnnotation) {
        // Rect-based annotations (rectangle, ellipse, stamp, freetext)
        const newX = dragAnnotationStart[0] + deltaX;
        const newY = dragAnnotationStart[1] + deltaY;
        const currentRect = (selectedAnnotation as { rect: [number, number, number, number] }).rect;
        updateAnnotation(selectedAnnotation.id, {
          rect: [newX, newY, currentRect[2], currentRect[3]]
        });
      } else if (selectedAnnotation.type === 'sticky-note') {
        // Sticky note - update position
        const newX = dragAnnotationStart[0] + deltaX;
        const newY = dragAnnotationStart[1] + deltaY;
        updateAnnotation(selectedAnnotation.id, {
          position: { x: newX, y: newY }
        });
      } else if (selectedAnnotation.type === 'line' || selectedAnnotation.type === 'arrow') {
        // Line/arrow - update both start and end points
        const originalAnnotation = originalAnnotationRef.current as { start: [number, number]; end: [number, number] } | null;
        if (originalAnnotation) {
          const newStart: [number, number] = [
            originalAnnotation.start[0] + deltaX,
            originalAnnotation.start[1] + deltaY
          ];
          const newEnd: [number, number] = [
            originalAnnotation.end[0] + deltaX,
            originalAnnotation.end[1] + deltaY
          ];
          updateAnnotation(selectedAnnotation.id, { start: newStart, end: newEnd });
        }
      } else if (selectedAnnotation.type === 'ink') {
        // Ink - update all path points
        const originalAnnotation = originalAnnotationRef.current as { paths: number[][][] } | null;
        if (originalAnnotation) {
          const newPaths = originalAnnotation.paths.map(path =>
            path.map(point => [point[0] + deltaX, point[1] + deltaY])
          );
          updateAnnotation(selectedAnnotation.id, { paths: newPaths });
        }
      }
      return;
    }

    // Handle drawing
    if (!isDrawing || currentTool === 'select') return;
    setCurrentPath((prev) => [...prev, { x, y }]);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    // Finish rotation
    if (isRotating && selectedAnnotation && originalAnnotationRef.current) {
      // Record the update with the ORIGINAL state (before modification)
      recordUpdate(selectedAnnotation, originalAnnotationRef.current);
      originalAnnotationRef.current = null;
      justFinishedInteraction.current = true;
      setTimeout(() => { justFinishedInteraction.current = false; }, 10);
      setIsRotating(false);
      setRotationStart(null);
      setRotationCenter(null);
      setInitialRotation(0);
      return;
    }

    // Finish resize
    if (isResizing && selectedAnnotation && originalAnnotationRef.current) {
      // Record the update with the ORIGINAL state (before modification)
      recordUpdate(selectedAnnotation, originalAnnotationRef.current);
      originalAnnotationRef.current = null;
      justFinishedInteraction.current = true;
      setTimeout(() => { justFinishedInteraction.current = false; }, 10);
      setIsResizing(false);
      setResizeHandle(null);
      setResizeStart(null);
      setResizeAnnotationRect(null);
      return;
    }

    // Finish drag
    if (isDragging && selectedAnnotation && originalAnnotationRef.current) {
      // Record the update with the ORIGINAL state (before modification)
      recordUpdate(selectedAnnotation, originalAnnotationRef.current);
      originalAnnotationRef.current = null;
      justFinishedInteraction.current = true;
      setTimeout(() => { justFinishedInteraction.current = false; }, 10);
      setIsDragging(false);
      setDragStart(null);
      setDragAnnotationStart(null);
      return;
    }

    if (!isDrawing || !startPoint) {
      setIsDrawing(false);
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    const startPdf = screenToPdfCoords(startPoint.x, startPoint.y);
    const endPdf = screenToPdfCoords(endX, endY);

    let annotation: Annotation | null = null;

    switch (currentTool) {
      case 'ink': {
        const paths = [currentPath.map((p) => {
          const pdf = screenToPdfCoords(p.x, p.y);
          return [pdf.x, pdf.y];
        })];
        annotation = createInkAnnotation(
          pageNumber,
          paths,
          toolSettings.color,
          toolSettings.strokeWidth
        );
        break;
      }
      case 'rectangle': {
        const x = Math.min(startPdf.x, endPdf.x);
        const y = Math.min(startPdf.y, endPdf.y);
        const w = Math.abs(endPdf.x - startPdf.x);
        const h = Math.abs(endPdf.y - startPdf.y);
        if (w > 5 && h > 5) {
          annotation = createRectangleAnnotation(
            pageNumber,
            [x, y, w, h],
            toolSettings.color,
            toolSettings.strokeWidth
          );
        }
        break;
      }
      case 'ellipse': {
        const x = Math.min(startPdf.x, endPdf.x);
        const y = Math.min(startPdf.y, endPdf.y);
        const w = Math.abs(endPdf.x - startPdf.x);
        const h = Math.abs(endPdf.y - startPdf.y);
        if (w > 5 && h > 5) {
          annotation = createEllipseAnnotation(
            pageNumber,
            [x, y, w, h],
            toolSettings.color,
            toolSettings.strokeWidth
          );
        }
        break;
      }
      case 'line':
      case 'arrow': {
        const distance = Math.sqrt(
          Math.pow(endPdf.x - startPdf.x, 2) + Math.pow(endPdf.y - startPdf.y, 2)
        );
        if (distance > 5) {
          annotation = createLineAnnotation(
            pageNumber,
            [startPdf.x, startPdf.y],
            [endPdf.x, endPdf.y],
            toolSettings.color,
            toolSettings.strokeWidth,
            currentTool === 'arrow'
          );
        }
        break;
      }
      case 'sticky-note': {
        annotation = createStickyNoteAnnotation(
          pageNumber,
          { x: startPdf.x, y: startPdf.y },
          '',
          toolSettings.color
        );
        break;
      }
      case 'freetext': {
        // Calculate drag distance to determine if it's a click or drag
        const dragDistance = Math.sqrt(
          Math.pow(endPdf.x - startPdf.x, 2) + Math.pow(endPdf.y - startPdf.y, 2)
        );

        // Default size for click-to-create (in PDF coordinates)
        const DEFAULT_WIDTH = 200;
        const DEFAULT_HEIGHT = 80;
        const MIN_DRAG_SIZE = 30;

        let x: number, y: number, w: number, h: number;

        if (dragDistance < MIN_DRAG_SIZE) {
          // Click-to-create: use default size, position text box so click is at top-left
          x = startPdf.x;
          y = startPdf.y - DEFAULT_HEIGHT; // Adjust for PDF coordinate system (origin at bottom)
          w = DEFAULT_WIDTH;
          h = DEFAULT_HEIGHT;
        } else {
          // Drag-to-create: use the dragged dimensions
          x = Math.min(startPdf.x, endPdf.x);
          y = Math.min(startPdf.y, endPdf.y);
          w = Math.abs(endPdf.x - startPdf.x);
          h = Math.abs(endPdf.y - startPdf.y);
        }

        annotation = createFreeTextAnnotation(
          pageNumber,
          [x, y, w, h],
          '',
          { ...toolSettings.textStyle }
        );
        // Immediately enter editing mode
        setTimeout(() => {
          if (annotation) {
            setEditingAnnotationId(annotation.id);
            setEditingContent('');
            // Initialize empty segments with default style
            setEditingSegments(textToSegments('', toolSettings.textStyle));
            selectAnnotation(annotation.id);
            if (!useRichTextEditor) {
              setTimeout(() => textareaRef.current?.focus(), 0);
            }
          }
        }, 0);
        break;
      }
      case 'stamp': {
        const selectedStamp = (window as unknown as { __selectedStamp?: { type: 'predefined' | 'custom'; name: string; imageData?: string } }).__selectedStamp || {
          type: 'predefined',
          name: 'Approved',
        };
        const w = 120;
        const h = 40;
        annotation = createStampAnnotation(
          pageNumber,
          [startPdf.x - w / 2, startPdf.y - h / 2, w, h],
          selectedStamp.name,
          selectedStamp.type,
          selectedStamp.imageData
        );
        break;
      }
    }

    if (annotation) {
      addAnnotation(annotation);
      recordAdd(annotation);
      // Select the newly created annotation (except freetext which handles selection separately)
      if (currentTool !== 'freetext') {
        selectAnnotation(annotation.id);
      }
    }

    setIsDrawing(false);
    setStartPoint(null);
    setCurrentPath([]);
  };

  // Handle double-click to edit text box
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (currentTool !== 'select') return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    for (const annotation of annotations) {
      if (annotation.type === 'freetext' && isPointInAnnotation(x, y, annotation)) {
        const ftAnnotation = annotation as FreeTextAnnotation;
        setEditingAnnotationId(annotation.id);
        setEditingContent(ftAnnotation.content || '');

        // Initialize segments for rich text editing
        if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
          setEditingSegments(ftAnnotation.richContent);
        } else {
          // Convert plain text to segments with the annotation's style
          const style = getAnnotationStyle(ftAnnotation);
          setEditingSegments(textToSegments(ftAnnotation.content || '', style));
        }

        selectAnnotation(annotation.id);
        // Focus is handled by RichTextEditor's autoFocus
        if (!useRichTextEditor) {
          setTimeout(() => textareaRef.current?.focus(), 0);
        }
        return;
      }
    }
  };

  // Finish editing text box
  const finishEditing = () => {
    if (!editingAnnotationId) return;

    const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
    if (annotation && annotation.type === 'freetext') {
      if (useRichTextEditor) {
        // Save rich text segments
        const plainContent = getPlainText(editingSegments);
        const trimmedContent = plainContent.trim();

        if (trimmedContent === '') {
          if (!annotation.content || annotation.content.trim() === '') {
            // Delete empty text box and record deletion for undo
            recordDelete(annotation);
            deleteAnnotation(editingAnnotationId);
          } else {
            const previousState = { ...annotation };
            updateAnnotation(editingAnnotationId, { content: '', richContent: [] });
            recordUpdate({ ...annotation, content: '', richContent: [] }, previousState);
          }
        } else {
          const previousState = { ...annotation };
          const normalizedSegments = normalizeSegments(editingSegments);
          updateAnnotation(editingAnnotationId, {
            content: trimmedContent,
            richContent: normalizedSegments,
          });
          recordUpdate({ ...annotation, content: trimmedContent, richContent: normalizedSegments }, previousState);
        }
      } else {
        // Legacy plain text editing
        const trimmedContent = editingContent.trim();

        if (trimmedContent === '') {
          if (!annotation.content || annotation.content.trim() === '') {
            // Delete empty text box and record deletion for undo
            recordDelete(annotation);
            deleteAnnotation(editingAnnotationId);
          } else {
            const previousState = { ...annotation };
            updateAnnotation(editingAnnotationId, { content: '' });
            recordUpdate({ ...annotation, content: '' }, previousState);
          }
        } else {
          const previousState = { ...annotation };
          updateAnnotation(editingAnnotationId, { content: trimmedContent });
          recordUpdate({ ...annotation, content: trimmedContent }, previousState);
        }
      }
    }

    setEditingAnnotationId(null);
    setEditingContent('');
    setEditingSegments([]);
    // Clear textbox store state
    useTextBoxStore.getState().stopEditing();
  };

  // Handle click for selection
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (editingAnnotationId) return;

    // Skip if we just finished dragging or resizing (selection was handled in mousedown)
    if (justFinishedInteraction.current) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicked on an annotation - select it
    for (const annotation of annotations) {
      if (isPointInAnnotation(x, y, annotation)) {
        selectAnnotation(annotation.id);
        return;
      }
    }

    // Only deselect if in select mode and clicked on empty space
    if (currentTool === 'select') {
      selectAnnotation(null);
    }
  };

  // Check if point is inside annotation bounds
  const isPointInAnnotation = (x: number, y: number, annotation: Annotation): boolean => {
    switch (annotation.type) {
      case 'rectangle':
      case 'ellipse':
      case 'stamp':
      case 'freetext': {
        const { rect } = annotation as { rect: [number, number, number, number] };
        const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
        const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);
        return (
          x >= topLeft.x &&
          x <= bottomRight.x &&
          y >= topLeft.y &&
          y <= bottomRight.y
        );
      }
      case 'sticky-note': {
        const { position } = annotation as { position: { x: number; y: number } };
        const screen = pdfToScreenCoords(position.x, position.y);
        return x >= screen.x && x <= screen.x + 24 && y >= screen.y && y <= screen.y + 24;
      }
      case 'line':
      case 'arrow': {
        const { start, end } = annotation as { start: [number, number]; end: [number, number] };
        const startScreen = pdfToScreenCoords(start[0], start[1]);
        const endScreen = pdfToScreenCoords(end[0], end[1]);
        const dist = distanceToLine(x, y, startScreen.x, startScreen.y, endScreen.x, endScreen.y);
        return dist < 10;
      }
      case 'ink': {
        const { paths } = annotation as { paths: number[][][] };
        // Check if point is near any path segment
        for (const path of paths) {
          for (let i = 0; i < path.length - 1; i++) {
            const p1Screen = pdfToScreenCoords(path[i][0], path[i][1]);
            const p2Screen = pdfToScreenCoords(path[i + 1][0], path[i + 1][1]);
            const dist = distanceToLine(x, y, p1Screen.x, p1Screen.y, p2Screen.x, p2Screen.y);
            if (dist < 10) return true;
          }
        }
        return false;
      }
      default:
        return false;
    }
  };

  // Calculate distance from point to line segment
  const distanceToLine = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): number => {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;

    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;

    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Handle keyboard for delete, undo/redo and formatting shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input (except for undo/redo)
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      // Handle Undo/Redo globally for annotations (works even in inputs)
      if (isCtrl && e.key.toLowerCase() === 'z') {
        // Only handle if we have annotation history
        const historyState = useAnnotationHistoryStore.getState();
        if (isShift) {
          if (historyState.canRedo()) {
            e.preventDefault();
            const entry = historyState.redo();
            if (entry) {
              switch (entry.type) {
                case 'add':
                  addAnnotation(entry.annotation);
                  break;
                case 'update':
                  updateAnnotation(entry.annotation.id, entry.annotation);
                  break;
                case 'delete':
                  deleteAnnotation(entry.annotation.id);
                  break;
              }
            }
          }
        } else {
          if (historyState.canUndo()) {
            e.preventDefault();
            const entry = historyState.undo();
            if (entry) {
              switch (entry.type) {
                case 'add':
                  deleteAnnotation(entry.annotation.id);
                  break;
                case 'update':
                  if (entry.previousState) {
                    updateAnnotation(entry.annotation.id, entry.previousState);
                  }
                  break;
                case 'delete':
                  addAnnotation(entry.annotation);
                  break;
              }
            }
          }
        }
        return;
      }

      // Handle Ctrl+Y for redo
      if (isCtrl && e.key.toLowerCase() === 'y') {
        const historyState = useAnnotationHistoryStore.getState();
        if (historyState.canRedo()) {
          e.preventDefault();
          const entry = historyState.redo();
          if (entry) {
            switch (entry.type) {
              case 'add':
                addAnnotation(entry.annotation);
                break;
              case 'update':
                updateAnnotation(entry.annotation.id, entry.annotation);
                break;
              case 'delete':
                deleteAnnotation(entry.annotation.id);
                break;
            }
          }
        }
        return;
      }

      // Skip other shortcuts if in editing mode or in an input
      if (editingAnnotationId || isInput) return;

      // Get selected annotation
      const selectedAnnotation = selectedAnnotationId
        ? annotations.find((a) => a.id === selectedAnnotationId)
        : null;

      // Delete/Backspace to delete annotation
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotation) {
        e.preventDefault();
        recordDelete(selectedAnnotation);
        deleteAnnotation(selectedAnnotation.id);
        return;
      }

      // Enter to enter editing mode for freetext
      if (e.key === 'Enter' && selectedAnnotation?.type === 'freetext') {
        e.preventDefault();
        const ftAnnotation = selectedAnnotation as FreeTextAnnotation;
        setEditingAnnotationId(ftAnnotation.id);
        setEditingContent(ftAnnotation.content || '');
        if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
          setEditingSegments(ftAnnotation.richContent);
        } else {
          const style = getAnnotationStyle(ftAnnotation);
          setEditingSegments(textToSegments(ftAnnotation.content || '', style));
        }
        return;
      }

      // Arrow keys to nudge position (1px, or 10px with Shift)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedAnnotation) {
        e.preventDefault();
        const nudgeAmount = isShift ? 10 : 1;
        const previousState = { ...selectedAnnotation };

        if ('rect' in selectedAnnotation) {
          const rect = [...(selectedAnnotation as { rect: [number, number, number, number] }).rect] as [number, number, number, number];
          switch (e.key) {
            case 'ArrowUp': rect[1] += nudgeAmount; break;
            case 'ArrowDown': rect[1] -= nudgeAmount; break;
            case 'ArrowLeft': rect[0] -= nudgeAmount; break;
            case 'ArrowRight': rect[0] += nudgeAmount; break;
          }
          updateAnnotation(selectedAnnotation.id, { rect });
          recordUpdate({ ...selectedAnnotation, rect }, previousState);
        } else if (selectedAnnotation.type === 'sticky-note') {
          const pos = { ...(selectedAnnotation as { position: { x: number; y: number } }).position };
          switch (e.key) {
            case 'ArrowUp': pos.y += nudgeAmount; break;
            case 'ArrowDown': pos.y -= nudgeAmount; break;
            case 'ArrowLeft': pos.x -= nudgeAmount; break;
            case 'ArrowRight': pos.x += nudgeAmount; break;
          }
          updateAnnotation(selectedAnnotation.id, { position: pos });
          recordUpdate({ ...selectedAnnotation, position: pos }, previousState);
        } else if (selectedAnnotation.type === 'line' || selectedAnnotation.type === 'arrow') {
          const ann = selectedAnnotation as { start: [number, number]; end: [number, number] };
          const start = [...ann.start] as [number, number];
          const end = [...ann.end] as [number, number];
          switch (e.key) {
            case 'ArrowUp': start[1] += nudgeAmount; end[1] += nudgeAmount; break;
            case 'ArrowDown': start[1] -= nudgeAmount; end[1] -= nudgeAmount; break;
            case 'ArrowLeft': start[0] -= nudgeAmount; end[0] -= nudgeAmount; break;
            case 'ArrowRight': start[0] += nudgeAmount; end[0] += nudgeAmount; break;
          }
          updateAnnotation(selectedAnnotation.id, { start, end });
          recordUpdate({ ...selectedAnnotation, start, end }, previousState);
        }
        return;
      }

      // Ctrl+D to duplicate
      if (isCtrl && e.key.toLowerCase() === 'd' && selectedAnnotation) {
        e.preventDefault();
        const duplicated = JSON.parse(JSON.stringify(selectedAnnotation));
        duplicated.id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        duplicated.createdAt = new Date();
        duplicated.modifiedAt = new Date();

        // Offset the duplicate
        if ('rect' in duplicated) {
          duplicated.rect[0] += 20;
          duplicated.rect[1] -= 20;
        } else if (duplicated.type === 'sticky-note') {
          duplicated.position.x += 20;
          duplicated.position.y -= 20;
        } else if (duplicated.type === 'line' || duplicated.type === 'arrow') {
          duplicated.start[0] += 20;
          duplicated.start[1] -= 20;
          duplicated.end[0] += 20;
          duplicated.end[1] -= 20;
        }

        addAnnotation(duplicated);
        recordAdd(duplicated);
        selectAnnotation(duplicated.id);
        return;
      }

      // Ctrl+C to copy annotation to clipboard
      if (isCtrl && e.key.toLowerCase() === 'c' && selectedAnnotation) {
        e.preventDefault();
        // Store in a global clipboard for annotations
        (window as unknown as { __annotationClipboard?: Annotation }).__annotationClipboard = JSON.parse(JSON.stringify(selectedAnnotation));
        // Also copy text content to system clipboard if it's a text annotation
        if (selectedAnnotation.type === 'freetext') {
          navigator.clipboard.writeText((selectedAnnotation as FreeTextAnnotation).content || '');
        }
        return;
      }

      // Ctrl+X to cut annotation
      if (isCtrl && e.key.toLowerCase() === 'x' && selectedAnnotation) {
        e.preventDefault();
        // Store in clipboard
        (window as unknown as { __annotationClipboard?: Annotation }).__annotationClipboard = JSON.parse(JSON.stringify(selectedAnnotation));
        // Copy text to system clipboard
        if (selectedAnnotation.type === 'freetext') {
          navigator.clipboard.writeText((selectedAnnotation as FreeTextAnnotation).content || '');
        }
        // Delete the original
        recordDelete(selectedAnnotation);
        deleteAnnotation(selectedAnnotation.id);
        return;
      }

      // Ctrl+V to paste annotation
      if (isCtrl && e.key.toLowerCase() === 'v' && !selectedAnnotation) {
        const clipboard = (window as unknown as { __annotationClipboard?: Annotation }).__annotationClipboard;
        if (clipboard && clipboard.pageNumber === pageNumber) {
          e.preventDefault();
          const pasted = JSON.parse(JSON.stringify(clipboard));
          pasted.id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          pasted.createdAt = new Date();
          pasted.modifiedAt = new Date();

          // Offset the paste
          if ('rect' in pasted) {
            pasted.rect[0] += 20;
            pasted.rect[1] -= 20;
          } else if (pasted.type === 'sticky-note') {
            pasted.position.x += 20;
            pasted.position.y -= 20;
          } else if (pasted.type === 'line' || pasted.type === 'arrow') {
            pasted.start[0] += 20;
            pasted.start[1] -= 20;
            pasted.end[0] += 20;
            pasted.end[1] -= 20;
          }

          addAnnotation(pasted);
          recordAdd(pasted);
          selectAnnotation(pasted.id);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedAnnotationId, deleteAnnotation, updateAnnotation, addAnnotation, editingAnnotationId, annotations, recordDelete]);

  // Handle undo for annotations
  const handleAnnotationUndo = useCallback(() => {
    const historyState = useAnnotationHistoryStore.getState();
    if (!historyState.canUndo()) return false;

    const entry = historyState.undo();
    if (!entry) return false;

    switch (entry.type) {
      case 'add':
        deleteAnnotation(entry.annotation.id);
        break;
      case 'update':
        if (entry.previousState) {
          updateAnnotation(entry.annotation.id, entry.previousState);
        }
        break;
      case 'delete':
        addAnnotation(entry.annotation);
        break;
    }
    return true;
  }, [deleteAnnotation, updateAnnotation, addAnnotation]);

  // Handle redo for annotations
  const handleAnnotationRedo = useCallback(() => {
    const historyState = useAnnotationHistoryStore.getState();
    if (!historyState.canRedo()) return false;

    const entry = historyState.redo();
    if (!entry) return false;

    switch (entry.type) {
      case 'add':
        addAnnotation(entry.annotation);
        break;
      case 'update':
        updateAnnotation(entry.annotation.id, entry.annotation);
        break;
      case 'delete':
        deleteAnnotation(entry.annotation.id);
        break;
    }
    return true;
  }, [addAnnotation, updateAnnotation, deleteAnnotation]);

  // Handle text formatting shortcuts in edit mode
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    // Handle Undo/Redo - these should work even while editing
    if (isCtrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (isShift) {
        handleAnnotationRedo();
      } else {
        handleAnnotationUndo();
      }
      return;
    }

    // Handle Ctrl+Y for redo
    if (isCtrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      handleAnnotationRedo();
      return;
    }

    if (e.key === 'Escape') {
      const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
      if (annotation && annotation.type === 'freetext' && !annotation.content) {
        // Record deletion for undo before deleting
        recordDelete(annotation);
        deleteAnnotation(editingAnnotationId!);
      }
      setEditingAnnotationId(null);
      setEditingContent('');
    } else if (e.key === 'Enter' && isCtrl) {
      finishEditing();
    } else if (isCtrl && editingAnnotationId) {
      // Formatting shortcuts
      const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
      if (annotation && annotation.type === 'freetext') {
        const currentStyle = getAnnotationStyle(annotation);
        let styleUpdate: Partial<TextStyle> | null = null;

        switch (e.key.toLowerCase()) {
          case 'b':
            styleUpdate = { fontWeight: currentStyle.fontWeight === 'bold' ? 'normal' : 'bold' };
            e.preventDefault();
            break;
          case 'i':
            styleUpdate = { fontStyle: currentStyle.fontStyle === 'italic' ? 'normal' : 'italic' };
            e.preventDefault();
            break;
          case 'u':
            styleUpdate = { textDecoration: currentStyle.textDecoration === 'underline' ? 'none' : 'underline' };
            e.preventDefault();
            break;
        }

        // Handle Ctrl+Shift shortcuts
        if (e.shiftKey) {
          switch (e.key.toLowerCase()) {
            case 'x':
            case 's':
              // Toggle strikethrough
              styleUpdate = { textDecoration: currentStyle.textDecoration === 'line-through' ? 'none' : 'line-through' };
              e.preventDefault();
              break;
          }
        }

        if (styleUpdate) {
          const previousState = { ...annotation };
          const newStyle = { ...currentStyle, ...styleUpdate };
          updateAnnotation(editingAnnotationId, { style: newStyle });
          recordUpdate({ ...annotation, style: newStyle }, previousState);
        }
      }
    }
    e.stopPropagation();
  };

  // Handle style change from format toolbar
  const handleStyleChange = (styleUpdates: Partial<TextStyle>) => {
    if (!selectedAnnotationId) return;

    const annotation = annotations.find((a) => a.id === selectedAnnotationId) as FreeTextAnnotation | undefined;
    if (!annotation || annotation.type !== 'freetext') return;

    // Check if we're in rich text editing mode with a selection
    if (useRichTextEditor && editingAnnotationId === selectedAnnotationId) {
      const { cursor, mergePendingFormat } = useTextBoxStore.getState();
      const hasSelection = cursor.selectionStart !== null &&
                          cursor.selectionEnd !== null &&
                          cursor.selectionStart !== cursor.selectionEnd;

      if (hasSelection) {
        // Apply style to selection
        const selStart = Math.min(cursor.selectionStart!, cursor.selectionEnd!);
        const selEnd = Math.max(cursor.selectionStart!, cursor.selectionEnd!);
        const newSegments = applyStyleToRange(editingSegments, selStart, selEnd, styleUpdates);
        setEditingSegments(normalizeSegments(newSegments));
      } else {
        // Set pending format for next typed character
        mergePendingFormat(styleUpdates);
      }
      return;
    }

    // Apply to whole text box when not in rich text editing mode
    const previousState = { ...annotation };
    const currentStyle = getAnnotationStyle(annotation);
    const newStyle = { ...currentStyle, ...styleUpdates };

    updateAnnotation(selectedAnnotationId, { style: newStyle });
    recordUpdate({ ...annotation, style: newStyle }, previousState);
  };

  // Get editing annotation rect for textarea
  const getEditingAnnotationRect = () => {
    if (!editingAnnotationId) return null;
    const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
    if (!annotation || annotation.type !== 'freetext') return null;

    const style = getAnnotationStyle(annotation);
    const { rect } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    return {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
      style,
    };
  };

  // Get current selection style for toolbar (when editing with RichTextEditor)
  const getEditingSelectionStyle = useCallback(() => {
    if (!editingAnnotationId || editingSegments.length === 0) return null;

    const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
    if (!annotation) return null;

    const { cursor, pendingFormat } = useTextBoxStore.getState();
    const defaultStyle = getAnnotationStyle(annotation);

    // If pending format is set, merge it with current style
    if (pendingFormat && Object.keys(pendingFormat).length > 0) {
      return {
        style: { ...defaultStyle, ...pendingFormat } as Partial<TextStyle>,
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

    const hasSelection = cursor.selectionStart !== null &&
                        cursor.selectionEnd !== null &&
                        cursor.selectionStart !== cursor.selectionEnd;

    if (hasSelection) {
      const selStart = Math.min(cursor.selectionStart!, cursor.selectionEnd!);
      const selEnd = Math.max(cursor.selectionStart!, cursor.selectionEnd!);
      return getSelectionStyle(editingSegments, selStart, selEnd);
    }

    // No selection - return style at cursor position
    return {
      style: defaultStyle,
      isMixed: {
        fontFamily: false,
        fontSize: false,
        fontWeight: false,
        fontStyle: false,
        textDecoration: false,
        color: false,
      },
    };
  }, [editingAnnotationId, editingSegments, annotations]);

  // Get selected freetext annotation rect for format toolbar
  const getSelectedFreetextRect = () => {
    if (!selectedAnnotationId) return null;
    const annotation = annotations.find((a) => a.id === selectedAnnotationId) as FreeTextAnnotation | undefined;
    if (!annotation || annotation.type !== 'freetext') return null;

    const { rect } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);

    // Get the appropriate style based on whether we're editing
    let style: Partial<TextStyle>;
    let isMixed = {
      fontFamily: false,
      fontSize: false,
      fontWeight: false,
      fontStyle: false,
      textDecoration: false,
      color: false,
    };

    if (editingAnnotationId === selectedAnnotationId && useRichTextEditor) {
      const selectionStyle = getEditingSelectionStyle();
      if (selectionStyle) {
        style = selectionStyle.style;
        isMixed = selectionStyle.isMixed;
      } else {
        style = getAnnotationStyle(annotation);
      }
    } else {
      style = getAnnotationStyle(annotation);
    }

    return {
      left: topLeft.x,
      top: topLeft.y - 50, // Position above the text box
      style,
      isMixed,
      hasSelection: useTextBoxStore.getState().cursor.selectionStart !== null,
    };
  };

  const editingRect = getEditingAnnotationRect();
  const formatToolbarRect = getSelectedFreetextRect();

  // Determine cursor based on position
  const getCursor = () => {
    if (isDragging) return 'move';
    if (isRotating) return 'grabbing';
    if (isResizing) {
      const cursors: Record<string, string> = {
        nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
        e: 'e-resize', se: 'se-resize', s: 's-resize',
        sw: 'sw-resize', w: 'w-resize'
      };
      return cursors[resizeHandle || ''] || 'default';
    }
    if (currentTool === 'pan') return 'grab';
    if (currentTool !== 'select') return 'crosshair';
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      className={`drawing-annotation-layer ${currentTool !== 'select' && currentTool !== 'pan' ? 'drawing-mode' : ''} ${currentTool === 'pan' ? 'pan-mode' : ''}`}
      style={{
        width: dimensions.width,
        height: dimensions.height,
        cursor: getCursor(),
      }}
      onMouseDown={currentTool === 'pan' ? undefined : handleMouseDown}
      onMouseMove={currentTool === 'pan' ? undefined : handleMouseMove}
      onMouseUp={currentTool === 'pan' ? undefined : handleMouseUp}
      onClick={currentTool === 'pan' ? undefined : handleClick}
      onDoubleClick={currentTool === 'pan' ? undefined : handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if right-clicking on a freetext annotation
        for (const annotation of annotations) {
          if (annotation.type === 'freetext' && isPointInAnnotation(x, y, annotation)) {
            selectAnnotation(annotation.id);
            setContextMenu({
              annotation: annotation as FreeTextAnnotation,
              position: { x: e.clientX, y: e.clientY },
            });
            return;
          }
        }
        setContextMenu(null);
      }}
    >
      <canvas ref={canvasRef} className="annotation-canvas" />

      {/* Format toolbar for selected freetext */}
      {formatToolbarRect && (
        <div
          className="format-toolbar-container"
          style={{
            position: 'absolute',
            left: Math.max(0, formatToolbarRect.left),
            top: Math.max(0, formatToolbarRect.top),
            zIndex: 1001,
          }}
          data-format-toolbar="true"
          // Prevent mousedown from stealing focus from RichTextEditor
          // This keeps the hidden input focused so blur/finishEditing doesn't fire
          onMouseDown={(e) => {
            // Don't prevent default for actual input elements that need focus
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
            if (!isInput) {
              e.preventDefault();
            }
          }}
        >
          <TextFormatToolbar
            style={formatToolbarRect.style}
            onChange={handleStyleChange}
            isMixed={formatToolbarRect.isMixed}
            hasSelection={formatToolbarRect.hasSelection}
          />
        </div>
      )}

      {/* Rich text editing with RichTextEditor */}
      {editingAnnotationId && editingRect && useRichTextEditor && (
        <div
          className="freetext-editor-container"
          style={{
            position: 'absolute',
            left: editingRect.left,
            top: editingRect.top,
            width: editingRect.width,
            height: editingRect.height,
            border: '2px solid #0066FF',
            borderRadius: '2px',
            backgroundColor: editingRect.style.backgroundColor === 'transparent' ? 'white' : editingRect.style.backgroundColor,
            boxSizing: 'border-box',
            zIndex: 1002,
            overflow: 'hidden',
          }}
        >
          <RichTextEditor
            segments={editingSegments}
            defaultStyle={editingRect.style}
            width={editingRect.width - 4}
            height={editingRect.height - 4}
            scale={1}
            padding={8}
            textAlign={editingRect.style.textAlign}
            onChange={setEditingSegments}
            onBlur={finishEditing}
            autoFocus={true}
          />
        </div>
      )}

      {/* Legacy text editing textarea (fallback) */}
      {editingAnnotationId && editingRect && !useRichTextEditor && (
        <textarea
          ref={textareaRef}
          className="freetext-editor"
          placeholder="Type here..."
          style={{
            position: 'absolute',
            left: editingRect.left,
            top: editingRect.top,
            width: editingRect.width,
            height: editingRect.height,
            fontSize: editingRect.style.fontSize * scale,
            fontFamily: editingRect.style.fontFamily,
            fontWeight: editingRect.style.fontWeight,
            fontStyle: editingRect.style.fontStyle,
            textDecoration: editingRect.style.textDecoration,
            textAlign: editingRect.style.textAlign,
            color: editingRect.style.color,
            backgroundColor: editingRect.style.backgroundColor === 'transparent' ? 'white' : editingRect.style.backgroundColor,
            padding: '4px',
            border: '2px solid #0066FF',
            borderRadius: '2px',
            resize: 'none',
            overflow: 'auto',
            outline: 'none',
            boxSizing: 'border-box',
            zIndex: 1002,
          }}
          value={editingContent}
          onChange={(e) => setEditingContent(e.target.value)}
          onBlur={finishEditing}
          onKeyDown={handleTextareaKeyDown}
        />
      )}

      {/* Context menu for text boxes */}
      {contextMenu && (
        <TextBoxContextMenu
          annotation={contextMenu.annotation}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onEditText={() => {
            const ftAnnotation = contextMenu.annotation;
            setEditingAnnotationId(ftAnnotation.id);
            setEditingContent(ftAnnotation.content || '');

            // Initialize segments for rich text editing
            if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
              setEditingSegments(ftAnnotation.richContent);
            } else {
              const style = getAnnotationStyle(ftAnnotation);
              setEditingSegments(textToSegments(ftAnnotation.content || '', style));
            }

            setContextMenu(null);
            if (!useRichTextEditor) {
              setTimeout(() => textareaRef.current?.focus(), 0);
            }
          }}
          onShowTextProperties={() => {
            setShowTextPropertiesPanel(true);
            setShowBoxPropertiesPanel(false);
          }}
          onShowBoxProperties={() => {
            setShowBoxPropertiesPanel(true);
            setShowTextPropertiesPanel(false);
          }}
        />
      )}

      {/* Text Properties Panel */}
      {showTextPropertiesPanel && selectedAnnotation?.type === 'freetext' && (
        <div className="properties-panel-overlay">
          <TextPropertiesPanel
            annotation={selectedAnnotation as FreeTextAnnotation}
            onClose={() => setShowTextPropertiesPanel(false)}
          />
        </div>
      )}

      {/* Box Properties Panel */}
      {showBoxPropertiesPanel && selectedAnnotation?.type === 'freetext' && (
        <div className="properties-panel-overlay">
          <BoxPropertiesPanel
            annotation={selectedAnnotation as FreeTextAnnotation}
            onClose={() => setShowBoxPropertiesPanel(false)}
          />
        </div>
      )}
    </div>
  );
}
