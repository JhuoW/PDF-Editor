import { useState, useCallback } from 'react';
import { mergePDFs, downloadPDF, insertPagesFromPDF } from '../../core/PDFManipulator';
import './MergeDialog.css';

type InsertPosition = 'start' | 'end' | 'before' | 'after';

interface MergeDialogProps {
  onClose: () => void;
  onMergeComplete?: (data: Uint8Array) => void;
  currentDocument?: {
    data: ArrayBuffer;
    fileName: string;
    totalPages: number;
  } | null;
}

interface FileItem {
  id: string;
  file: File;
  name: string;
}

export function MergeDialog({ onClose, onMergeComplete, currentDocument }: MergeDialogProps) {
  // Start with empty files - users add all files manually
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputName, setOutputName] = useState('merged.pdf');

  // Insert position options (only used when current document exists)
  const [insertPosition, setInsertPosition] = useState<InsertPosition>('end');
  const [specificPage, setSpecificPage] = useState(1);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles) return;

    const newFiles: FileItem[] = [];
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      if (file.type === 'application/pdf') {
        newFiles.push({
          id: `${Date.now()}-${i}`,
          file,
          name: file.name,
        });
      }
    }

    setFiles(prev => [...prev, ...newFiles]);
    setError(null);
    event.target.value = '';
  }, []);

  const handleRemoveFile = useCallback((id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  const handleMoveUp = useCallback((index: number) => {
    if (index === 0) return;
    setFiles(prev => {
      const newFiles = [...prev];
      [newFiles[index - 1], newFiles[index]] = [newFiles[index], newFiles[index - 1]];
      return newFiles;
    });
  }, []);

  const handleMoveDown = useCallback((index: number) => {
    setFiles(prev => {
      if (index === prev.length - 1) return prev;
      const newFiles = [...prev];
      [newFiles[index], newFiles[index + 1]] = [newFiles[index + 1], newFiles[index]];
      return newFiles;
    });
  }, []);

  const handleMerge = useCallback(async () => {
    // Determine minimum files needed
    const minFiles = currentDocument ? 1 : 2;

    if (files.length < minFiles) {
      setError(currentDocument
        ? 'Please add at least 1 PDF file to insert'
        : 'Please add at least 2 PDF files to merge');
      return;
    }

    setIsMerging(true);
    setError(null);

    try {
      let result: Uint8Array;

      if (currentDocument && files.length >= 1) {
        // Insert files into current document at specified position
        // First merge all the files to insert
        let dataToInsert: ArrayBuffer;

        if (files.length === 1) {
          dataToInsert = await files[0].file.arrayBuffer();
        } else {
          // Merge all files first, then insert
          const buffers = await Promise.all(files.map(f => f.file.arrayBuffer()));
          const mergedToInsert = await mergePDFs(buffers);
          dataToInsert = mergedToInsert.buffer as ArrayBuffer;
        }

        // Calculate insert position (1-indexed, 0 means end)
        let position: number;
        switch (insertPosition) {
          case 'start':
            position = 1; // Insert before page 1
            break;
          case 'end':
            position = 0; // 0 means at end
            break;
          case 'before':
            position = Math.max(1, Math.min(specificPage, currentDocument.totalPages));
            break;
          case 'after':
            position = Math.max(1, Math.min(specificPage + 1, currentDocument.totalPages + 1));
            break;
          default:
            position = 0;
        }

        result = await insertPagesFromPDF(currentDocument.data, dataToInsert, position);
      } else {
        // Standard merge of all files
        const buffers = await Promise.all(files.map(f => f.file.arrayBuffer()));
        result = await mergePDFs(buffers);
      }

      if (onMergeComplete) {
        onMergeComplete(result);
      } else {
        await downloadPDF(result, outputName);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to merge PDFs');
    } finally {
      setIsMerging(false);
    }
  }, [files, outputName, onMergeComplete, onClose, currentDocument, insertPosition, specificPage]);

  const minFilesRequired = currentDocument ? 1 : 2;
  const canMerge = files.length >= minFilesRequired;

  return (
    <div className="merge-dialog-overlay" onClick={onClose}>
      <div className="merge-dialog" onClick={e => e.stopPropagation()}>
        <div className="merge-dialog-header">
          <h3>{currentDocument ? 'Insert PDF Pages' : 'Merge PDFs'}</h3>
          <button className="merge-dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="merge-dialog-content">
          <p className="merge-dialog-description">
            {currentDocument
              ? `Insert PDF pages into "${currentDocument.fileName}" (${currentDocument.totalPages} pages)`
              : 'Select PDF files to merge. Use arrows to reorder.'}
          </p>

          <div className="merge-file-input-wrapper">
            <input
              type="file"
              accept=".pdf"
              multiple
              onChange={handleFileSelect}
              id="merge-file-input"
            />
            <label htmlFor="merge-file-input" className="merge-file-input-label">
              + Add PDF Files
            </label>
          </div>

          {files.length > 0 && (
            <div className="merge-file-list">
              {files.map((item, index) => (
                <div key={item.id} className="merge-file-item">
                  <span className="merge-file-number">{index + 1}</span>
                  <span className="merge-file-name" title={item.name}>
                    {item.name}
                  </span>
                  <div className="merge-file-actions">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === files.length - 1}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      onClick={() => handleRemoveFile(item.id)}
                      className="merge-file-remove"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {files.length === 0 && (
            <div className="merge-empty-state">
              {currentDocument
                ? 'Add PDF files to insert into the current document'
                : 'Add PDF files to merge (at least 2 files required)'}
            </div>
          )}

          {/* Insert position options - only show when there's a current document */}
          {currentDocument && files.length > 0 && (
            <div className="merge-position-options">
              <label className="merge-position-label">Insert position:</label>
              <div className="merge-position-radios">
                <label className="merge-position-radio">
                  <input
                    type="radio"
                    name="insertPosition"
                    value="start"
                    checked={insertPosition === 'start'}
                    onChange={() => setInsertPosition('start')}
                  />
                  At start of document
                </label>
                <label className="merge-position-radio">
                  <input
                    type="radio"
                    name="insertPosition"
                    value="end"
                    checked={insertPosition === 'end'}
                    onChange={() => setInsertPosition('end')}
                  />
                  At end of document
                </label>
                <label className="merge-position-radio">
                  <input
                    type="radio"
                    name="insertPosition"
                    value="before"
                    checked={insertPosition === 'before'}
                    onChange={() => setInsertPosition('before')}
                  />
                  Before page
                  <input
                    type="number"
                    className="merge-page-input"
                    min={1}
                    max={currentDocument.totalPages}
                    value={insertPosition === 'before' ? specificPage : ''}
                    onChange={(e) => {
                      setInsertPosition('before');
                      setSpecificPage(Math.max(1, Math.min(parseInt(e.target.value) || 1, currentDocument.totalPages)));
                    }}
                    onClick={() => setInsertPosition('before')}
                  />
                  <span className="merge-page-total">/ {currentDocument.totalPages}</span>
                </label>
                <label className="merge-position-radio">
                  <input
                    type="radio"
                    name="insertPosition"
                    value="after"
                    checked={insertPosition === 'after'}
                    onChange={() => setInsertPosition('after')}
                  />
                  After page
                  <input
                    type="number"
                    className="merge-page-input"
                    min={1}
                    max={currentDocument.totalPages}
                    value={insertPosition === 'after' ? specificPage : ''}
                    onChange={(e) => {
                      setInsertPosition('after');
                      setSpecificPage(Math.max(1, Math.min(parseInt(e.target.value) || 1, currentDocument.totalPages)));
                    }}
                    onClick={() => setInsertPosition('after')}
                  />
                  <span className="merge-page-total">/ {currentDocument.totalPages}</span>
                </label>
              </div>
            </div>
          )}

          <div className="merge-output-name">
            <label htmlFor="output-name">Output filename:</label>
            <input
              type="text"
              id="output-name"
              value={outputName}
              onChange={e => setOutputName(e.target.value)}
              placeholder="merged.pdf"
            />
          </div>

          {error && <div className="merge-error">{error}</div>}
        </div>

        <div className="merge-dialog-actions">
          <button className="merge-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="merge-submit"
            onClick={handleMerge}
            disabled={isMerging || !canMerge}
          >
            {isMerging ? 'Processing...' : (currentDocument ? 'Insert & Download' : 'Merge & Download')}
          </button>
        </div>
      </div>
    </div>
  );
}
