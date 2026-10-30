import { translateError } from '../../i18n';
import { useLocale, translateMessage, t } from "../../i18n";
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
  useLocale();
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
  return <label>{translateMessage(label)}<input type="number" step="any" min={min} max={max} value={draft.text} onChange={event => setDraft({ source: value, text: event.target.value })}
    onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); reset(); } }} /></label>;
}

function FieldValue({ field, value, label, onChange }: { field: FormDesignField; value: FormDesignValue; label: string; onChange: (value: FormDesignValue) => void }) {
  useLocale();
  if (field.type === 'checkbox') return <label className="form-designer-check"><input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />{translateMessage(label)}{t("m.checked.499425")}</label>;
  if (field.type === 'dropdown' && field.allowCustomValue && field.multiSelect) {
    return <><label>{translateMessage(label)}<textarea rows={3} value={Array.isArray(value) ? value.join('\n') : String(value)}
      onChange={event => onChange(event.target.value.split(/\r?\n/))}
      onBlur={event => onChange(event.target.value.split(/\r?\n/).filter(item => item !== ''))} /></label>
      <p className="form-designer-hint">{t("m.enter.one.value.per.line.commas.remain.part.of.a.9f2516")}</p></>;
  }
  const choices = field.type === 'radio' ? field.widgets.map(widget => ({ label: widget.optionValue ?? '', value: widget.optionValue ?? '' })) : field.options;
  if (choices && !(field.type === 'dropdown' && field.allowCustomValue)) {
    const multiple = !!field.multiSelect && field.type !== 'radio';
    return <label>{translateMessage(label)}<select multiple={multiple} value={multiple ? Array.isArray(value) ? value : value ? [String(value)] : [] : Array.isArray(value) ? value[0] ?? '' : String(value)}
      onChange={event => onChange(multiple ? [...event.target.selectedOptions].map(option => option.value) : event.target.value)}>
      {!multiple && <option value="">{t("m.none.6eef66")}</option>}{choices.map((option, index) => <option key={index} value={option.value}>{option.label || option.value}</option>)}
    </select></label>;
  }
  return <label>{translateMessage(label)}{field.multiline ? <textarea value={String(value)} rows={3} onChange={event => onChange(event.target.value)} /> : <input value={Array.isArray(value) ? value.join(', ') : String(value)} onChange={event => onChange(event.target.value)} />}</label>;
}

export function FormDesignerProperties({ field, widget, pages, disabled, onFieldChange, onWidgetChange, onSelectWidget, onAddWidget, onDeleteWidget, onDeleteField }: Props) {
  useLocale();
  const page = pages.find(item => item.pageNumber === widget.pageNumber);
  if (!page) return <p role="status" className="form-designer-warning">{translateError(field.unsupportedReason) || t("m.this.widget.has.no.valid.page.and.cannot.be.chan.f0e0b1")}</p>;
  const editable = !disabled && field.supported;
  const choice = field.type === 'dropdown' || field.type === 'listbox';
  return <div className="form-designer-properties">
    {!field.supported && <p role="status" className="form-designer-warning">{translateError(field.unsupportedReason) || t("m.this.field.type.can.be.inspected.but.is.not.supp.3a91db")}</p>}
    {field.widgets.length > 1 && <label>{t("m.widget.df1530")}<select value={widget.id} onChange={event => onSelectWidget(event.target.value)} disabled={disabled}>
      {field.widgets.map((item, index) => <option key={item.id} value={item.id}>{t("m.widget.df1530")}{' '}{index + 1}{' '}{t("m.page.021c88")}{' '}{item.pageNumber}{item.optionValue ? ` · ${item.optionValue}` : ''}</option>)}
    </select></label>}
    <fieldset disabled={!editable}>
      <legend>{t("m.field.properties.31c688")}</legend>
      <label>{t("m.field.name.f08ab3")}<input value={field.name} onChange={event => onFieldChange({ name: event.target.value })} /></label>
      <p className="form-designer-hint">{t("m.type.ee3fb1")}{' '}{translateMessage(field.type)}{t("m.these.properties.apply.to.all.2ec7c6")}{' '}{field.widgets.length} {field.widgets.length === 1 ? t("m.widget.ff700e") : t("m.widgets.2d8ba8")}{' '}{t("m.of.this.field.610476")}</p>
      <div className="form-designer-checks"><label className="form-designer-check"><input type="checkbox" checked={field.required} onChange={event => onFieldChange({ required: event.target.checked })} />{t("m.required.eed6bf")}</label>
        <label className="form-designer-check"><input type="checkbox" checked={field.readOnly} onChange={event => onFieldChange({ readOnly: event.target.checked })} />{t("m.read.only.601dcc")}</label></div>
      {field.type === 'text' && <>
        <label className="form-designer-check"><input type="checkbox" checked={!!field.multiline} onChange={event => onFieldChange({ multiline: event.target.checked })} />{t("m.multiline.035b7b")}</label>
        <NumericProperty label={t("m.maximum.length.blank.for.unlimited.9e5d8c")} value={field.maxLength ?? null} min={1} max={1000000} allowEmpty onChange={value => onFieldChange({ maxLength: value === null ? null : Math.floor(value) })} />
      </>}
      {choice && <>
        <label className="form-designer-check"><input type="checkbox" checked={!!field.multiSelect} onChange={event => onFieldChange({ multiSelect: event.target.checked, value: event.target.checked ? Array.isArray(field.value) ? field.value : field.value ? [String(field.value)] : [] : Array.isArray(field.value) ? field.value[0] ?? '' : field.value, defaultValue: event.target.checked ? Array.isArray(field.defaultValue) ? field.defaultValue : field.defaultValue ? [String(field.defaultValue)] : [] : Array.isArray(field.defaultValue) ? field.defaultValue[0] ?? '' : field.defaultValue ?? '' })} />{t("m.allow.multiple.selections.fd4dee")}</label>
        {field.type === 'dropdown' && <label className="form-designer-check"><input type="checkbox" checked={!!field.allowCustomValue} onChange={event => onFieldChange({ allowCustomValue: event.target.checked })} />{t("m.allow.a.custom.value.7cfb59")}</label>}
        <h4>{t("m.options.6bf5da")}</h4>
        {(field.options ?? []).map((option, index) => <div key={index} className="form-designer-option">
          <label>{t("m.label.74341e")}{' '}{index + 1}<input value={option.label} onChange={event => onFieldChange({ options: field.options!.map((item, offset) => offset === index ? { ...item, label: event.target.value } : item) })} /></label>
          <label>{t("m.value.8dce17")}{' '}{index + 1}<input value={option.value} onChange={event => onFieldChange({ options: field.options!.map((item, offset) => offset === index ? { ...item, value: event.target.value } : item), value: replaceOption(field.value, option.value, event.target.value), defaultValue: replaceOption(field.defaultValue, option.value, event.target.value) })} /></label>
          <button type="button" aria-label={t("m.remove.option.9f121e", { v0: index + 1 })} onClick={() => onFieldChange({ options: field.options!.filter((_, offset) => offset !== index), value: replaceOption(field.value, option.value), defaultValue: replaceOption(field.defaultValue, option.value) })}>×</button>
        </div>)}
        <button type="button" onClick={() => { let number = (field.options?.length ?? 0) + 1; while (field.options?.some(option => option.value === `option${number}`)) number++; onFieldChange({ options: [...field.options ?? [], { label: `Option ${number}`, value: `option${number}` }] }); }}>{t("m.add.option.a20144")}</button>
      </>}
      <FieldValue field={field} label={t("m.current.value.ed2757")} value={field.value} onChange={value => onFieldChange({ value })} />
      <FieldValue field={field} label={t("m.default.value.bdffe6")} value={field.defaultValue ?? (field.type === 'checkbox' ? false : field.type === 'listbox' && field.multiSelect ? [] : '')} onChange={defaultValue => onFieldChange({ defaultValue })} />
      {(field.type === 'text' || choice) && <div className="form-designer-property-grid">
        <NumericProperty label={t("m.font.size.83ca9e")} value={field.fontSize ?? 12} min={1} max={144} onChange={value => onFieldChange({ fontSize: value! })} />
        {field.type === 'text' && <label>{t("m.text.alignment.ca9524")}<select value={field.textAlign ?? 'left'} onChange={event => onFieldChange({ textAlign: event.target.value as 'left' | 'center' | 'right' })}><option value="left">{t("m.left.8ae1c3")}</option><option value="center">{t("m.center.a23911")}</option><option value="right">{t("m.right.954daa")}</option></select></label>}
      </div>}
    </fieldset>
    <fieldset disabled={!editable}>
      <legend>{t("m.selected.widget.9d7a87")}</legend>
      <label>{t("m.widget.page.3c2e39")}<select value={widget.pageNumber} onChange={event => onWidgetChange({ pageNumber: Number(event.target.value) })}>{pages.map(item => <option key={item.pageNumber} value={item.pageNumber}>{t("m.page.fb0627")}{' '}{item.pageNumber}</option>)}</select></label>
      <div className="form-designer-property-grid">
        {(['x', 'y', 'width', 'height'] as const).map(key => <NumericProperty key={`${widget.id}-${key}`} label={{ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]} value={widget.rect[key]} min={key === 'width' || key === 'height' ? 4 : 0} max={key === 'x' ? page.width - widget.rect.width : key === 'y' ? page.height - widget.rect.height : key === 'width' ? page.width - widget.rect.x : page.height - widget.rect.y} onChange={value => onWidgetChange({ rect: { ...widget.rect, [key]: value! } })} />)}
      </div>
      <p className="form-designer-hint">{t("m.positions.and.sizes.are.in.pdf.points.measured.f.416d71")}</p>
      <label className="form-designer-check"><input type="checkbox" checked={widget.hidden} onChange={event => onWidgetChange({ hidden: event.target.checked })} />{t("m.hidden.widget.710a8f")}</label>
      {field.type === 'radio' && <label>{t("m.radio.option.value.c029a4")}<input value={widget.optionValue ?? ''} onChange={event => onWidgetChange({ optionValue: event.target.value })} /></label>}
      <button type="button" onClick={onAddWidget}>{field.type === 'radio' ? t("m.add.radio.choice.3386fd") : t("m.add.another.widget.199b37")}</button>
      <div className="form-designer-delete-actions">{field.widgets.length > 1 && <button type="button" onClick={onDeleteWidget}>{t("m.delete.selected.widget.480d0b")}</button>}<button type="button" className="form-designer-danger" onClick={onDeleteField}>{t("m.delete.field.5ac477")}</button></div>
    </fieldset>
  </div>;
}
