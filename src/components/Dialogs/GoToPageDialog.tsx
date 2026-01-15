import { useState, useEffect, useRef } from 'react';
import './GoToPageDialog.css';

interface GoToPageDialogProps {
  currentPage: number;
  totalPages: number;
  onGoToPage: (page: number) => void;
  onClose: () => void;
}

export function GoToPageDialog({
  currentPage,
  totalPages,
  onGoToPage,
  onClose,
}: GoToPageDialogProps) {
  const [pageInput, setPageInput] = useState(currentPage.toString());
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Handle keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const validateAndGo = () => {
    const pageNum = parseInt(pageInput, 10);

    if (isNaN(pageNum)) {
      setError('Please enter a valid number');
      return;
    }

    if (pageNum < 1) {
      setError('Page must be at least 1');
      return;
    }

    if (pageNum > totalPages) {
      setError(`Page must be at most ${totalPages}`);
      return;
    }

    onGoToPage(pageNum);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    validateAndGo();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value);
    setError(null);
  };

  return (
    <div className="goto-page-overlay" onClick={onClose}>
      <div className="goto-page-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="goto-page-header">
          <h3>Go to Page</h3>
          <button className="goto-page-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="goto-page-content">
            <label htmlFor="page-input">
              Enter page number (1 - {totalPages}):
            </label>
            <input
              ref={inputRef}
              id="page-input"
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={handleInputChange}
              className={error ? 'error' : ''}
            />
            {error && <div className="goto-page-error">{error}</div>}
          </div>

          <div className="goto-page-actions">
            <button type="button" className="goto-page-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="goto-page-submit">
              Go
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
