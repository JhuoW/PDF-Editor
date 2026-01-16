import { useEffect, useRef, useState, memo } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { getPageDimensions, getEffectiveRotation } from '../../core/PDFRenderer';
import { TextLayer } from './TextLayer';
import { AnnotationLayer } from './AnnotationLayer';
import { DrawingAnnotationLayer } from './DrawingAnnotationLayer';
import { TextSelectionHandler } from './TextSelectionHandler';
import { DestinationHighlight } from './DestinationHighlight';
import { FormLayer } from './FormLayer';
import { TextEditLayer } from './TextEditLayer';
import { ImageEditLayer } from './ImageEditLayer';
import { RedactionLayer } from './RedactionLayer';
import type { LinkDestination } from './PDFViewer';
import './PageCanvas.css';

interface PageCanvasProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  searchQuery?: string;
  activeMatchPage?: number;
  activeMatchIndex?: number;
  showTextLayer?: boolean;
  onLinkClick?: (dest: unknown) => void;
  highlightDestination?: LinkDestination;
}

export const PageCanvas = memo(function PageCanvas({
  page,
  pageNumber,
  scale,
  rotation,
  searchQuery,
  activeMatchPage,
  activeMatchIndex,
  showTextLayer = true,
  onLinkClick,
  highlightDestination,
}: PageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;

    // Use willReadFrequently for better Firefox compatibility
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // Cancel any previous render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    // Calculate effective rotation (page's embedded rotation + view rotation)
    const effectiveRotation = getEffectiveRotation(page, rotation);

    const dims = getPageDimensions(page, scale, rotation);
    setDimensions({ width: dims.width, height: dims.height });

    // Set canvas size
    canvas.width = dims.width;
    canvas.height = dims.height;

    setIsRendering(true);

    const viewport = page.getViewport({ scale, rotation: effectiveRotation });

    // For Firefox compatibility, explicitly pass canvas: null when using canvasContext
    // Per pdfjs-dist v5 docs: "if the context must absolutely be used, the canvas must be null"
    const renderContext = {
      canvas: null,
      canvasContext: ctx,
      viewport,
    };

    const renderTask = page.render(renderContext);
    renderTaskRef.current = renderTask;

    renderTask.promise
      .then(() => {
        setIsRendering(false);
        renderTaskRef.current = null;
      })
      .catch((err) => {
        if (err.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
        setIsRendering(false);
        renderTaskRef.current = null;
      });

    return () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [page, scale, rotation]);

  return (
    <div
      ref={containerRef}
      className="page-canvas-container"
      style={{ width: dimensions.width, height: dimensions.height }}
    >
      <canvas ref={canvasRef} className="page-canvas" />
      {showTextLayer && dimensions.width > 0 && (
        <TextLayer
          page={page}
          scale={scale}
          rotation={rotation}
          searchQuery={searchQuery}
          activeMatchPage={activeMatchPage}
          activeMatchIndex={activeMatchIndex}
        />
      )}
      {dimensions.width > 0 && (
        <AnnotationLayer
          page={page}
          scale={scale}
          rotation={rotation}
          onLinkClick={onLinkClick}
        />
      )}
      {dimensions.width > 0 && (
        <DrawingAnnotationLayer
          page={page}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
        />
      )}
      {dimensions.width > 0 && (
        <TextSelectionHandler
          page={page}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
          containerRef={containerRef}
        />
      )}
      {dimensions.width > 0 && (
        <FormLayer
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
          pageWidth={page.view[2] - page.view[0]}
          pageHeight={page.view[3] - page.view[1]}
        />
      )}
      {dimensions.width > 0 && (
        <TextEditLayer
          page={page}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
        />
      )}
      {dimensions.width > 0 && (
        <ImageEditLayer
          page={page}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
        />
      )}
      {dimensions.width > 0 && (
        <RedactionLayer
          page={page}
          pageNumber={pageNumber}
          scale={scale}
          rotation={rotation}
        />
      )}
      {highlightDestination && dimensions.width > 0 && (
        <DestinationHighlight
          page={page}
          scale={scale}
          rotation={rotation}
          top={highlightDestination.top}
          left={highlightDestination.left}
        />
      )}
      {isRendering && (
        <div className="page-loading-overlay">
          <div className="page-loading-spinner" />
        </div>
      )}
    </div>
  );
});
