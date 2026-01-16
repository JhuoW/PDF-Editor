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
  createImageAnnotation,
} from '../../store/annotationStore';
import type { Annotation, FreeTextAnnotation, ImageAnnotation, TextStyle } from '../../annotations/types';
import type { PendingImageData } from '../Toolbar/CombinedToolbar';
import { DEFAULT_TEXT_STYLE } from '../../annotations/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { TextBoxContextMenu, BoxPropertiesPanel, TextPropertiesPanel, TipTapEditor } from '../TextBox';
import { ImageContextMenu, ImagePropertiesPanel } from '../ImageToolbar';
import type { TipTapEditorRef } from '../TextBox';
import { useTextBoxStore } from '../../store/textBoxStore';
import {
  textToSegments,
} from '../../utils/richText';
import { parseTipTapHTML, segmentsToTipTapHTML } from '../../utils/tiptapConverter';
import './DrawingAnnotationLayer.css';

interface DrawingAnnotationLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  pendingImages?: PendingImageData[];
  onImagePlaced?: () => void;
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
  pendingImages,
  onImagePlaced,
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
  const tiptapEditorRef = useRef<TipTapEditorRef>(null);
  const lastHtmlContentRef = useRef<string>(''); // Store latest HTML for reliable access
  const { setSegments } = useTextBoxStore();
  // setEditingSegments is kept for legacy code paths (non-TipTap)
  const setEditingSegments = setSegments;
  const useTipTapEditor = true; // Use TipTap editor
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

  // Context menu state (for freetext)
  const [contextMenu, setContextMenu] = useState<{
    annotation: FreeTextAnnotation;
    position: { x: number; y: number };
  } | null>(null);

  // Image context menu state
  const [imageContextMenu, setImageContextMenu] = useState<{
    annotation: ImageAnnotation;
    position: { x: number; y: number };
  } | null>(null);

  // Drag-and-drop state for images
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Crop mode state
  const [isCropping, setIsCropping] = useState(false);
  const [cropBounds, setCropBounds] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null);
  const [cropHandle, setCropHandle] = useState<'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null>(null);
  const [cropStart, setCropStart] = useState<Point | null>(null);
  const [initialCropBounds, setInitialCropBounds] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null);

  // Properties panel state
  const [showTextPropertiesPanel, setShowTextPropertiesPanel] = useState(false);
  const [showBoxPropertiesPanel, setShowBoxPropertiesPanel] = useState(false);
  const [showImagePropertiesPanel, setShowImagePropertiesPanel] = useState(false);

  // Snap guides state
  const [snapGuides, setSnapGuides] = useState<{
    vertical: number[];  // X positions of vertical guides (in screen coords)
    horizontal: number[]; // Y positions of horizontal guides (in screen coords)
  }>({ vertical: [], horizontal: [] });
  const SNAP_THRESHOLD = 8; // Pixels threshold for snapping

  // Store original annotation state for undo (before drag/resize modifications)
  const originalAnnotationRef = useRef<Annotation | null>(null);

  // Ref to track if we just finished drag/resize (for click handler)
  const justFinishedInteraction = useRef(false);

  // Image cache for rendering - stores loaded HTMLImageElement objects
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());

  const {
    currentTool,
    toolSettings,
    getAnnotationsForPage,
    addAnnotation,
    updateAnnotation,
    selectedAnnotationId,
    selectAnnotation,
    deleteAnnotation,
    cropModeAnnotationId,
    exitCropMode,
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

  // Handle entering crop mode from store (triggered by ImageToolbar)
  useEffect(() => {
    if (!cropModeAnnotationId) return;

    // Check if the annotation to crop is on this page
    const annotationToCrop = annotations.find(a => a.id === cropModeAnnotationId);
    if (!annotationToCrop || annotationToCrop.type !== 'image') return;

    // Enter crop mode
    const imgAnnotation = annotationToCrop as ImageAnnotation;
    const existingCrop = imgAnnotation.cropBounds || { top: 0, right: 0, bottom: 0, left: 0 };
    setCropBounds(existingCrop);
    setInitialCropBounds(existingCrop);
    setIsCropping(true);
  }, [cropModeAnnotationId, annotations]);

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

  // Calculate snap targets for the current page
  const calculateSnapTargets = useCallback((excludeAnnotationId?: string) => {
    const targets = {
      vertical: [] as { position: number; type: 'center' | 'edge' | 'annotation' }[],
      horizontal: [] as { position: number; type: 'center' | 'edge' | 'annotation' }[],
    };

    // Page center and edges (in PDF coords)
    const pageWidth = dimensions.width / scale;
    const pageHeight = dimensions.height / scale;

    // Page center
    targets.vertical.push({ position: pageWidth / 2, type: 'center' });
    targets.horizontal.push({ position: pageHeight / 2, type: 'center' });

    // Page edges (small margin from edge)
    const margin = 10;
    targets.vertical.push({ position: margin, type: 'edge' });
    targets.vertical.push({ position: pageWidth - margin, type: 'edge' });
    targets.horizontal.push({ position: margin, type: 'edge' });
    targets.horizontal.push({ position: pageHeight - margin, type: 'edge' });

    // Other annotations on this page
    for (const annotation of annotations) {
      if (annotation.id === excludeAnnotationId) continue;

      let bounds: { left: number; right: number; top: number; bottom: number } | null = null;

      if ('rect' in annotation) {
        const rect = (annotation as { rect: [number, number, number, number] }).rect;
        bounds = {
          left: rect[0],
          right: rect[0] + rect[2],
          bottom: rect[1],
          top: rect[1] + rect[3],
        };
      } else if (annotation.type === 'sticky-note') {
        const pos = (annotation as { position: { x: number; y: number } }).position;
        // Sticky notes are small, use position as center
        bounds = { left: pos.x - 12, right: pos.x + 12, bottom: pos.y - 12, top: pos.y + 12 };
      }

      if (bounds) {
        // Center of annotation
        targets.vertical.push({ position: (bounds.left + bounds.right) / 2, type: 'annotation' });
        targets.horizontal.push({ position: (bounds.bottom + bounds.top) / 2, type: 'annotation' });
        // Edges
        targets.vertical.push({ position: bounds.left, type: 'annotation' });
        targets.vertical.push({ position: bounds.right, type: 'annotation' });
        targets.horizontal.push({ position: bounds.bottom, type: 'annotation' });
        targets.horizontal.push({ position: bounds.top, type: 'annotation' });
      }
    }

    return targets;
  }, [annotations, dimensions.width, dimensions.height, scale]);

  // Apply snapping to a position and return snapped position plus active guides
  const applySnapping = useCallback((
    annotationBounds: { left: number; right: number; top: number; bottom: number },
    targets: ReturnType<typeof calculateSnapTargets>
  ): {
    deltaX: number;
    deltaY: number;
    guides: { vertical: number[]; horizontal: number[] };
  } => {
    const threshold = SNAP_THRESHOLD / scale; // Convert pixel threshold to PDF coords
    let deltaX = 0;
    let deltaY = 0;
    const guides = { vertical: [] as number[], horizontal: [] as number[] };

    const annotationCenterX = (annotationBounds.left + annotationBounds.right) / 2;
    const annotationCenterY = (annotationBounds.bottom + annotationBounds.top) / 2;

    // Check vertical snapping (X positions)
    for (const target of targets.vertical) {
      // Check left edge
      if (Math.abs(annotationBounds.left - target.position) < threshold && deltaX === 0) {
        deltaX = target.position - annotationBounds.left;
        guides.vertical.push(target.position);
      }
      // Check right edge
      else if (Math.abs(annotationBounds.right - target.position) < threshold && deltaX === 0) {
        deltaX = target.position - annotationBounds.right;
        guides.vertical.push(target.position);
      }
      // Check center
      else if (Math.abs(annotationCenterX - target.position) < threshold && deltaX === 0) {
        deltaX = target.position - annotationCenterX;
        guides.vertical.push(target.position);
      }
    }

    // Check horizontal snapping (Y positions)
    for (const target of targets.horizontal) {
      // Check bottom edge
      if (Math.abs(annotationBounds.bottom - target.position) < threshold && deltaY === 0) {
        deltaY = target.position - annotationBounds.bottom;
        guides.horizontal.push(target.position);
      }
      // Check top edge
      else if (Math.abs(annotationBounds.top - target.position) < threshold && deltaY === 0) {
        deltaY = target.position - annotationBounds.top;
        guides.horizontal.push(target.position);
      }
      // Check center
      else if (Math.abs(annotationCenterY - target.position) < threshold && deltaY === 0) {
        deltaY = target.position - annotationCenterY;
        guides.horizontal.push(target.position);
      }
    }

    return { deltaX, deltaY, guides };
  }, [scale, SNAP_THRESHOLD]);

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
      case 'image':
        renderImage(ctx, annotation as ImageAnnotation, isSelected);
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

  // Render image annotation
  const renderImage = (
    ctx: CanvasRenderingContext2D,
    annotation: ImageAnnotation,
    isSelected: boolean
  ) => {
    const { rect, imageData, opacity, rotation = 0, flipHorizontal, flipVertical, borderWidth, borderColor, borderStyle, borderRadius } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    const centerX = topLeft.x + width / 2;
    const centerY = topLeft.y + height / 2;

    ctx.save();

    // Apply rotation around center
    if (rotation !== 0) {
      ctx.translate(centerX, centerY);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-centerX, -centerY);
    }

    // Apply flip transforms
    if (flipHorizontal || flipVertical) {
      ctx.translate(centerX, centerY);
      ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
      ctx.translate(-centerX, -centerY);
    }

    // Set opacity
    ctx.globalAlpha = opacity;

    // Get or create cached image
    let img = imageCache.current.get(annotation.id);
    if (!img) {
      img = new Image();
      img.src = imageData;
      imageCache.current.set(annotation.id, img);
      // Force re-render when image loads
      img.onload = () => {
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.dispatchEvent(new Event('imageLoaded'));
        }
      };
    }

    // Draw border if specified
    if (borderWidth > 0 && borderStyle !== 'none') {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderWidth;

      if (borderStyle === 'dashed') {
        ctx.setLineDash([6, 3]);
      } else if (borderStyle === 'dotted') {
        ctx.setLineDash([2, 2]);
      } else {
        ctx.setLineDash([]);
      }

      const scaledRadius = borderRadius * scale;
      if (scaledRadius > 0) {
        // Rounded rectangle border
        ctx.beginPath();
        ctx.moveTo(topLeft.x + scaledRadius, topLeft.y);
        ctx.lineTo(topLeft.x + width - scaledRadius, topLeft.y);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y, topLeft.x + width, topLeft.y + scaledRadius);
        ctx.lineTo(topLeft.x + width, topLeft.y + height - scaledRadius);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y + height, topLeft.x + width - scaledRadius, topLeft.y + height);
        ctx.lineTo(topLeft.x + scaledRadius, topLeft.y + height);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y + height, topLeft.x, topLeft.y + height - scaledRadius);
        ctx.lineTo(topLeft.x, topLeft.y + scaledRadius);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y, topLeft.x + scaledRadius, topLeft.y);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.strokeRect(topLeft.x, topLeft.y, width, height);
      }
      ctx.setLineDash([]);
    }

    // Draw the image if loaded
    if (img.complete && img.naturalWidth > 0) {
      // Clip to border radius if specified
      const scaledRadius = borderRadius * scale;
      if (scaledRadius > 0) {
        ctx.beginPath();
        ctx.moveTo(topLeft.x + scaledRadius, topLeft.y);
        ctx.lineTo(topLeft.x + width - scaledRadius, topLeft.y);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y, topLeft.x + width, topLeft.y + scaledRadius);
        ctx.lineTo(topLeft.x + width, topLeft.y + height - scaledRadius);
        ctx.quadraticCurveTo(topLeft.x + width, topLeft.y + height, topLeft.x + width - scaledRadius, topLeft.y + height);
        ctx.lineTo(topLeft.x + scaledRadius, topLeft.y + height);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y + height, topLeft.x, topLeft.y + height - scaledRadius);
        ctx.lineTo(topLeft.x, topLeft.y + scaledRadius);
        ctx.quadraticCurveTo(topLeft.x, topLeft.y, topLeft.x + scaledRadius, topLeft.y);
        ctx.closePath();
        ctx.clip();
      }

      // Apply crop bounds if specified (non-destructive crop)
      const crop = annotation.cropBounds;
      if (crop && (crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0)) {
        // Calculate source rectangle from crop percentages
        const srcX = (crop.left / 100) * img.naturalWidth;
        const srcY = (crop.top / 100) * img.naturalHeight;
        const srcWidth = img.naturalWidth * (1 - crop.left / 100 - crop.right / 100);
        const srcHeight = img.naturalHeight * (1 - crop.top / 100 - crop.bottom / 100);
        ctx.drawImage(img, srcX, srcY, srcWidth, srcHeight, topLeft.x, topLeft.y, width, height);
      } else {
        ctx.drawImage(img, topLeft.x, topLeft.y, width, height);
      }
    } else {
      // Draw placeholder while loading
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(topLeft.x, topLeft.y, width, height);
      ctx.fillStyle = '#999';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Loading...', centerX, centerY);
    }

    ctx.restore();

    // Draw selection handles (outside of rotation transform) with rotation handle
    if (isSelected) {
      renderSelectionHandles(ctx, topLeft.x, topLeft.y, width, height, true);
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

    // Check if we have rich content to render
    const richContent = annotation.richContent;
    const hasRichContent = richContent && richContent.length > 0;

    // Render text with word wrapping
    const lines = content.split('\n');
    const lineHeight = fontSize * (style.lineHeight || 1.2);
    let y = topLeft.y + paddingTop;

    // Calculate total text height for vertical alignment
    let totalTextHeight = 0;
    const wrappedLines: { text: string; startIndex: number }[] = [];
    let globalCharIndex = 0;

    for (const line of lines) {
      const words = line.split(' ');
      let currentLine = '';
      let lineStartIndex = globalCharIndex;

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        ctx.font = `${fontStyle}${fontSize}px ${style.fontFamily}`;
        const metrics = ctx.measureText(testLine);

        if (metrics.width > textAreaWidth && currentLine) {
          wrappedLines.push({ text: currentLine, startIndex: lineStartIndex });
          totalTextHeight += lineHeight;
          currentLine = word;
          lineStartIndex = globalCharIndex + (i > 0 ? currentLine.length : 0);
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine) {
        wrappedLines.push({ text: currentLine, startIndex: lineStartIndex });
        totalTextHeight += lineHeight;
      }

      globalCharIndex += line.length + 1; // +1 for newline
    }

    // Apply vertical alignment
    const textAreaHeight = height - paddingTop - paddingBottom;
    if (style.verticalAlign === 'middle') {
      y = topLeft.y + paddingTop + (textAreaHeight - totalTextHeight) / 2;
    } else if (style.verticalAlign === 'bottom') {
      y = topLeft.y + height - paddingBottom - totalTextHeight;
    }

    // Helper function to get style at character index from rich content
    const getStyleAtIndex = (charIndex: number): Partial<TextStyle> => {
      if (!hasRichContent) return style;

      let currentIndex = 0;
      for (const segment of richContent!) {
        const segmentEnd = currentIndex + segment.text.length;
        if (charIndex >= currentIndex && charIndex < segmentEnd) {
          return { ...style, ...segment.style };
        }
        currentIndex = segmentEnd;
      }
      return style;
    };

    // Draw wrapped lines
    let plainTextIndex = 0;
    for (const wrappedLine of wrappedLines) {
      const lineText = wrappedLine.text;
      if (y + fontSize > topLeft.y + height - paddingBottom) break;

      if (hasRichContent) {
        // Render with rich text formatting - character by character grouping
        let xOffset = 0;

        // Calculate line width for alignment
        let totalLineWidth = 0;
        let charIdx = 0;
        while (charIdx < lineText.length) {
          const charStyle = getStyleAtIndex(plainTextIndex + charIdx);
          const charFontSize = (charStyle.fontSize || style.fontSize) * scale;
          let charFontStyle = '';
          if (charStyle.fontWeight === 'bold') charFontStyle += 'bold ';
          if (charStyle.fontStyle === 'italic') charFontStyle += 'italic ';
          ctx.font = `${charFontStyle}${charFontSize}px ${charStyle.fontFamily || style.fontFamily}`;

          // Find run of characters with same style
          let runEnd = charIdx + 1;
          while (runEnd < lineText.length) {
            const nextStyle = getStyleAtIndex(plainTextIndex + runEnd);
            if (nextStyle.fontFamily !== charStyle.fontFamily ||
                nextStyle.fontSize !== charStyle.fontSize ||
                nextStyle.fontWeight !== charStyle.fontWeight ||
                nextStyle.fontStyle !== charStyle.fontStyle ||
                nextStyle.color !== charStyle.color ||
                nextStyle.textDecoration !== charStyle.textDecoration) {
              break;
            }
            runEnd++;
          }

          const runText = lineText.slice(charIdx, runEnd);
          totalLineWidth += ctx.measureText(runText).width;
          charIdx = runEnd;
        }

        // Calculate starting X based on alignment
        let drawX = textAreaX;
        if (style.textAlign === 'center') {
          drawX = textAreaX + (textAreaWidth - totalLineWidth) / 2;
        } else if (style.textAlign === 'right') {
          drawX = textAreaX + textAreaWidth - totalLineWidth;
        }

        // Now render the line
        charIdx = 0;
        while (charIdx < lineText.length) {
          const charStyle = getStyleAtIndex(plainTextIndex + charIdx);
          const charFontSize = (charStyle.fontSize || style.fontSize) * scale;
          let charFontStyle = '';
          if (charStyle.fontWeight === 'bold') charFontStyle += 'bold ';
          if (charStyle.fontStyle === 'italic') charFontStyle += 'italic ';
          ctx.font = `${charFontStyle}${charFontSize}px ${charStyle.fontFamily || style.fontFamily}`;
          ctx.fillStyle = charStyle.color || style.color;

          // Find run of characters with same style
          let runEnd = charIdx + 1;
          while (runEnd < lineText.length) {
            const nextStyle = getStyleAtIndex(plainTextIndex + runEnd);
            if (nextStyle.fontFamily !== charStyle.fontFamily ||
                nextStyle.fontSize !== charStyle.fontSize ||
                nextStyle.fontWeight !== charStyle.fontWeight ||
                nextStyle.fontStyle !== charStyle.fontStyle ||
                nextStyle.color !== charStyle.color ||
                nextStyle.textDecoration !== charStyle.textDecoration) {
              break;
            }
            runEnd++;
          }

          const runText = lineText.slice(charIdx, runEnd);
          const runWidth = ctx.measureText(runText).width;

          // Draw text decoration for this run
          if (charStyle.textDecoration === 'underline' || charStyle.textDecoration === 'line-through') {
            const decoY = charStyle.textDecoration === 'underline' ? y + charFontSize + 2 : y + charFontSize / 2;
            ctx.beginPath();
            ctx.moveTo(drawX + xOffset, decoY);
            ctx.lineTo(drawX + xOffset + runWidth, decoY);
            ctx.strokeStyle = charStyle.color || style.color;
            ctx.lineWidth = 1;
            ctx.stroke();
          }

          ctx.textAlign = 'left';
          ctx.fillText(runText, drawX + xOffset, y);
          xOffset += runWidth;
          charIdx = runEnd;
        }

        plainTextIndex += lineText.length + 1; // +1 for space/newline
      } else {
        // Simple rendering without rich content
        // Draw text decoration (underline or strikethrough)
        if (style.textDecoration === 'underline' || style.textDecoration === 'line-through') {
          const lineMetrics = ctx.measureText(lineText);
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

        ctx.fillText(lineText, textX, y);
      }

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

  // Check if point is on rotation handle (for freetext and image)
  const isOnRotationHandle = (x: number, y: number, annotation: Annotation): boolean => {
    if ((annotation.type !== 'freetext' && annotation.type !== 'image') || !('rect' in annotation)) return false;

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

    // Check for rotation handle on selected freetext or image annotation (skip if cropping)
    if (!isCropping && selectedAnnotation && (selectedAnnotation.type === 'freetext' || selectedAnnotation.type === 'image') && isOnRotationHandle(x, y, selectedAnnotation)) {
      // Store original state for undo BEFORE any modifications
      originalAnnotationRef.current = JSON.parse(JSON.stringify(selectedAnnotation));
      const center = getAnnotationCenter(selectedAnnotation);
      if (center) {
        setIsRotating(true);
        setRotationStart({ x, y });
        setRotationCenter(center);
        setInitialRotation((selectedAnnotation as FreeTextAnnotation | ImageAnnotation).rotation || 0);
      }
      return;
    }

    // Check for crop handle when in crop mode
    if (isCropping && selectedAnnotation?.type === 'image' && cropBounds) {
      const handle = getCropHandleAt(x, y, selectedAnnotation as ImageAnnotation, cropBounds);
      if (handle) {
        setCropHandle(handle);
        setCropStart({ x, y });
        setInitialCropBounds({ ...cropBounds });
        return;
      }
    }

    // Check for resize handle on selected annotation (works in any tool mode, skip if cropping)
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

    // Handle crop handle dragging
    if (cropHandle && cropStart && initialCropBounds && selectedAnnotation?.type === 'image') {
      const imgAnnotation = selectedAnnotation as ImageAnnotation;
      const topLeft = pdfToScreenCoords(imgAnnotation.rect[0], imgAnnotation.rect[1] + imgAnnotation.rect[3]);
      const bottomRight = pdfToScreenCoords(imgAnnotation.rect[0] + imgAnnotation.rect[2], imgAnnotation.rect[1]);

      const imgWidth = bottomRight.x - topLeft.x;
      const imgHeight = bottomRight.y - topLeft.y;

      // Calculate delta in percentage
      const deltaXPercent = ((x - cropStart.x) / imgWidth) * 100;
      const deltaYPercent = ((y - cropStart.y) / imgHeight) * 100;

      const newBounds = { ...initialCropBounds };

      switch (cropHandle) {
        case 'nw':
          newBounds.left = Math.max(0, Math.min(100 - newBounds.right - 10, initialCropBounds.left + deltaXPercent));
          newBounds.top = Math.max(0, Math.min(100 - newBounds.bottom - 10, initialCropBounds.top + deltaYPercent));
          break;
        case 'n':
          newBounds.top = Math.max(0, Math.min(100 - newBounds.bottom - 10, initialCropBounds.top + deltaYPercent));
          break;
        case 'ne':
          newBounds.right = Math.max(0, Math.min(100 - newBounds.left - 10, initialCropBounds.right - deltaXPercent));
          newBounds.top = Math.max(0, Math.min(100 - newBounds.bottom - 10, initialCropBounds.top + deltaYPercent));
          break;
        case 'e':
          newBounds.right = Math.max(0, Math.min(100 - newBounds.left - 10, initialCropBounds.right - deltaXPercent));
          break;
        case 'se':
          newBounds.right = Math.max(0, Math.min(100 - newBounds.left - 10, initialCropBounds.right - deltaXPercent));
          newBounds.bottom = Math.max(0, Math.min(100 - newBounds.top - 10, initialCropBounds.bottom - deltaYPercent));
          break;
        case 's':
          newBounds.bottom = Math.max(0, Math.min(100 - newBounds.top - 10, initialCropBounds.bottom - deltaYPercent));
          break;
        case 'sw':
          newBounds.left = Math.max(0, Math.min(100 - newBounds.right - 10, initialCropBounds.left + deltaXPercent));
          newBounds.bottom = Math.max(0, Math.min(100 - newBounds.top - 10, initialCropBounds.bottom - deltaYPercent));
          break;
        case 'w':
          newBounds.left = Math.max(0, Math.min(100 - newBounds.right - 10, initialCropBounds.left + deltaXPercent));
          break;
      }

      setCropBounds(newBounds);
      return;
    }

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

      // Check if Shift is held to disable snapping
      const enableSnapping = !e.shiftKey;

      if ('rect' in selectedAnnotation) {
        // Rect-based annotations (rectangle, ellipse, stamp, freetext, image)
        const currentRect = (selectedAnnotation as { rect: [number, number, number, number] }).rect;
        let newX = dragAnnotationStart[0] + deltaX;
        let newY = dragAnnotationStart[1] + deltaY;

        // Apply snapping if enabled
        if (enableSnapping) {
          const bounds = {
            left: newX,
            right: newX + currentRect[2],
            bottom: newY,
            top: newY + currentRect[3],
          };
          const targets = calculateSnapTargets(selectedAnnotation.id);
          const snapping = applySnapping(bounds, targets);
          newX += snapping.deltaX;
          newY += snapping.deltaY;

          // Convert guide positions from PDF coords to screen coords for rendering
          const screenGuides = {
            vertical: snapping.guides.vertical.map(pos => pos * scale),
            horizontal: snapping.guides.horizontal.map(pos => dimensions.height - pos * scale),
          };
          setSnapGuides(screenGuides);
        } else {
          setSnapGuides({ vertical: [], horizontal: [] });
        }

        updateAnnotation(selectedAnnotation.id, {
          rect: [newX, newY, currentRect[2], currentRect[3]]
        });
      } else if (selectedAnnotation.type === 'sticky-note') {
        // Sticky note - update position
        let newX = dragAnnotationStart[0] + deltaX;
        let newY = dragAnnotationStart[1] + deltaY;

        // Apply snapping if enabled
        if (enableSnapping) {
          const bounds = {
            left: newX - 12,
            right: newX + 12,
            bottom: newY - 12,
            top: newY + 12,
          };
          const targets = calculateSnapTargets(selectedAnnotation.id);
          const snapping = applySnapping(bounds, targets);
          newX += snapping.deltaX;
          newY += snapping.deltaY;

          const screenGuides = {
            vertical: snapping.guides.vertical.map(pos => pos * scale),
            horizontal: snapping.guides.horizontal.map(pos => dimensions.height - pos * scale),
          };
          setSnapGuides(screenGuides);
        } else {
          setSnapGuides({ vertical: [], horizontal: [] });
        }

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
        // Clear snap guides for lines (no snapping for now)
        setSnapGuides({ vertical: [], horizontal: [] });
      } else if (selectedAnnotation.type === 'ink') {
        // Ink - update all path points
        const originalAnnotation = originalAnnotationRef.current as { paths: number[][][] } | null;
        if (originalAnnotation) {
          const newPaths = originalAnnotation.paths.map(path =>
            path.map(point => [point[0] + deltaX, point[1] + deltaY])
          );
          updateAnnotation(selectedAnnotation.id, { paths: newPaths });
        }
        // Clear snap guides for ink (no snapping for now)
        setSnapGuides({ vertical: [], horizontal: [] });
      }
      return;
    }

    // Handle drawing
    if (!isDrawing || currentTool === 'select') return;
    setCurrentPath((prev) => [...prev, { x, y }]);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    // Finish crop handle dragging
    if (cropHandle) {
      setCropHandle(null);
      setCropStart(null);
      setInitialCropBounds(cropBounds);
      return;
    }

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
      // Clear snap guides
      setSnapGuides({ vertical: [], horizontal: [] });
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
            lastHtmlContentRef.current = ''; // Initialize empty
            // Initialize empty segments with default style
            setEditingSegments(textToSegments('', toolSettings.textStyle));
            selectAnnotation(annotation.id);
            if (!useTipTapEditor) {
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

  // Handle double-click to edit text box (works regardless of current tool)
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    for (const annotation of annotations) {
      if (annotation.type === 'freetext' && isPointInAnnotation(x, y, annotation)) {
        const ftAnnotation = annotation as FreeTextAnnotation;
        setEditingAnnotationId(annotation.id);

        // For TipTap, use HTML content if available, otherwise convert plain text
        if (useTipTapEditor) {
          let initialHtml = '';
          if (ftAnnotation.htmlContent) {
            // Use existing HTML content
            initialHtml = ftAnnotation.htmlContent;
          } else if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
            // Convert rich text segments to HTML
            const style = getAnnotationStyle(ftAnnotation);
            initialHtml = segmentsToTipTapHTML(ftAnnotation.richContent, style);
          } else if (ftAnnotation.content) {
            // Convert plain text to simple HTML paragraph
            initialHtml = `<p>${ftAnnotation.content.replace(/\n/g, '</p><p>')}</p>`;
          }
          setEditingContent(initialHtml);
          lastHtmlContentRef.current = initialHtml; // Initialize ref
        } else {
          setEditingContent(ftAnnotation.content || '');
        }

        // Initialize segments for rich text editing (legacy)
        if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
          setEditingSegments(ftAnnotation.richContent);
        } else {
          // Convert plain text to segments with the annotation's style
          const style = getAnnotationStyle(ftAnnotation);
          setEditingSegments(textToSegments(ftAnnotation.content || '', style));
        }

        selectAnnotation(annotation.id);
        // Focus is handled by RichTextEditor's autoFocus
        if (!useTipTapEditor) {
          setTimeout(() => textareaRef.current?.focus(), 0);
        }
        return;
      }
    }
  };

  // Finish editing text box
  const finishEditing = useCallback(() => {
    if (!editingAnnotationId) return;

    const annotation = annotations.find((a) => a.id === editingAnnotationId) as FreeTextAnnotation | undefined;
    if (annotation && annotation.type === 'freetext') {
      if (useTipTapEditor) {
        // Get content from TipTap editor or from ref as fallback
        const htmlContent = tiptapEditorRef.current?.getHTML() || lastHtmlContentRef.current;
        const plainContent = (tiptapEditorRef.current?.getText() || editingContent).trim();

        if (plainContent === '') {
          if (!annotation.content || annotation.content.trim() === '') {
            // Delete empty text box and record deletion for undo
            recordDelete(annotation);
            deleteAnnotation(editingAnnotationId);
          } else {
            const previousState = { ...annotation };
            updateAnnotation(editingAnnotationId, { content: '', htmlContent: '', richContent: [] } as Partial<FreeTextAnnotation>);
            recordUpdate({ ...annotation, content: '', htmlContent: '', richContent: [] } as FreeTextAnnotation, previousState);
          }
        } else {
          // Convert HTML to rich text segments for PDF rendering
          const style = getAnnotationStyle(annotation);
          const richContent = parseTipTapHTML(htmlContent, style);

          // Derive plain content from rich content segments to ensure character index alignment
          // This ensures the content matches the richContent character indices for rendering
          const derivedPlainContent = richContent.map(s => s.text).join('');

          const previousState = { ...annotation };
          updateAnnotation(editingAnnotationId, {
            content: derivedPlainContent,
            htmlContent: htmlContent,
            richContent: richContent,
          } as Partial<FreeTextAnnotation>);
          recordUpdate({ ...annotation, content: derivedPlainContent, htmlContent: htmlContent, richContent: richContent } as FreeTextAnnotation, previousState);
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
    lastHtmlContentRef.current = ''; // Clear HTML ref
    // Clear textbox store state
    useTextBoxStore.getState().stopEditing();
  }, [editingAnnotationId, annotations, useTipTapEditor, editingContent, recordDelete, deleteAnnotation, updateAnnotation, recordUpdate, setEditingSegments]);

  // Handle click for selection
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (editingAnnotationId) return;

    // Skip if we just finished dragging or resizing (selection was handled in mousedown)
    if (justFinishedInteraction.current) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Handle image placement when in image tool mode with pending images
    if (currentTool === 'image' && pendingImages && pendingImages.length > 0) {
      const pendingImage = pendingImages[0];
      const pdfCoords = screenToPdfCoords(x, y);

      // Calculate image dimensions - fit to max 200px in either dimension while preserving aspect ratio
      const maxDimension = 200;
      let imgWidth = pendingImage.originalWidth;
      let imgHeight = pendingImage.originalHeight;

      if (imgWidth > maxDimension || imgHeight > maxDimension) {
        const aspectRatio = imgWidth / imgHeight;
        if (aspectRatio > 1) {
          imgWidth = maxDimension;
          imgHeight = maxDimension / aspectRatio;
        } else {
          imgHeight = maxDimension;
          imgWidth = maxDimension * aspectRatio;
        }
      }

      // Create image annotation centered on click point
      const imageAnnotation = createImageAnnotation(
        pageNumber,
        [pdfCoords.x - imgWidth / 2, pdfCoords.y - imgHeight / 2, imgWidth, imgHeight],
        pendingImage.imageData,
        pendingImage.originalWidth,
        pendingImage.originalHeight,
        {
          originalFilename: pendingImage.filename,
          originalFileSize: pendingImage.fileSize,
          mimeType: pendingImage.mimeType,
        }
      );

      addAnnotation(imageAnnotation);
      recordAdd(imageAnnotation);
      selectAnnotation(imageAnnotation.id);

      // Notify that image has been placed
      onImagePlaced?.();
      return;
    }

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
      case 'freetext':
      case 'image': {
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

      // Escape to deselect annotation
      if (e.key === 'Escape' && selectedAnnotation) {
        e.preventDefault();
        selectAnnotation(null);
        return;
      }

      // Layer ordering shortcuts (Ctrl+] / Ctrl+[ and Ctrl+Shift+] / Ctrl+Shift+[)
      if (isCtrl && (e.key === ']' || e.key === '[') && selectedAnnotation && 'zIndex' in selectedAnnotation) {
        e.preventDefault();
        const previousState = { ...selectedAnnotation };
        const currentZIndex = (selectedAnnotation as { zIndex?: number }).zIndex || 0;

        if (isShift) {
          // Bring to front or send to back
          const allAnnotations = annotations.filter(a => 'zIndex' in a);
          const zIndices = allAnnotations.map(a => (a as { zIndex?: number }).zIndex || 0);
          if (e.key === ']') {
            // Bring to front
            const maxZ = Math.max(...zIndices, 0);
            if (currentZIndex < maxZ) {
              updateAnnotation(selectedAnnotation.id, { zIndex: maxZ + 1 });
              recordUpdate({ ...selectedAnnotation, zIndex: maxZ + 1 }, previousState);
            }
          } else {
            // Send to back
            const minZ = Math.min(...zIndices, 0);
            if (currentZIndex > minZ) {
              updateAnnotation(selectedAnnotation.id, { zIndex: minZ - 1 });
              recordUpdate({ ...selectedAnnotation, zIndex: minZ - 1 }, previousState);
            }
          }
        } else {
          // Bring forward or send backward one layer
          const newZIndex = e.key === ']' ? currentZIndex + 1 : currentZIndex - 1;
          updateAnnotation(selectedAnnotation.id, { zIndex: newZIndex });
          recordUpdate({ ...selectedAnnotation, zIndex: newZIndex }, previousState);
        }
        return;
      }

      // Arrow keys to nudge selected annotation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedAnnotation && !isCtrl) {
        e.preventDefault();
        const nudgeAmount = isShift ? 10 : 1; // 10px with Shift, 1px otherwise
        const previousState = { ...selectedAnnotation };

        if ('rect' in selectedAnnotation) {
          const rect = [...(selectedAnnotation as { rect: [number, number, number, number] }).rect] as [number, number, number, number];
          switch (e.key) {
            case 'ArrowUp':
              rect[1] += nudgeAmount; // PDF Y is inverted
              break;
            case 'ArrowDown':
              rect[1] -= nudgeAmount;
              break;
            case 'ArrowLeft':
              rect[0] -= nudgeAmount;
              break;
            case 'ArrowRight':
              rect[0] += nudgeAmount;
              break;
          }
          updateAnnotation(selectedAnnotation.id, { rect });
          recordUpdate({ ...selectedAnnotation, rect }, previousState);
        } else if (selectedAnnotation.type === 'sticky-note') {
          const pos = { ...(selectedAnnotation as { position: { x: number; y: number } }).position };
          switch (e.key) {
            case 'ArrowUp':
              pos.y += nudgeAmount;
              break;
            case 'ArrowDown':
              pos.y -= nudgeAmount;
              break;
            case 'ArrowLeft':
              pos.x -= nudgeAmount;
              break;
            case 'ArrowRight':
              pos.x += nudgeAmount;
              break;
          }
          updateAnnotation(selectedAnnotation.id, { position: pos });
          recordUpdate({ ...selectedAnnotation, position: pos }, previousState);
        } else if (selectedAnnotation.type === 'line' || selectedAnnotation.type === 'arrow') {
          const lineAnn = selectedAnnotation as { start: [number, number]; end: [number, number] };
          const start = [...lineAnn.start] as [number, number];
          const end = [...lineAnn.end] as [number, number];
          switch (e.key) {
            case 'ArrowUp':
              start[1] += nudgeAmount;
              end[1] += nudgeAmount;
              break;
            case 'ArrowDown':
              start[1] -= nudgeAmount;
              end[1] -= nudgeAmount;
              break;
            case 'ArrowLeft':
              start[0] -= nudgeAmount;
              end[0] -= nudgeAmount;
              break;
            case 'ArrowRight':
              start[0] += nudgeAmount;
              end[0] += nudgeAmount;
              break;
          }
          updateAnnotation(selectedAnnotation.id, { start, end });
          recordUpdate({ ...selectedAnnotation, start, end }, previousState);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedAnnotationId, deleteAnnotation, updateAnnotation, addAnnotation, editingAnnotationId, annotations, recordDelete, recordUpdate, selectAnnotation, recordAdd, pageNumber]);

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

  const editingRect = getEditingAnnotationRect();

  // Helper to process image file and create annotation
  const processImageFile = useCallback(async (file: File, dropX?: number, dropY?: number) => {
    // Supported image formats
    const supportedFormats = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];

    // Check if it's an image
    if (!file.type.startsWith('image/')) {
      alert(`"${file.name}" is not an image file.`);
      return;
    }

    // Check for supported format
    if (!supportedFormats.includes(file.type.toLowerCase())) {
      alert(`Unsupported image format: ${file.type}\n\nSupported formats: JPG, PNG, GIF, WebP, BMP, SVG`);
      return;
    }

    // Warn for large files (> 5MB)
    const fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > 5) {
      const proceed = confirm(
        `This image is large (${fileSizeMB.toFixed(1)} MB) and may affect performance.\n\n` +
        `Consider compressing the image before inserting.\n\n` +
        `Do you want to continue anyway?`
      );
      if (!proceed) return;
    }

    // Very large files (> 20MB) - block with error
    if (fileSizeMB > 20) {
      alert(
        `Image file is too large (${fileSizeMB.toFixed(1)} MB).\n\n` +
        `Maximum supported size is 20 MB. Please compress the image and try again.`
      );
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => {
        alert(`Failed to read file "${file.name}". The file may be corrupted.`);
        reject(new Error('File read error'));
      };

      reader.onload = (e) => {
        const imageData = e.target?.result as string;
        if (!imageData) {
          alert(`Failed to read file "${file.name}". The file may be corrupted.`);
          reject(new Error('Empty file data'));
          return;
        }

        const img = new Image();

        img.onerror = () => {
          alert(
            `Failed to load image "${file.name}".\n\n` +
            `The file may be corrupted or in an unsupported format.`
          );
          reject(new Error('Image load error'));
        };

        img.onload = () => {
          // Validate image dimensions
          if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            alert(`Invalid image dimensions for "${file.name}".`);
            reject(new Error('Invalid image dimensions'));
            return;
          }

          // Warn for very high resolution images
          const megapixels = (img.naturalWidth * img.naturalHeight) / 1000000;
          if (megapixels > 25) {
            console.warn(`High resolution image: ${img.naturalWidth}x${img.naturalHeight} (${megapixels.toFixed(1)} MP)`);
          }

          // Calculate placement position
          let pdfX: number, pdfY: number;
          if (dropX !== undefined && dropY !== undefined) {
            const pdfCoords = screenToPdfCoords(dropX, dropY);
            pdfX = pdfCoords.x;
            pdfY = pdfCoords.y;
          } else {
            // Center of visible area
            pdfX = dimensions.width / scale / 2;
            pdfY = dimensions.height / scale / 2;
          }

          // Calculate image dimensions - fit to max 200px (or page size for very small pages)
          const pageWidth = dimensions.width / scale;
          const pageHeight = dimensions.height / scale;
          const maxDimension = Math.min(200, pageWidth * 0.8, pageHeight * 0.8);
          const minDimension = 20; // Minimum size

          let imgWidth = img.naturalWidth;
          let imgHeight = img.naturalHeight;

          // Scale down large images
          if (imgWidth > maxDimension || imgHeight > maxDimension) {
            const aspectRatio = imgWidth / imgHeight;
            if (aspectRatio > 1) {
              imgWidth = maxDimension;
              imgHeight = maxDimension / aspectRatio;
            } else {
              imgHeight = maxDimension;
              imgWidth = maxDimension * aspectRatio;
            }
          }

          // Enforce minimum size for very small images
          if (imgWidth < minDimension || imgHeight < minDimension) {
            const aspectRatio = imgWidth / imgHeight;
            if (aspectRatio > 1) {
              imgHeight = minDimension;
              imgWidth = minDimension * aspectRatio;
            } else {
              imgWidth = minDimension;
              imgHeight = minDimension / aspectRatio;
            }
          }

          // Constrain position to keep image on page
          const halfWidth = imgWidth / 2;
          const halfHeight = imgHeight / 2;
          pdfX = Math.max(halfWidth, Math.min(pageWidth - halfWidth, pdfX));
          pdfY = Math.max(halfHeight, Math.min(pageHeight - halfHeight, pdfY));

          // Create and add image annotation
          const imageAnnotation = createImageAnnotation(
            pageNumber,
            [pdfX - halfWidth, pdfY - halfHeight, imgWidth, imgHeight],
            imageData,
            img.naturalWidth,
            img.naturalHeight,
            {
              originalFilename: file.name,
              originalFileSize: file.size,
              mimeType: file.type,
            }
          );

          addAnnotation(imageAnnotation);
          recordAdd(imageAnnotation);
          selectAnnotation(imageAnnotation.id);
          resolve();
        };

        img.src = imageData;
      };

      reader.readAsDataURL(file);
    });
  }, [pageNumber, dimensions, scale, addAnnotation, recordAdd, selectAnnotation, screenToPdfCoords]);

  // Handle drag enter
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  // Handle drag leave
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  // Handle drag over
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // Handle drop
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    dragCounterRef.current = 0;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const dropX = e.clientX - rect.left;
    const dropY = e.clientY - rect.top;

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter(f => f.type.startsWith('image/'));

    // Process each image file
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      // Offset each subsequent image
      const offsetX = dropX + i * 20;
      const offsetY = dropY + i * 20;
      await processImageFile(file, offsetX, offsetY);
    }
  }, [processImageFile]);

  // Handle clipboard paste for images
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      // Skip if editing text
      if (editingAnnotationId) return;

      // Skip if in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      // Check for image data in clipboard
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            // Place at center of visible area
            await processImageFile(file);
          }
          return;
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [editingAnnotationId, processImageFile]);

  // Cancel crop mode
  const cancelCropMode = useCallback(() => {
    setIsCropping(false);
    setCropBounds(null);
    setCropHandle(null);
    setCropStart(null);
    setInitialCropBounds(null);
    exitCropMode();
  }, [exitCropMode]);

  // Apply crop
  const applyCrop = useCallback(() => {
    if (!selectedAnnotation || selectedAnnotation.type !== 'image' || !cropBounds) return;

    const previousState = { ...selectedAnnotation };
    updateAnnotation(selectedAnnotation.id, { cropBounds });
    recordUpdate({ ...selectedAnnotation, cropBounds }, previousState);

    cancelCropMode();
  }, [selectedAnnotation, cropBounds, updateAnnotation, recordUpdate, cancelCropMode]);

  // Get crop handle at position
  const getCropHandleAt = useCallback((x: number, y: number, annotation: ImageAnnotation, bounds: { top: number; right: number; bottom: number; left: number }): typeof cropHandle => {
    const { rect } = annotation;
    const topLeft = pdfToScreenCoords(rect[0], rect[1] + rect[3]);
    const bottomRight = pdfToScreenCoords(rect[0] + rect[2], rect[1]);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    // Calculate crop area in screen coords
    const cropLeft = topLeft.x + (bounds.left / 100) * width;
    const cropRight = topLeft.x + width - (bounds.right / 100) * width;
    const cropTop = topLeft.y + (bounds.top / 100) * height;
    const cropBottom = topLeft.y + height - (bounds.bottom / 100) * height;

    const handleSize = 12;
    const cropWidth = cropRight - cropLeft;
    const cropHeight = cropBottom - cropTop;

    const handles: { x: number; y: number; cursor: typeof cropHandle }[] = [
      { x: cropLeft, y: cropTop, cursor: 'nw' },
      { x: cropLeft + cropWidth / 2, y: cropTop, cursor: 'n' },
      { x: cropRight, y: cropTop, cursor: 'ne' },
      { x: cropRight, y: cropTop + cropHeight / 2, cursor: 'e' },
      { x: cropRight, y: cropBottom, cursor: 'se' },
      { x: cropLeft + cropWidth / 2, y: cropBottom, cursor: 's' },
      { x: cropLeft, y: cropBottom, cursor: 'sw' },
      { x: cropLeft, y: cropTop + cropHeight / 2, cursor: 'w' },
    ];

    for (const handle of handles) {
      if (Math.abs(x - handle.x) <= handleSize / 2 && Math.abs(y - handle.y) <= handleSize / 2) {
        return handle.cursor;
      }
    }

    return null;
  }, [pdfToScreenCoords]);

  // Handle crop keyboard shortcuts
  useEffect(() => {
    if (!isCropping) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCrop();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelCropMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isCropping, applyCrop, cancelCropMode]);

  // Determine cursor based on position
  const getCursor = () => {
    if (isDragging) return 'move';
    if (isRotating) return 'grabbing';
    if (isResizing || cropHandle) {
      const cursors: Record<string, string> = {
        nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
        e: 'e-resize', se: 'se-resize', s: 's-resize',
        sw: 'sw-resize', w: 'w-resize'
      };
      return cursors[resizeHandle || cropHandle || ''] || 'default';
    }
    if (isCropping) return 'crosshair';
    if (currentTool === 'pan') return 'grab';
    if (currentTool !== 'select') return 'crosshair';
    return 'default';
  };

  return (
    <div
      ref={containerRef}
      className={`drawing-annotation-layer ${currentTool !== 'select' && currentTool !== 'pan' ? 'drawing-mode' : ''} ${currentTool === 'pan' ? 'pan-mode' : ''} ${isDragOver ? 'drag-over' : ''}`}
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
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if right-clicking on an annotation
        for (const annotation of annotations) {
          if (isPointInAnnotation(x, y, annotation)) {
            selectAnnotation(annotation.id);
            if (annotation.type === 'freetext') {
              setImageContextMenu(null);
              setContextMenu({
                annotation: annotation as FreeTextAnnotation,
                position: { x: e.clientX, y: e.clientY },
              });
            } else if (annotation.type === 'image') {
              setContextMenu(null);
              setImageContextMenu({
                annotation: annotation as ImageAnnotation,
                position: { x: e.clientX, y: e.clientY },
              });
            }
            return;
          }
        }
        setContextMenu(null);
        setImageContextMenu(null);
      }}
    >
      <canvas ref={canvasRef} className="annotation-canvas" />

      {/* Snap guide lines */}
      {(snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) && (
        <svg
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: dimensions.width,
            height: dimensions.height,
            pointerEvents: 'none',
            zIndex: 50,
          }}
        >
          {/* Vertical guides (X positions) */}
          {snapGuides.vertical.map((x, i) => (
            <line
              key={`v-${i}`}
              x1={x}
              y1={0}
              x2={x}
              y2={dimensions.height}
              stroke="#ff6b00"
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          ))}
          {/* Horizontal guides (Y positions) */}
          {snapGuides.horizontal.map((y, i) => (
            <line
              key={`h-${i}`}
              x1={0}
              y1={y}
              x2={dimensions.width}
              y2={y}
              stroke="#ff6b00"
              strokeWidth={1}
              strokeDasharray="4,4"
            />
          ))}
        </svg>
      )}

      {/* Drop zone overlay for drag-and-drop images */}
      {isDragOver && (
        <div className="image-drop-zone">
          <div className="drop-zone-content">
            <span className="drop-icon">🖼️</span>
            <span className="drop-text">Drop image here</span>
          </div>
        </div>
      )}

      {/* Crop mode overlay */}
      {isCropping && selectedAnnotation?.type === 'image' && cropBounds && (() => {
        const imgAnnotation = selectedAnnotation as ImageAnnotation;
        const topLeft = pdfToScreenCoords(imgAnnotation.rect[0], imgAnnotation.rect[1] + imgAnnotation.rect[3]);
        const bottomRight = pdfToScreenCoords(imgAnnotation.rect[0] + imgAnnotation.rect[2], imgAnnotation.rect[1]);
        const imgWidth = bottomRight.x - topLeft.x;
        const imgHeight = bottomRight.y - topLeft.y;

        // Calculate crop area in screen coords
        const cropLeft = topLeft.x + (cropBounds.left / 100) * imgWidth;
        const cropRight = topLeft.x + imgWidth - (cropBounds.right / 100) * imgWidth;
        const cropTop = topLeft.y + (cropBounds.top / 100) * imgHeight;
        const cropBottom = topLeft.y + imgHeight - (cropBounds.bottom / 100) * imgHeight;
        const cropWidth = cropRight - cropLeft;
        const cropHeight = cropBottom - cropTop;

        return (
          <>
            {/* Dimmed overlay outside crop area */}
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: dimensions.width,
                height: dimensions.height,
                pointerEvents: 'none',
                zIndex: 100,
              }}
            >
              <defs>
                <mask id="crop-mask">
                  <rect x="0" y="0" width="100%" height="100%" fill="white" />
                  <rect x={cropLeft} y={cropTop} width={cropWidth} height={cropHeight} fill="black" />
                </mask>
              </defs>
              <rect
                x={topLeft.x}
                y={topLeft.y}
                width={imgWidth}
                height={imgHeight}
                fill="rgba(0, 0, 0, 0.5)"
                mask="url(#crop-mask)"
              />
              {/* Crop area border */}
              <rect
                x={cropLeft}
                y={cropTop}
                width={cropWidth}
                height={cropHeight}
                fill="none"
                stroke="#0066ff"
                strokeWidth="2"
                strokeDasharray="5,5"
              />
            </svg>

            {/* Crop handles */}
            {[
              { x: cropLeft, y: cropTop, cursor: 'nw-resize' },
              { x: cropLeft + cropWidth / 2, y: cropTop, cursor: 'n-resize' },
              { x: cropRight, y: cropTop, cursor: 'ne-resize' },
              { x: cropRight, y: cropTop + cropHeight / 2, cursor: 'e-resize' },
              { x: cropRight, y: cropBottom, cursor: 'se-resize' },
              { x: cropLeft + cropWidth / 2, y: cropBottom, cursor: 's-resize' },
              { x: cropLeft, y: cropBottom, cursor: 'sw-resize' },
              { x: cropLeft, y: cropTop + cropHeight / 2, cursor: 'w-resize' },
            ].map((handle, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: handle.x - 6,
                  top: handle.y - 6,
                  width: 12,
                  height: 12,
                  backgroundColor: 'white',
                  border: '2px solid #0066ff',
                  borderRadius: '2px',
                  cursor: handle.cursor,
                  zIndex: 101,
                  pointerEvents: 'auto',
                }}
              />
            ))}

            {/* Crop controls */}
            <div
              style={{
                position: 'absolute',
                left: cropLeft + cropWidth / 2 - 70,
                top: cropBottom + 10,
                display: 'flex',
                gap: '8px',
                zIndex: 102,
                pointerEvents: 'auto',
              }}
            >
              <button
                onClick={applyCrop}
                style={{
                  padding: '6px 16px',
                  backgroundColor: '#0066ff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                Apply
              </button>
              <button
                onClick={cancelCropMode}
                style={{
                  padding: '6px 16px',
                  backgroundColor: '#555',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                Cancel
              </button>
            </div>
          </>
        );
      })()}

      {/* TipTap text editing */}
      {editingAnnotationId && editingRect && useTipTapEditor && (
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
          <TipTapEditor
            ref={tiptapEditorRef}
            initialContent={editingContent}
            defaultStyle={editingRect.style}
            width={editingRect.width - 4}
            height={editingRect.height - 4}
            padding={8}
            onContentChange={(html, text) => {
              setEditingContent(text);
              // Store HTML content in ref for reliable access during finishEditing
              lastHtmlContentRef.current = html;
            }}
            onBlur={finishEditing}
            autoFocus={true}
          />
        </div>
      )}

      {/* Legacy text editing textarea (fallback) */}
      {editingAnnotationId && editingRect && !useTipTapEditor && (
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

            // For TipTap, use HTML content if available
            if (useTipTapEditor) {
              let initialHtml = '';
              if (ftAnnotation.htmlContent) {
                initialHtml = ftAnnotation.htmlContent;
              } else if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
                const style = getAnnotationStyle(ftAnnotation);
                initialHtml = segmentsToTipTapHTML(ftAnnotation.richContent, style);
              } else if (ftAnnotation.content) {
                initialHtml = `<p>${ftAnnotation.content.replace(/\n/g, '</p><p>')}</p>`;
              }
              setEditingContent(initialHtml);
              lastHtmlContentRef.current = initialHtml; // Initialize ref
            } else {
              setEditingContent(ftAnnotation.content || '');
            }

            // Initialize segments for rich text editing (legacy)
            if (ftAnnotation.richContent && ftAnnotation.richContent.length > 0) {
              setEditingSegments(ftAnnotation.richContent);
            } else {
              const style = getAnnotationStyle(ftAnnotation);
              setEditingSegments(textToSegments(ftAnnotation.content || '', style));
            }

            setContextMenu(null);
            if (!useTipTapEditor) {
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

      {/* Context menu for images */}
      {imageContextMenu && (
        <ImageContextMenu
          annotation={imageContextMenu.annotation}
          position={imageContextMenu.position}
          onClose={() => setImageContextMenu(null)}
          onShowProperties={() => setShowImagePropertiesPanel(true)}
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

      {/* Image Properties Panel */}
      {showImagePropertiesPanel && selectedAnnotation?.type === 'image' && (
        <ImagePropertiesPanel
          annotation={selectedAnnotation as ImageAnnotation}
          onClose={() => setShowImagePropertiesPanel(false)}
        />
      )}
    </div>
  );
}
