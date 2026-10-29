/**
 * FormLayer - Renders interactive form fields on top of PDF pages
 */

import { useCallback, useMemo } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { useFormStore } from '../../store/formStore';
import type { FormField } from '../../forms/types';
import { getEffectiveRotation } from '../../core/PDFRenderer';
import { mapViewportRect } from '../../utils/viewportMapping';
import './FormLayer.css';

interface FormLayerProps {
  page: PDFPageProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
}

export function FormLayer({
  page,
  pageNumber,
  scale,
  rotation,
}: FormLayerProps) {
  const { fields, setFieldValueByName, activeFieldId, setActiveField } = useFormStore();

  // Get fields for this page
  const pageFields = useMemo(
    () => fields.filter(f => f.pageNumber === pageNumber && !f.hidden),
    [fields, pageNumber]
  );

  const sourceViewport = useMemo(() => page.getViewport({ scale: 1, rotation: 0 }), [page]);
  const effectiveRotation = getEffectiveRotation(page, rotation);
  const targetViewport = useMemo(() => page.getViewport({ scale, rotation: effectiveRotation }), [page, scale, effectiveRotation]);

  const transformPosition = useCallback(
    (field: FormField) => {
      const { x, y, width, height } = mapViewportRect(field.rect, sourceViewport, targetViewport);
      const fieldWidth = field.rect.width * scale;
      const fieldHeight = field.rect.height * scale;

      return {
        left: x + (width - fieldWidth) / 2,
        top: y + (height - fieldHeight) / 2,
        width: fieldWidth,
        height: fieldHeight,
        transform: `rotate(${effectiveRotation}deg)`,
      };
    },
    [sourceViewport, targetViewport, scale, effectiveRotation]
  );

  const handleTextChange = useCallback(
    (field: FormField, value: string) => {
      setFieldValueByName(field.name, value);
    },
    [setFieldValueByName]
  );

  const handleCheckboxChange = useCallback(
    (field: FormField, checked: boolean) => {
      setFieldValueByName(field.name, checked);
    },
    [setFieldValueByName]
  );

  const handleSelectChange = useCallback(
    (field: FormField, value: string | string[]) => {
      setFieldValueByName(field.name, value);
    },
    [setFieldValueByName]
  );

  const handleRadioChange = useCallback(
    (field: FormField) => {
      // Widgets share one field value; exportValue identifies this option.
      if (field.exportValue !== undefined) setFieldValueByName(field.name, field.exportValue);
    },
    [setFieldValueByName]
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
    const multiple = field.multiSelect ?? (field.type === 'listbox' || Array.isArray(field.value));
    const selectedValues = Array.isArray(field.value) ? field.value : field.value ? [String(field.value)] : [];
    const baseClass = `form-field form-field-${field.type}${isActive ? ' active' : ''}${field.required ? ' required' : ''}`;

    const style: React.CSSProperties = {
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height,
      transform: position.transform,
      fontSize: Math.max(10, (field.fontSize || 12) * scale),
      textAlign: field.textAlign,
    };

    switch (field.type) {
      case 'text':
        return field.multiline ? (
          <textarea
            key={field.id}
            aria-label={field.name}
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
            aria-label={field.name}
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
              aria-label={field.name}
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
              aria-label={`${field.name}: ${field.exportValue ?? ''}`}
              name={field.radioGroup}
              checked={field.exportValue !== undefined && field.value === field.exportValue}
              onChange={() => handleRadioChange(field)}
              onFocus={() => handleFocus(field.id)}
              onBlur={handleBlur}
              disabled={field.readOnly}
            />
            <span className="radio-visual" />
          </label>
        );

      case 'dropdown':
        if (field.allowCustomValue && !multiple) {
          const listId = `form-options-${encodeURIComponent(field.id)}`;
          return <span key={field.id}>
            <input type="text" list={listId} aria-label={field.name} className={baseClass} style={style}
              value={selectedValues[0] ?? ''} disabled={field.readOnly}
              onChange={event => handleSelectChange(field, event.target.value)}
              onFocus={() => handleFocus(field.id)} onBlur={handleBlur} />
            <datalist id={listId}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
          </span>;
        }
        return (
          <select
            key={field.id}
            aria-label={field.name}
            className={baseClass}
            style={style}
            multiple={multiple}
            value={multiple ? selectedValues : selectedValues[0] ?? ''}
            onChange={(e) => handleSelectChange(field, multiple
              ? Array.from(e.target.selectedOptions, option => option.value)
              : e.target.value)}
            onFocus={() => handleFocus(field.id)}
            onBlur={handleBlur}
            disabled={field.readOnly}
          >
            {!multiple && <option value="">-- Select --</option>}
            {field.allowCustomValue && multiple && selectedValues.filter(value => !field.options?.some(option => option.value === value))
              .map(value => <option key={value} value={value}>{value}</option>)}
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
            ref={element => {
              // React otherwise selects the first option for an unmatched
              // scalar value, although native PDF lists can have no selection.
              if (element && !multiple && selectedValues.length === 0) element.selectedIndex = -1;
            }}
            aria-label={field.name}
            className={baseClass}
            style={style}
            multiple={multiple}
            size={Math.max(2, Math.min(field.options?.length ?? 2, 8))}
            value={multiple ? selectedValues : selectedValues[0] ?? ''}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions, opt => opt.value);
              setFieldValueByName(field.name, selected);
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
