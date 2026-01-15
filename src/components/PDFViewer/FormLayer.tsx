/**
 * FormLayer - Renders interactive form fields on top of PDF pages
 */

import { useCallback, useMemo } from 'react';
import { useFormStore } from '../../store/formStore';
import type { FormField } from '../../forms/types';
import './FormLayer.css';

interface FormLayerProps {
  pageNumber: number;
  scale: number;
  rotation: number;
  pageWidth: number;
  pageHeight: number;
}

export function FormLayer({
  pageNumber,
  scale,
  rotation,
  pageWidth,
  pageHeight,
}: FormLayerProps) {
  const { fields, setFieldValue, activeFieldId, setActiveField } = useFormStore();

  // Get fields for this page
  const pageFields = useMemo(
    () => fields.filter(f => f.pageNumber === pageNumber && !f.hidden),
    [fields, pageNumber]
  );

  // Transform field position based on rotation
  const transformPosition = useCallback(
    (field: FormField) => {
      let { x, y, width, height } = field.rect;

      // Apply rotation transformation
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
    [rotation, scale, pageWidth, pageHeight]
  );

  const handleTextChange = useCallback(
    (field: FormField, value: string) => {
      setFieldValue(field.id, value);
    },
    [setFieldValue]
  );

  const handleCheckboxChange = useCallback(
    (field: FormField, checked: boolean) => {
      setFieldValue(field.id, checked);
    },
    [setFieldValue]
  );

  const handleSelectChange = useCallback(
    (field: FormField, value: string) => {
      setFieldValue(field.id, value);
    },
    [setFieldValue]
  );

  const handleRadioChange = useCallback(
    (field: FormField) => {
      // For radio buttons, set the value to the export value and update all in group
      const radioValue = field.exportValue || field.options?.[0]?.value || 'Yes';

      // Update all fields in the same radio group
      fields
        .filter(f => f.radioGroup === field.radioGroup)
        .forEach(f => {
          if (f.id === field.id) {
            setFieldValue(f.id, radioValue);
          } else {
            setFieldValue(f.id, '');
          }
        });
    },
    [fields, setFieldValue]
  );

  const handleFocus = useCallback(
    (fieldId: string) => {
      setActiveField(fieldId);
    },
    [setActiveField]
  );

  const handleBlur = useCallback(() => {
    setActiveField(null);
  }, [setActiveField]);

  const renderField = (field: FormField) => {
    const position = transformPosition(field);
    const isActive = activeFieldId === field.id;
    const baseClass = `form-field form-field-${field.type}${isActive ? ' active' : ''}${field.required ? ' required' : ''}`;

    const style: React.CSSProperties = {
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height,
      fontSize: Math.max(10, (field.fontSize || 12) * scale * 0.75),
    };

    switch (field.type) {
      case 'text':
        return field.multiline ? (
          <textarea
            key={field.id}
            className={baseClass}
            style={style}
            value={String(field.value || '')}
            onChange={(e) => handleTextChange(field, e.target.value)}
            onFocus={() => handleFocus(field.id)}
            onBlur={handleBlur}
            readOnly={field.readOnly}
            maxLength={field.maxLength}
            placeholder={field.required ? 'Required' : ''}
          />
        ) : (
          <input
            key={field.id}
            type="text"
            className={baseClass}
            style={style}
            value={String(field.value || '')}
            onChange={(e) => handleTextChange(field, e.target.value)}
            onFocus={() => handleFocus(field.id)}
            onBlur={handleBlur}
            readOnly={field.readOnly}
            maxLength={field.maxLength}
            placeholder={field.required ? 'Required' : ''}
          />
        );

      case 'checkbox':
        return (
          <label
            key={field.id}
            className={baseClass}
            style={style}
          >
            <input
              type="checkbox"
              checked={Boolean(field.value)}
              onChange={(e) => handleCheckboxChange(field, e.target.checked)}
              onFocus={() => handleFocus(field.id)}
              onBlur={handleBlur}
              disabled={field.readOnly}
            />
            <span className="checkbox-visual" />
          </label>
        );

      case 'radio':
        return (
          <label
            key={field.id}
            className={baseClass}
            style={style}
          >
            <input
              type="radio"
              name={field.radioGroup}
              checked={Boolean(field.value)}
              onChange={() => handleRadioChange(field)}
              onFocus={() => handleFocus(field.id)}
              onBlur={handleBlur}
              disabled={field.readOnly}
            />
            <span className="radio-visual" />
          </label>
        );

      case 'dropdown':
        return (
          <select
            key={field.id}
            className={baseClass}
            style={style}
            value={String(field.value || '')}
            onChange={(e) => handleSelectChange(field, e.target.value)}
            onFocus={() => handleFocus(field.id)}
            onBlur={handleBlur}
            disabled={field.readOnly}
          >
            <option value="">-- Select --</option>
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );

      case 'listbox':
        return (
          <select
            key={field.id}
            className={baseClass}
            style={style}
            multiple
            value={Array.isArray(field.value) ? field.value : [String(field.value || '')]}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions, opt => opt.value);
              setFieldValue(field.id, selected);
            }}
            onFocus={() => handleFocus(field.id)}
            onBlur={handleBlur}
            disabled={field.readOnly}
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );

      case 'signature':
        return (
          <div
            key={field.id}
            className={`${baseClass} signature-placeholder`}
            style={style}
            onClick={() => !field.readOnly && handleFocus(field.id)}
          >
            {field.value ? (
              <span className="signature-signed">Signed</span>
            ) : (
              <span className="signature-empty">Click to sign</span>
            )}
          </div>
        );

      case 'button':
        return (
          <button
            key={field.id}
            className={baseClass}
            style={style}
            disabled={field.readOnly}
          >
            {field.name || 'Button'}
          </button>
        );

      default:
        return null;
    }
  };

  if (pageFields.length === 0) {
    return null;
  }

  return (
    <div className="form-layer">
      {pageFields.map(renderField)}
    </div>
  );
}
