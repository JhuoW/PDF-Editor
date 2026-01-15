import { useAnnotationStore } from '../../store/annotationStore';
import type { AnnotationTool } from '../../annotations/types';
import { PREDEFINED_STAMPS } from '../../annotations/types';
import './AnnotationToolbar.css';

interface AnnotationToolbarProps {
  hasDocument: boolean;
}

export function AnnotationToolbar({ hasDocument }: AnnotationToolbarProps) {
  const {
    currentTool,
    setCurrentTool,
    toolSettings,
    setToolSettings,
    customStamps,
    addCustomStamp,
  } = useAnnotationStore();

  const handleToolClick = (tool: AnnotationTool) => {
    setCurrentTool(currentTool === tool ? 'select' : tool);
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ color: e.target.value });
  };

  const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ opacity: parseFloat(e.target.value) });
  };

  const handleStrokeWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setToolSettings({ strokeWidth: parseInt(e.target.value, 10) });
  };

  const handleAddCustomStamp = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const imageData = reader.result as string;
        const name = file.name.replace(/\.[^/.]+$/, ''); // Remove extension
        addCustomStamp(name, imageData);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  if (!hasDocument) return null;

  return (
    <div className="annotation-toolbar">
      <div className="annotation-toolbar-section">
        <span className="section-label">Select</span>
        <button
          className={`tool-button ${currentTool === 'select' ? 'active' : ''}`}
          onClick={() => handleToolClick('select')}
          title="Select (V)"
        >
          <span className="tool-icon">↖</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">Text Markup</span>
        <button
          className={`tool-button ${currentTool === 'highlight' ? 'active' : ''}`}
          onClick={() => handleToolClick('highlight')}
          title="Highlight (H)"
        >
          <span className="tool-icon highlight-icon">H</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'underline' ? 'active' : ''}`}
          onClick={() => handleToolClick('underline')}
          title="Underline (U)"
        >
          <span className="tool-icon underline-icon">U</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'strikeout' ? 'active' : ''}`}
          onClick={() => handleToolClick('strikeout')}
          title="Strikeout (S)"
        >
          <span className="tool-icon strikeout-icon">S</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">Drawing</span>
        <button
          className={`tool-button ${currentTool === 'ink' ? 'active' : ''}`}
          onClick={() => handleToolClick('ink')}
          title="Freehand Draw (D)"
        >
          <span className="tool-icon">✏</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'line' ? 'active' : ''}`}
          onClick={() => handleToolClick('line')}
          title="Line (L)"
        >
          <span className="tool-icon">╱</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'arrow' ? 'active' : ''}`}
          onClick={() => handleToolClick('arrow')}
          title="Arrow (A)"
        >
          <span className="tool-icon">→</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'rectangle' ? 'active' : ''}`}
          onClick={() => handleToolClick('rectangle')}
          title="Rectangle (R)"
        >
          <span className="tool-icon">▢</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'ellipse' ? 'active' : ''}`}
          onClick={() => handleToolClick('ellipse')}
          title="Ellipse (E)"
        >
          <span className="tool-icon">○</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">Notes</span>
        <button
          className={`tool-button ${currentTool === 'sticky-note' ? 'active' : ''}`}
          onClick={() => handleToolClick('sticky-note')}
          title="Sticky Note (N)"
        >
          <span className="tool-icon">📝</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'freetext' ? 'active' : ''}`}
          onClick={() => handleToolClick('freetext')}
          title="Text Box (T)"
        >
          <span className="tool-icon">T</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">Stamps</span>
        <div className="stamp-dropdown">
          <button
            className={`tool-button ${currentTool === 'stamp' ? 'active' : ''}`}
            onClick={() => handleToolClick('stamp')}
            title="Stamp"
          >
            <span className="tool-icon">🔖</span>
          </button>
          {currentTool === 'stamp' && (
            <div className="stamp-menu">
              <div className="stamp-section">
                <span className="stamp-section-title">Predefined</span>
                {PREDEFINED_STAMPS.map((stamp) => (
                  <button
                    key={stamp}
                    className="stamp-option"
                    onClick={() => {
                      // Store the selected stamp for use when clicking on page
                      setToolSettings({ ...toolSettings });
                       
                      (window as unknown as Record<string, unknown>).__selectedStamp = { type: 'predefined', name: stamp };
                    }}
                  >
                    {stamp}
                  </button>
                ))}
              </div>
              {customStamps.length > 0 && (
                <div className="stamp-section">
                  <span className="stamp-section-title">Custom</span>
                  {customStamps.map((stamp) => (
                    <button
                      key={stamp.name}
                      className="stamp-option"
                      onClick={() => {
                         
                        (window as unknown as Record<string, unknown>).__selectedStamp = {
                          type: 'custom',
                          name: stamp.name,
                          imageData: stamp.imageData,
                        };
                      }}
                    >
                      {stamp.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="stamp-section">
                <button className="stamp-add-custom" onClick={handleAddCustomStamp}>
                  + Add Custom Stamp
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="toolbar-divider" />

      {/* Tool Settings */}
      {currentTool !== 'select' && (
        <div className="annotation-toolbar-section tool-settings">
          <label className="setting-item">
            <span>Color</span>
            <input
              type="color"
              value={toolSettings.color}
              onChange={handleColorChange}
              className="color-input"
            />
          </label>

          {(currentTool === 'highlight' ||
            currentTool === 'rectangle' ||
            currentTool === 'ellipse') && (
            <label className="setting-item">
              <span>Opacity</span>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={toolSettings.opacity}
                onChange={handleOpacityChange}
                className="opacity-input"
              />
            </label>
          )}

          {(currentTool === 'ink' ||
            currentTool === 'line' ||
            currentTool === 'arrow' ||
            currentTool === 'rectangle' ||
            currentTool === 'ellipse') && (
            <label className="setting-item">
              <span>Width</span>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={toolSettings.strokeWidth}
                onChange={handleStrokeWidthChange}
                className="stroke-input"
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
