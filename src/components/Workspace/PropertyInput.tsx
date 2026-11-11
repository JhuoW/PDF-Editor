import { useState, type InputHTMLAttributes } from 'react';

type NumberProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'min' | 'max'> & {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
};

/** Display rounding must never alter an untouched PDF coordinate. */
const displayNumber = (value: number) => Number.isFinite(value) ? String(Number(value.toFixed(4))) : '';

export function PropertyNumberInput({ value, onCommit, min = -100000, max = 100000, step = 'any', ...props }: NumberProps) {
  const [draft, setDraft] = useState({ source: value, text: displayNumber(value), dirty: false });
  if (!Object.is(draft.source, value)) setDraft({ source: value, text: displayNumber(value), dirty: false });
  const valid = draft.text.trim() !== '' && Number.isFinite(Number(draft.text)) && Number(draft.text) >= min && Number(draft.text) <= max;
  const reset = () => setDraft({ source: value, text: displayNumber(value), dirty: false });
  const commit = () => {
    if (!draft.dirty || !valid) { reset(); return; }
    const next = Number(draft.text);
    reset();
    if (next !== value) onCommit(next);
  };
  return <input {...props} type="number" value={draft.text} min={min} max={max} step={step}
    aria-invalid={draft.dirty && !valid || undefined}
    onChange={event => setDraft({ source: value, text: event.target.value, dirty: true })}
    onBlur={commit} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); }
    }} />;
}

type ColorProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: string;
  onCommit: (value: string) => void;
  allowTransparent?: boolean;
};

/** Keep incomplete hex strings out of the canvas and PDF serializers. */
export function PropertyColorInput({ value, onCommit, allowTransparent = false, ...props }: ColorProps) {
  const [draft, setDraft] = useState({ source: value, text: value });
  if (draft.source !== value) setDraft({ source: value, text: value });
  const text = draft.text.trim();
  const valid = /^#[\da-f]{6}$/i.test(text) || allowTransparent && text === 'transparent';
  const reset = () => setDraft({ source: value, text: value });
  const commit = () => { reset(); if (valid && text !== value) onCommit(text); };
  return <input {...props} type="text" value={draft.text} aria-invalid={!valid || undefined}
    onChange={event => setDraft({ source: value, text: event.target.value })}
    onBlur={commit} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); }
    }} />;
}
