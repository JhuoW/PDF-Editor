/**
 * ImageEditLayer - Allows users to select and edit images in the PDF
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useEditingStore } from '../../store/editingStore';
import { detectImages } from '../../editing/ImageDetector';
import type { PDFImage } from '../../editing/types';
import './ImageEditLayer.css';

interface ImageEditLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
}

export function ImageEditLayer({
  page,
  pageNumber,
  scale,
  rotation,
}: ImageEditLayerProps) {
  const {
    mode,
    images,
    setImages,
    selectedImageId,
    selectImage,
    addImageEdit,
  } = useEditingStore();

  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageImages = images.get(pageNumber) || [];

  // Load images when entering image mode
  useEffect(() => {
    if (mode !== 'image') return;
    if (images.has(pageNumber)) return;

    setIsLoading(true);
    detectImages(page)
      .then((detected) => {
        setImages(pageNumber, detected);
      })
      .catch((err) => {
        console.error('Failed to detect images:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [mode, page, pageNumber, images, setImages]);

  // Transform image rect based on rotation
  const transformRect = useCallback(
    (img: PDFImage) => {
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const pageWidth = viewport.width;
      const pageHeight = viewport.height;

      let { x, y, width, height } = img.rect;

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

  const handleImageClick = useCallback(
    (img: PDFImage, e: React.MouseEvent) => {
      e.stopPropagation();
      selectImage(img.id);
    },
    [selectImage]
  );

  const handleReplaceClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      fileInputRef.current?.click();
    },
    []
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !selectedImageId) return;

      const selectedImage = pageImages.find((img) => img.id === selectedImageId);
      if (!selectedImage) return;

      try {
        const arrayBuffer = await file.arrayBuffer();
        addImageEdit({
          imageId: selectedImageId,
          type: 'replace',
          newImageData: arrayBuffer,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('Failed to read image file:', err);
      }

      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [selectedImageId, pageImages, addImageEdit]
  );

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!selectedImageId) return;

      addImageEdit({
        imageId: selectedImageId,
        type: 'delete',
        timestamp: Date.now(),
      });
      selectImage(null);
    },
    [selectedImageId, addImageEdit, selectImage]
  );

  const handleLayerClick = useCallback(() => {
    selectImage(null);
  }, [selectImage]);

  // Don't render if not in image mode
  if (mode !== 'image') return null;

  return (
    <div className="image-edit-layer" onClick={handleLayerClick}>
      {isLoading && (
        <div className="image-edit-loading">
          <span>Detecting images...</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {pageImages.map((img) => {
        const style = transformRect(img);
        const isSelected = selectedImageId === img.id;

        return (
          <div
            key={img.id}
            className={`image-box ${isSelected ? 'selected' : ''}`}
            style={style}
            onClick={(e) => handleImageClick(img, e)}
          >
            <span className="image-label">IMAGE</span>
            {isSelected && (
              <div className="image-controls">
                <button
                  className="image-btn replace"
                  onClick={handleReplaceClick}
                  title="Replace image"
                >
                  Replace
                </button>
                <button
                  className="image-btn delete"
                  onClick={handleDeleteClick}
                  title="Delete image"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
