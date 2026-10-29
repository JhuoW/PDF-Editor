import { useState } from 'react';

export function DecorationNumberInput({ label, value, onChange, onDraftChange, min = 0, max = 100000, step = 'any' }: {
  label: string; value: number; onChange: (value: number) => void; onDraftChange?: (dirty: boolean) => void; min?: number; max?: number; step?: number | 'any';
}) {
  const [draft, setDraft] = useState({ source: value, text: String(value) });
  if (draft.source !== value) setDraft({ source: value, text: String(value) });
  const reset = () => { setDraft({ source: value, text: String(value) }); onDraftChange?.(false); };
  const commit = () => {
    if (!draft.text.trim() || !Number.isFinite(Number(draft.text))) { reset(); return; }
    let number = Math.max(min, Math.min(max, Number(draft.text)));
    if (step === 1) number = Math.round(number);
    setDraft({ source: value, text: String(number) }); onDraftChange?.(false); if (number !== value) onChange(number);
  };
  return <label>{label}<input type="number" min={min} max={max} step={step} value={draft.text}
    onChange={event => { setDraft({ source: value, text: event.target.value }); onDraftChange?.(event.target.value !== String(value)); }} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); reset(); } }} /></label>;
}
