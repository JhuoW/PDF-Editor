import { useLocale, t } from "../../i18n";
import { useCallback, useState, useId } from 'react';
import type { FreeTextAnnotation, BoxStyle } from '../../annotations/types';
import { DEFAULT_BOX_STYLE } from '../../annotations/types';
import { useAnnotationStore } from '../../store/annotationStore';
import { useAnnotationHistoryStore } from '../../store/annotationHistoryStore';
import { Link, Unlink } from 'lucide-react';
import { PropertyNumberInput, PropertyColorInput } from '../Workspace/PropertyInput';
import './BoxPropertiesPanel.css';

interface BoxPropertiesPanelProps {
  annotation: FreeTextAnnotation;
  onClose?: () => void;
}

// Color presets
const COLOR_PRESETS = [
  'transparent', '#FFFFFF', '#F5F5F5', '#E0E0E0',
  '#FFE0E0', '#FFF0D0', '#E0FFE0', '#E0F0FF',
  '#F0E0FF', '#FFE0F0', '#000000', '#333333',
];

const BORDER_STYLES: BoxStyle['borderStyle'][] = ['solid', 'dashed', 'dotted', 'none'];

export function BoxPropertiesPanel({ annotation, onClose }: BoxPropertiesPanelProps) {
  useLocale();
  const id = useId();
  const { updateAnnotation } = useAnnotationStore();
  const { recordUpdate } = useAnnotationHistoryStore();

  const boxStyle: BoxStyle = annotation.boxStyle || DEFAULT_BOX_STYLE;
  const [linkPadding, setLinkPadding] = useState(true);
  const [lockAspectRatio, setLockAspectRatio] = useState(false);

  // Update box style with undo support
  const handleBoxStyleChange = useCallback(
    (updates: Partial<BoxStyle>) => {
      const previousState = { ...annotation };
      const newBoxStyle = { ...boxStyle, ...updates };
      updateAnnotation(annotation.id, { boxStyle: newBoxStyle });
      recordUpdate({ ...annotation, boxStyle: newBoxStyle }, previousState);
    },
    [annotation, boxStyle, updateAnnotation, recordUpdate]
  );

  // Update rect with undo support
  const handleRectChange = useCallback(
    (newRect: [number, number, number, number]) => {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { rect: newRect });
      recordUpdate({ ...annotation, rect: newRect }, previousState);
    },
    [annotation, updateAnnotation, recordUpdate]
  );

  // Update rotation with undo support
  const handleRotationChange = useCallback(
    (rotation: number) => {
      const previousState = { ...annotation };
      updateAnnotation(annotation.id, { rotation });
      recordUpdate({ ...annotation, rotation }, previousState);
    },
    [annotation, updateAnnotation, recordUpdate]
  );

  // Handle dimension change with aspect ratio lock
  const handleDimensionChange = useCallback(
    (dimension: 'width' | 'height', value: number) => {
      const [x, y, width, height] = annotation.rect;

      if (lockAspectRatio && width > 0 && height > 0) {
        const aspectRatio = width / height;
        if (dimension === 'width') {
          const newHeight = value / aspectRatio;
          handleRectChange([x, y, value, newHeight]);
        } else {
          const newWidth = value * aspectRatio;
          handleRectChange([x, y, newWidth, value]);
        }
      } else {
        if (dimension === 'width') {
          handleRectChange([x, y, value, height]);
        } else {
          handleRectChange([x, y, width, value]);
        }
      }
    },
    [annotation.rect, lockAspectRatio, handleRectChange]
  );

  // Handle padding change with link option
  const handlePaddingChange = useCallback(
    (side: 'top' | 'right' | 'bottom' | 'left', value: number) => {
      const padding = boxStyle.padding || { top: 8, right: 8, bottom: 8, left: 8 };

      if (linkPadding) {
        // Apply same value to all sides
        handleBoxStyleChange({
          padding: { top: value, right: value, bottom: value, left: value },
        });
      } else {
        handleBoxStyleChange({
          padding: { ...padding, [side]: value },
        });
      }
    },
    [boxStyle.padding, linkPadding, handleBoxStyleChange]
  );

  const [x, y, width, height] = annotation.rect;
  const rotation = annotation.rotation || 0;

  return (
    <div className="box-properties-panel">
      <div className="panel-header">
        <h3>{t("m.box.properties.77bf66")}</h3>
        {onClose && (
          <button className="close-btn" onClick={onClose} title={t("m.close.bbfa77")} aria-label={t("m.close.bbfa77")}>
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* Position */}
        <div className="property-section">
          <div className="section-title">{t("m.position.cf1c85")}</div>
          <div className="position-grid">
            <div className="position-field">
              <label htmlFor={`${id}-x`}>{t("m.x.c032ad")}</label>
              <PropertyNumberInput id={`${id}-x`} aria-label={t("m.x.c032ad")}
                value={x}
                step={1}
                onCommit={value => handleRectChange([value, y, width, height])}
              />
              <span className="unit">{t("m.pt.bc8112")}</span>
            </div>
            <div className="position-field">
              <label htmlFor={`${id}-y`}>{t("m.y.23eb4d")}</label>
              <PropertyNumberInput id={`${id}-y`} aria-label={t("m.y.23eb4d")}
                value={y}
                step={1}
                onCommit={value => handleRectChange([x, value, width, height])}
              />
              <span className="unit">{t("m.pt.bc8112")}</span>
            </div>
          </div>
        </div>

        {/* Size */}
        <div className="property-section">
          <div className="section-title">{t("m.size.b71523")}</div>
          <div className="size-grid">
            <div className="size-field">
              <label htmlFor={`${id}-width`}>{t("m.w.e2415c")}</label>
              <PropertyNumberInput id={`${id}-width`} aria-label={t("m.w.e2415c")}
                value={width}
                min={20}
                step={1}
                onCommit={value => handleDimensionChange('width', value)}
              />
              <span className="unit">{t("m.pt.bc8112")}</span>
            </div>
            <div className="size-field">
              <label htmlFor={`${id}-height`}>{t("m.h.7cf184")}</label>
              <PropertyNumberInput id={`${id}-height`} aria-label={t("m.h.7cf184")}
                value={height}
                min={20}
                step={1}
                onCommit={value => handleDimensionChange('height', value)}
              />
              <span className="unit">{t("m.pt.bc8112")}</span>
            </div>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={lockAspectRatio}
              onChange={(e) => setLockAspectRatio(e.target.checked)}
            />
            {t("m.lock.aspect.ratio.370bda")}</label>
        </div>

        {/* Rotation */}
        <div className="property-section">
          <div className="section-title">{t("m.rotation.906fe5")}</div>
          <div className="rotation-field">
            <PropertyNumberInput id={`${id}-rotation`} aria-label={t("m.rotation.906fe5")}
              value={rotation}
              min={0}
              max={360}
              step={1}
              onCommit={value => handleRotationChange(((value % 360) + 360) % 360)}
            />
            <span className="unit">°</span>
            <div className="rotation-presets">
              <button aria-pressed={rotation === 0} onClick={() => handleRotationChange(0)} title="0°">0</button>
              <button aria-pressed={rotation === 90} onClick={() => handleRotationChange(90)} title="90°">90</button>
              <button aria-pressed={rotation === 180} onClick={() => handleRotationChange(180)} title="180°">180</button>
              <button aria-pressed={rotation === 270} onClick={() => handleRotationChange(270)} title="270°">270</button>
            </div>
          </div>
        </div>

        {/* Background */}
        <div className="property-section">
          <div className="section-title">{t("m.background.64dd60")}</div>
          <div className="color-row">
            <label htmlFor={`${id}-background-color`}>{t("m.color.1d0c83")}</label>
            <div className="color-input-group">
              {boxStyle.backgroundColor !== 'transparent' ? (
                <input
                  type="color" aria-label={t("properties.backgroundColor")}
                  value={boxStyle.backgroundColor}
                  onChange={(e) => handleBoxStyleChange({ backgroundColor: e.target.value })}
                  className="color-input"
                />
              ) : (
                <div className="transparent-indicator" title={t("m.transparent.0491f7")} />
              )}
              <PropertyColorInput id={`${id}-background-color`} allowTransparent aria-label={t("properties.backgroundColor")}
                value={boxStyle.backgroundColor}
                onCommit={backgroundColor => handleBoxStyleChange({ backgroundColor })}
                className="color-text"
              />
            </div>
          </div>
          <div className="color-presets">
            {COLOR_PRESETS.map((color) => (
              <button
                key={color}
                className={`color-preset ${color === boxStyle.backgroundColor ? 'active' : ''} ${color === 'transparent' ? 'transparent' : ''}`}
                style={{ backgroundColor: color === 'transparent' ? 'white' : color }}
                onClick={() => handleBoxStyleChange({ backgroundColor: color })}
                title={color === 'transparent' ? t('m.transparent.0491f7') : color}
                aria-pressed={color === boxStyle.backgroundColor}
              />
            ))}
          </div>
          <div className="opacity-row">
            <label htmlFor={`${id}-background-opacity`}>{t("m.opacity.f0fa69")}</label>
            <input
              id={`${id}-background-opacity`} type="range" aria-label={t("m.opacity.f0fa69")}
              min={0}
              max={1}
              step={0.01}
              value={boxStyle.backgroundOpacity ?? 1}
              onChange={(e) =>
                handleBoxStyleChange({ backgroundOpacity: parseFloat(e.target.value) })
              }
              className="opacity-slider"
            />
            <span className="opacity-value">{Math.round((boxStyle.backgroundOpacity ?? 1) * 100)}%</span>
          </div>
        </div>

        {/* Border */}
        <div className="property-section">
          <div className="section-title">{t("m.border.5d10d3")}</div>
          <div className="border-row">
            <label htmlFor={`${id}-border-color`}>{t("m.color.1d0c83")}</label>
            <div className="color-input-group">
              <input
                id={`${id}-border-color`} type="color" aria-label={t("properties.borderColor")}
                value={boxStyle.borderColor || '#000000'}
                onChange={(e) => handleBoxStyleChange({ borderColor: e.target.value })}
                className="color-input"
              />
              <PropertyColorInput aria-label={t("properties.borderColor")}
                value={boxStyle.borderColor || '#000000'}
                onCommit={borderColor => handleBoxStyleChange({ borderColor })}
                className="color-text"
              />
            </div>
          </div>
          <div className="border-grid">
            <div className="border-field">
              <label htmlFor={`${id}-border-width`}>{t("m.width.a58ddf")}</label>
              <PropertyNumberInput id={`${id}-border-width`} aria-label={t("m.width.a58ddf")}
                value={boxStyle.borderWidth ?? 1}
                min={0}
                max={20}
                step={0.5}
                onCommit={borderWidth => handleBoxStyleChange({ borderWidth })}
              />
              <span className="unit">{t("m.pt.bc8112")}</span>
            </div>
            <div className="border-field">
              <label htmlFor={`${id}-border-style`}>{t("m.style.99a0ef")}</label>
              <select id={`${id}-border-style`} aria-label={t("m.style.99a0ef")}
                value={boxStyle.borderStyle || 'solid'}
                onChange={(e) =>
                  handleBoxStyleChange({ borderStyle: e.target.value as BoxStyle['borderStyle'] })
                }
              >
                {BORDER_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {t({ solid: 'm.solid.d00635', dashed: 'm.dashed.7b0a09', dotted: 'm.dotted.149492', none: 'properties.noBorder' }[style])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="border-radius-row">
            <label htmlFor={`${id}-border-radius`}>{t("m.radius.e5aaea")}</label>
            <PropertyNumberInput id={`${id}-border-radius`} aria-label={t("m.radius.e5aaea")}
              value={boxStyle.borderRadius ?? 0}
              min={0}
              max={100}
              step={1}
                onCommit={borderRadius => handleBoxStyleChange({ borderRadius })}
              />
            <span className="unit">{t("m.pt.bc8112")}</span>
          </div>
        </div>

        {/* Padding */}
        <div className="property-section">
          <div className="section-title">
            {t("m.padding.9c47ca")}<button
              aria-pressed={linkPadding}
              className={`link-btn ${linkPadding ? 'active' : ''}`}
              onClick={() => setLinkPadding(!linkPadding)}
              title={linkPadding ? t("m.unlink.sides.eb2450") : t("m.link.all.sides.4548de")}
            >
              <>{linkPadding ? <Link size={16} aria-hidden="true" /> : <Unlink size={16} aria-hidden="true" />}</>
            </button>
          </div>
          <div className="padding-grid">
            <div className="padding-field top">
              <label htmlFor={`${id}-padding-top`}>{t("m.t.c2c53d")}</label>
              <PropertyNumberInput id={`${id}-padding-top`} aria-label={t("m.t.c2c53d")}
                value={boxStyle.padding?.top ?? 8}
                min={0}
                max={100}
                step={1}
                onCommit={value => handlePaddingChange('top', value)}
              />
            </div>
            <div className="padding-field right">
              <label htmlFor={`${id}-padding-right`}>{t("m.r.065765")}</label>
              <PropertyNumberInput id={`${id}-padding-right`} aria-label={t("m.r.065765")}
                value={boxStyle.padding?.right ?? 8}
                min={0}
                max={100}
                step={1}
                onCommit={value => handlePaddingChange('right', value)}
              />
            </div>
            <div className="padding-field bottom">
              <label htmlFor={`${id}-padding-bottom`}>{t("m.b.ae4f28")}</label>
              <PropertyNumberInput id={`${id}-padding-bottom`} aria-label={t("m.b.ae4f28")}
                value={boxStyle.padding?.bottom ?? 8}
                min={0}
                max={100}
                step={1}
                onCommit={value => handlePaddingChange('bottom', value)}
              />
            </div>
            <div className="padding-field left">
              <label htmlFor={`${id}-padding-left`}>{t("m.l.d160e0")}</label>
              <PropertyNumberInput id={`${id}-padding-left`} aria-label={t("m.l.d160e0")}
                value={boxStyle.padding?.left ?? 8}
                min={0}
                max={100}
                step={1}
                onCommit={value => handlePaddingChange('left', value)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
