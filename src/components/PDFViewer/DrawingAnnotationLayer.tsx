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
import type { Annotation } from '../../annotations/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
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
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

      // Get coordinates relative to the viewport
      const pdfX = screenX / scale;
      const pdfY = (viewport.height - screenY) / scale; // PDF Y is from bottom

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

  // Render annotations on canvas
  // Note: render functions are defined below but hoisted in the closure
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = dimensions.width;
    canvas.height = dimensions.height;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Render each annotation
    for (const annotation of annotations) {
      renderAnnotation(ctx, annotation, selectedAnnotationId === annotation.id);
    }

    // Render current drawing preview
    if (isDrawing && currentTool !== 'select') {
      renderDrawingPreview(ctx);
    }
  }, [annotations, dimensions, scale, selectedAnnotationId, isDrawing, currentPath, startPoint, currentTool, toolSettings]);
  /* eslint-enable react-hooks/immutability */

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

  // Render text markup (highlight, underline, strikeout)
  const renderTextMarkup = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'highlight' | 'underline' | 'strikeout' }
  ) => {
    const { quadPoints, color, opacity, type } = annotation;

    for (const quad of quadPoints) {
      // quad is [x1,y1,x2,y2,x3,y3,x4,y4] - four corners of the quad
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
        // Draw line at bottom of quad
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
      } else if (type === 'strikeout') {
        // Draw line through middle of quad
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

    // Draw arrow head if needed
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
      // Draw selection points at start and end
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

    // Draw sticky note icon
    const size = 24;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;

    // Draw note shape
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.lineTo(screen.x + size, screen.y);
    ctx.lineTo(screen.x + size, screen.y + size - 6);
    ctx.lineTo(screen.x + size - 6, screen.y + size);
    ctx.lineTo(screen.x, screen.y + size);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Draw corner fold
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
      // Draw custom image stamp
      const img = new Image();
      img.src = customImageData;
      // Note: This is async, might need to handle differently for proper rendering
      ctx.drawImage(img, topLeft.x, topLeft.y, width, height);
    } else {
      // Draw predefined stamp as text
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3;
      ctx.font = `bold ${Math.min(height * 0.4, 24)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Draw border
      ctx.strokeRect(topLeft.x + 2, topLeft.y + 2, width - 4, height - 4);

      // Draw text
      ctx.fillText(stampName.toUpperCase(), topLeft.x + width / 2, topLeft.y + height / 2);
    }

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height);
    }
  };

  // Render free text
  const renderFreeText = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation & { type: 'freetext' },
    isSelected: boolean
  ) => {
    const { rect, content, fontSize, textColor, backgroundColor, borderColor, borderWidth } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(topLeft.x, topLeft.y, width, height);
    }

    if (borderColor && borderWidth > 0) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;
      ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    }

    ctx.fillStyle = textColor;
    ctx.font = `${fontSize * scale}px Helvetica`;
    ctx.textBaseline = 'top';

    // Simple text wrapping
    const lines = content.split('\n');
    let y = topLeft.y + 4;
    for (const line of lines) {
      ctx.fillText(line, topLeft.x + 4, y);
      y += fontSize * scale * 1.2;
    }

    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height);
    }
  };

  // Render selection handles
  const renderSelectionHandles = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number
  ) => {
    const handleSize = 8;
    ctx.fillStyle = '#0066FF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;

    const handles = [
      { x: x, y: y }, // top-left
      { x: x + width / 2, y: y }, // top-center
      { x: x + width, y: y }, // top-right
      { x: x + width, y: y + height / 2 }, // middle-right
      { x: x + width, y: y + height }, // bottom-right
      { x: x + width / 2, y: y + height }, // bottom-center
      { x: x, y: y + height }, // bottom-left
      { x: x, y: y + height / 2 }, // middle-left
    ];

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
    }
  };

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (currentTool === 'select') return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    setStartPoint({ x, y });
    setCurrentPath([{ x, y }]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || currentTool === 'select') return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setCurrentPath((prev) => [...prev, { x, y }]);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDrawing || !startPoint) {
      setIsDrawing(false);
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    // Convert to PDF coordinates
    const startPdf = screenToPdfCoords(startPoint.x, startPoint.y);
    const endPdf = screenToPdfCoords(endX, endY);

    // Create annotation based on tool
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
        const x = Math.min(startPdf.x, endPdf.x);
        const y = Math.min(startPdf.y, endPdf.y);
        const w = Math.abs(endPdf.x - startPdf.x) || 100;
        const h = Math.abs(endPdf.y - startPdf.y) || 30;
        annotation = createFreeTextAnnotation(
          pageNumber,
          [x, y, w, h],
          'Type here...',
          toolSettings.fontSize,
          toolSettings.color
        );
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

    // Check if double-click is on a freetext annotation
    for (const annotation of annotations) {
      if (annotation.type === 'freetext' && isPointInAnnotation(x, y, annotation)) {
        setEditingAnnotationId(annotation.id);
        setEditingContent(annotation.content || '');
        selectAnnotation(annotation.id);
        // Focus textarea after state update
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
    }
  };

  // Finish editing text box
  const finishEditing = () => {
    if (!editingAnnotationId) return;

    const annotation = annotations.find((a) => a.id === editingAnnotationId);
    if (annotation && annotation.type === 'freetext') {
      const previousState = { ...annotation };
      updateAnnotation(editingAnnotationId, { content: editingContent });
      recordUpdate({ ...annotation, content: editingContent }, previousState);
    }

    setEditingAnnotationId(null);
    setEditingContent('');
  };

  // Handle click for selection
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (currentTool !== 'select') return;

    // Don't handle click if we're editing
    if (editingAnnotationId) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if click is on any annotation
    let clicked = false;
    for (const annotation of annotations) {
      if (isPointInAnnotation(x, y, annotation)) {
        selectAnnotation(annotation.id);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
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
        // Check distance from point to line
        const dist = distanceToLine(x, y, startScreen.x, startScreen.y, endScreen.x, endScreen.y);
        return dist < 10;
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

  // Handle keyboard for delete
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't delete while editing text
      if (editingAnnotationId) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotationId) {
        const annotation = annotations.find((a) => a.id === selectedAnnotationId);
        if (annotation) {
          recordDelete(annotation);
          deleteAnnotation(selectedAnnotationId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedAnnotationId, deleteAnnotation, editingAnnotationId, annotations, recordDelete]);

  // Get the position and size of the editing annotation for textarea overlay
  const getEditingAnnotationRect = () => {
    if (!editingAnnotationId) return null;
    const annotation = annotations.find((a) => a.id === editingAnnotationId);
    if (!annotation || annotation.type !== 'freetext') return null;

    const { rect, fontSize } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    return {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
      fontSize: fontSize * scale,
    };
  };

  const editingRect = getEditingAnnotationRect();

  return (
    <div
      ref={containerRef}
      className={`drawing-annotation-layer ${currentTool !== 'select' ? 'drawing-mode' : ''}`}
      style={{ width: dimensions.width, height: dimensions.height }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <canvas ref={canvasRef} className="annotation-canvas" />
      {editingAnnotationId && editingRect && (
        <textarea
          ref={textareaRef}
          className="freetext-editor"
          style={{
            position: 'absolute',
            left: editingRect.left,
            top: editingRect.top,
            width: editingRect.width,
            height: editingRect.height,
            fontSize: editingRect.fontSize,
            fontFamily: 'Helvetica, sans-serif',
            padding: '4px',
            border: '2px solid #0066FF',
            borderRadius: '2px',
            resize: 'none',
            overflow: 'hidden',
            background: 'white',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          value={editingContent}
          onChange={(e) => setEditingContent(e.target.value)}
          onBlur={finishEditing}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setEditingAnnotationId(null);
              setEditingContent('');
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              finishEditing();
            }
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}
