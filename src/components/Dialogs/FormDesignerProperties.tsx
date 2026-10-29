import { useState } from 'react';
import type { FormDesignDocument, FormDesignField, FormDesignFieldPatch, FormDesignValue, FormDesignWidget, NewFormDesignWidget } from '../../forms/FormDesignerTypes';

function replaceOption(value: FormDesignValue | undefined, before: string, after?: string) {
  if (Array.isArray(value)) return value.flatMap(item => item !== before ? [item] : after === undefined ? [] : [after]);
  return value === before ? after ?? '' : value;
}

interface Props {
  field: FormDesignField;
  widget: FormDesignWidget;
  pages: FormDesignDocument['pages'];
  disabled: boolean;
  onFieldChange: (patch: FormDesignFieldPatch) => void;
  onWidgetChange: (patch: Partial<NewFormDesignWidget>) => void;
  onSelectWidget: (id: string) => void;
  onAddWidget: () => void;
  onDeleteWidget: () => void;
  onDeleteField: () => void;
}

function NumericProperty({ label, value, min = 0, max = 100000, onChange, allowEmpty = false }: {
  label: string; value: number | null; min?: number; max?: number; allowEmpty?: boolean; onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState({ source: value, text: value === null ? '' : String(value) });
  if (draft.source !== value) setDraft({ source: value, text: value === null ? '' : String(value) });
  const reset = () => setDraft({ source: value, text: value === null ? '' : String(value) });
  const commit = () => {
    if (!draft.text.trim()) { if (allowEmpty) onChange(null); else reset(); return; }
    const number = Number(draft.text);
    if (!Number.isFinite(number)) { reset(); return; }
    const bounded = Math.min(max, Math.max(min, number));
    setDraft({ source: value, text: String(bounded) }); onChange(bounded);
  };
  return <label>{label}<input type="number" step="any" min={min} max={max} value={draft.text} onChange={event => setDraft({ source: value, text: event.target.value })}
    onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); reset(); } }} /></label>;
}

function FieldValue({ field, value, label, onChange }: { field: FormDesignField; value: FormDesignValue; label: string; onChange: (value: FormDesignValue) => void }) {
  if (field.type === 'checkbox') return <label className="form-designer-check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />{label}: checked</label>;
  if (field.type === 'dropdown' && field.allowCustomValue && field.multiSelect) {
    return <><label>{label}<textarea rows={3} value={Array.isArray(value) ? value.join('\n') : String(value)}
      onChange={event => onChange(event.target.value.split(/\r?\n/))}
      onBlur={event => onChange(event.target.value.split(/\r?\n/).filter(item => item !== ''))} /></label>
      <p className="form-designer-hint">Enter one value per line. Commas remain part of a value; empty lines are ignored.</p></>;
  }
  const choices = field.type === 'radio' ? field.widgets.map(widget => ({ label: widget.optionValue ?? '', value: widget.optionValue ?? '' })) : field.options;
  if (choices && !(field.type === 'dropdown' && field.allowCustomValue)) {
    const multiple = !!field.multiSelect && field.type !== 'radio';
    return <label>{label}<select multiple={multiple} value={multiple ? Array.isArray(value) ? value : value ? [String(value)] : [] : Array.isArray(value) ? value[0] ?? '' : String(value)}
      onChange={event => onChange(multiple ? [...event.target.selectedOptions].map(option => option.value) : event.target.value)}>
      {!multiple && <option value="">None</option>}{choices.map((option, index) => <option key={index} value={option.value}>{option.label || option.value}</option>)}
    </select></label>;
  }
  return <label>{label}{field.multiline ? <textarea value={String(value)} rows={3} onChange={event => onChange(event.target.value)} /> : <input value={Array.isArray(value) ? value.join(', ') : String(value)} onChange={event => onChange(event.target.value)} />}</label>;
}

export function FormDesignerProperties({ field, widget, pages, disabled, onFieldChange, onWidgetChange, onSelectWidget, onAddWidget, onDeleteWidget, onDeleteField }: Props) {
  const page = pages.find(item => item.pageNumber === widget.pageNumber);
  if (!page) return <p role="status" className="form-designer-warning">{field.unsupportedReason || 'This widget has no valid page and cannot be changed.'}</p>;
  const editable = !disabled && field.supported;
  const choice = field.type === 'dropdown' || field.type === 'listbox';
  return <div className="form-designer-properties">
    {!field.supported && <p role="status" className="form-designer-warning">{field.unsupportedReason || 'This field type can be inspected but is not supported for design changes.'}</p>}
    {field.widgets.length > 1 && <label>Widget<select value={widget.id} onChange={event => onSelectWidget(event.target.value)} disabled={disabled}>
      {field.widgets.map((item, index) => <option key={item.id} value={item.id}>Widget {index + 1} · Page {item.pageNumber}{item.optionValue ? ` · ${item.optionValue}` : ''}</option>)}
    </select></label>}
    <fieldset disabled={!editable}>
      <legend>Field properties</legend>
      <label>Field name<input value={field.name} onChange={event => onFieldChange({ name: event.target.value })} /></label>
      <p className="form-designer-hint">Type: {field.type}. These properties apply to all {field.widgets.length} {field.widgets.length === 1 ? 'widget' : 'widgets'} of this field.</p>
      <div className="form-designer-checks"><label className="form-designer-check"><input type="checkbox" checked={field.required} onChange={event => onFieldChange({ required: event.target.checked })} />Required</label>
        <label className="form-designer-check"><input type="checkbox" checked={field.readOnly} onChange={event => onFieldChange({ readOnly: event.target.checked })} />Read only</label></div>
      {field.type === 'text' && <>
        <label className="form-designer-check"><input type="checkbox" checked={!!field.multiline} onChange={event => onFieldChange({ multiline: event.target.checked })} />Multiline</label>
        <NumericProperty label="Maximum length (blank for unlimited)" value={field.maxLength ?? null} min={1} max={1000000} allowEmpty onChange={value => onFieldChange({ maxLength: value === null ? null : Math.floor(value) })} />
      </>}
      {choice && <>
        <label className="form-designer-check"><input type="checkbox" checked={!!field.multiSelect} onChange={event => onFieldChange({ multiSelect: event.target.checked, value: event.target.checked ? Array.isArray(field.value) ? field.value : field.value ? [String(field.value)] : [] : Array.isArray(field.value) ? field.value[0] ?? '' : field.value, defaultValue: event.target.checked ? Array.isArray(field.defaultValue) ? field.defaultValue : field.defaultValue ? [String(field.defaultValue)] : [] : Array.isArray(field.defaultValue) ? field.defaultValue[0] ?? '' : field.defaultValue ?? '' })} />Allow multiple selections</label>
        {field.type === 'dropdown' && <label className="form-designer-check"><input type="checkbox" checked={!!field.allowCustomValue} onChange={event => onFieldChange({ allowCustomValue: event.target.checked })} />Allow a custom value</label>}
        <h4>Options</h4>
        {(field.options ?? []).map((option, index) => <div key={index} className="form-designer-option">
          <label>Label {index + 1}<input value={option.label} onChange={event => onFieldChange({ options: field.options!.map((item, offset) => offset === index ? { ...item, label: event.target.value } : item) })} /></label>
          <label>Value {index + 1}<input value={option.value} onChange={event => onFieldChange({ options: field.options!.map((item, offset) => offset === index ? { ...item, value: event.target.value } : item), value: replaceOption(field.value, option.value, event.target.value), defaultValue: replaceOption(field.defaultValue, option.value, event.target.value) })} /></label>
          <button type="button" aria-label={`Remove option ${index + 1}`} onClick={() => onFieldChange({ options: field.options!.filter((_, offset) => offset !== index), value: replaceOption(field.value, option.value), defaultValue: replaceOption(field.defaultValue, option.value) })}>×</button>
        </div>)}
        <button type="button" onClick={() => { let number = (field.options?.length ?? 0) + 1; while (field.options?.some(option => option.value === `option${number}`)) number++; onFieldChange({ options: [...field.options ?? [], { label: `Option ${number}`, value: `option${number}` }] }); }}>Add option</button>
      </>}
      <FieldValue field={field} label="Current value" value={field.value} onChange={value => onFieldChange({ value })} />
      <FieldValue field={field} label="Default value" value={field.defaultValue ?? (field.type === 'checkbox' ? false : field.type === 'listbox' && field.multiSelect ? [] : '')} onChange={defaultValue => onFieldChange({ defaultValue })} />
      {(field.type === 'text' || choice) && <div className="form-designer-property-grid">
        <NumericProperty label="Font size" value={field.fontSize ?? 12} min={1} max={144} onChange={value => onFieldChange({ fontSize: value! })} />
        {field.type === 'text' && <label>Text alignment<select value={field.textAlign ?? 'left'} onChange={event => onFieldChange({ textAlign: event.target.value as 'left' | 'center' | 'right' })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>}
      </div>}
    </fieldset>
    <fieldset disabled={!editable}>
      <legend>Selected widget</legend>
      <label>Widget page<select value={widget.pageNumber} onChange={event => onWidgetChange({ pageNumber: Number(event.target.value) })}>{pages.map(item => <option key={item.pageNumber} value={item.pageNumber}>Page {item.pageNumber}</option>)}</select></label>
      <div className="form-designer-property-grid">
        {(['x', 'y', 'width', 'height'] as const).map(key => <NumericProperty key={`${widget.id}-${key}`} label={{ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]} value={widget.rect[key]} min={key === 'width' || key === 'height' ? 4 : 0} max={key === 'x' ? page.width - widget.rect.width : key === 'y' ? page.height - widget.rect.height : key === 'width' ? page.width - widget.rect.x : page.height - widget.rect.y} onChange={value => onWidgetChange({ rect: { ...widget.rect, [key]: value! } })} />)}
      </div>
      <p className="form-designer-hint">Positions and sizes are in PDF points, measured from the unrotated visible page's top-left corner.</p>
      <label className="form-designer-check"><input type="checkbox" checked={widget.hidden} onChange={event => onWidgetChange({ hidden: event.target.checked })} />Hidden widget</label>
      {field.type === 'radio' && <label>Radio option value<input value={widget.optionValue ?? ''} onChange={event => onWidgetChange({ optionValue: event.target.value })} /></label>}
      <button type="button" onClick={onAddWidget}>{field.type === 'radio' ? 'Add radio choice' : 'Add another widget'}</button>
      <div className="form-designer-delete-actions">{field.widgets.length > 1 && <button type="button" onClick={onDeleteWidget}>Delete selected widget</button>}<button type="button" className="form-designer-danger" onClick={onDeleteField}>Delete field</button></div>
    </fieldset>
  </div>;
}
