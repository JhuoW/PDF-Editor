import { useLocale, translateMessage } from "../../i18n";
import { useState } from 'react';

export function DecorationNumberInput({ label, value, onChange, onDraftChange, min = 0, max = 100000, step = 'any' }: {
  label: string; value: number; onChange: (value: number) => void; onDraftChange?: (dirty: boolean) => void; min?: number; max?: number; step?: number | 'any';
}) {
  useLocale();
  const display = (number: number) => Number.isFinite(number) ? String(Number(number.toFixed(3))) : '';
  const [draft, setDraft] = useState({ source: value, text: display(value), dirty: false });
  if (draft.source !== value) setDraft({ source: value, text: display(value), dirty: false });
  const reset = () => { setDraft({ source: value, text: display(value), dirty: false }); onDraftChange?.(false); };
  const commit = () => {
    // Formatting is for display only. Merely focusing a field must not round
    // the original PDF coordinates or font metrics into a new edit.
    if (!draft.dirty) return;
    if (!draft.text.trim() || !Number.isFinite(Number(draft.text))) { reset(); return; }
    let number = Math.max(min, Math.min(max, Number(draft.text)));
    if (step === 1) number = Math.round(number);
    setDraft({ source: value, text: display(number), dirty: false }); onDraftChange?.(false); if (number !== value) onChange(number);
  };
  return <label>{translateMessage(label)}<input type="number" min={min} max={max} step={step} value={draft.text}
    onChange={event => { setDraft({ source: value, text: event.target.value, dirty: true }); onDraftChange?.(true); }} onBlur={commit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } if (event.key === 'Escape') { event.preventDefault(); reset(); } }} /></label>;
}
