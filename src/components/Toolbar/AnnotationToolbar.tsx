import { useLocale, t } from "../../i18n";
import { useAnnotationStore } from '../../store/annotationStore';
import type { AnnotationTool } from '../../annotations/types';
import { PREDEFINED_STAMPS } from '../../annotations/types';
import './AnnotationToolbar.css';

interface AnnotationToolbarProps {
  hasDocument: boolean;
}

export function AnnotationToolbar({ hasDocument }: AnnotationToolbarProps) {
  useLocale();
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
        <span className="section-label">{t("m.navigation.cf03cf")}</span>
        <button
          className={`tool-button ${currentTool === 'select' ? 'active' : ''}`}
          onClick={() => handleToolClick('select')}
          title={t("m.select.859822")}
        >
          <svg className="tool-icon-svg select-cursor-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 4L10 22L13 13L22 10L4 4Z" fill="white" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          className={`tool-button ${currentTool === 'pan' ? 'active' : ''}`}
          onClick={() => handleToolClick('pan')}
          title={t("m.pan.8c9ce3")}
        >
          <svg className="tool-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 11V6C18 5.45 17.55 5 17 5C16.45 5 16 5.45 16 6V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M14 11V4C14 3.45 13.55 3 13 3C12.45 3 12 3.45 12 4V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M10 11V6C10 5.45 9.55 5 9 5C8.45 5 8 5.45 8 6V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M20 11V17C20 19.21 18.21 21 16 21H12C9.79 21 8 19.21 8 17V11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 11V9C6 8.45 5.55 8 5 8C4.45 8 4 8.45 4 9V15C4 18.31 6.69 21 10 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">{t("m.text.markup.3c1df0")}</span>
        <button
          className={`tool-button ${currentTool === 'highlight' ? 'active' : ''}`}
          onClick={() => handleToolClick('highlight')}
          title={t("m.highlight.e1da92")}
        >
          <span className="tool-icon highlight-icon">{t("m.h.7cf184")}</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'underline' ? 'active' : ''}`}
          onClick={() => handleToolClick('underline')}
          title={t("m.underline.39773a")}
        >
          <span className="tool-icon underline-icon">{t("m.u.b2c7c0")}</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'strikeout' ? 'active' : ''}`}
          onClick={() => handleToolClick('strikeout')}
          title={t("m.strikeout.c73b63")}
        >
          <span className="tool-icon strikeout-icon">{t("m.s.02aa62")}</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">{t("m.drawing.9de360")}</span>
        <button
          className={`tool-button ${currentTool === 'ink' ? 'active' : ''}`}
          onClick={() => handleToolClick('ink')}
          title={t("m.freehand.draw.691bc6")}
        >
          <span className="tool-icon">✏</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'line' ? 'active' : ''}`}
          onClick={() => handleToolClick('line')}
          title={t("m.line.ea9676")}
        >
          <span className="tool-icon">╱</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'arrow' ? 'active' : ''}`}
          onClick={() => handleToolClick('arrow')}
          title={t("m.arrow.3a4758")}
        >
          <span className="tool-icon">→</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'rectangle' ? 'active' : ''}`}
          onClick={() => handleToolClick('rectangle')}
          title={t("m.rectangle.c15869")}
        >
          <span className="tool-icon">▢</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'ellipse' ? 'active' : ''}`}
          onClick={() => handleToolClick('ellipse')}
          title={t("m.ellipse.8580e3")}
        >
          <span className="tool-icon">○</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">{t("m.notes.704400")}</span>
        <button
          className={`tool-button ${currentTool === 'sticky-note' ? 'active' : ''}`}
          onClick={() => handleToolClick('sticky-note')}
          title={t("m.sticky.note.2a94fc")}
        >
          <span className="tool-icon">📝</span>
        </button>
        <button
          className={`tool-button ${currentTool === 'freetext' ? 'active' : ''}`}
          onClick={() => handleToolClick('freetext')}
          title={t("m.text.box.f8b2aa")}
        >
          <span className="tool-icon">{t("m.t.c2c53d")}</span>
        </button>
      </div>

      <div className="toolbar-divider" />

      <div className="annotation-toolbar-section">
        <span className="section-label">{t("m.stamps.44ae4c")}</span>
        <div className="stamp-dropdown">
          <button
            className={`tool-button ${currentTool === 'stamp' ? 'active' : ''}`}
            onClick={() => handleToolClick('stamp')}
            title={t("m.stamp.973fc7")}
          >
            <span className="tool-icon">🔖</span>
          </button>
          {currentTool === 'stamp' && (
            <div className="stamp-menu">
              <div className="stamp-section">
                <span className="stamp-section-title">{t("m.predefined.bc3e74")}</span>
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
                  <span className="stamp-section-title">{t("m.custom.081ae3")}</span>
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
                  {t("m.add.custom.stamp.a0df20")}</button>
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
            <span>{t("m.color.1d0c83")}</span>
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
              <span>{t("m.opacity.f0fa69")}</span>
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
              <span>{t("m.width.a58ddf")}</span>
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
