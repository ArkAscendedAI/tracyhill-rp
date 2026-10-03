import { useState, useEffect } from "react";

type NumericInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  style?: React.CSSProperties;
  "aria-label"?: string;
  className?: string;
};

/**
 * Parse + normalise a typed value. Returns null for non-numeric input (the
 * caller re-syncs the draft to the last committed value). Step rounding runs
 * BEFORE the min/max clamp: rounding after clamping let a `max` that is not a
 * multiple of `step` be exceeded (max=63999, step=500, typed 63999 → 64000).
 */
export function normalizeNumericInput(raw: string, bounds: { min?: number; max?: number; step?: number }): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  let next = parsed;
  if (bounds.step != null && bounds.step > 0) next = Math.round(next / bounds.step) * bounds.step;
  if (bounds.min != null) next = Math.max(bounds.min, next);
  if (bounds.max != null) next = Math.min(bounds.max, next);
  return Math.round(next * 1e10) / 1e10;
}

export function NumericInput({ value, onChange, min, max, step, disabled, style, "aria-label": ariaLabel, className }: NumericInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const next = normalizeNumericInput(draft, { min, max, step });
    if (next == null) { setDraft(String(value)); return; }
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      disabled={disabled}
      style={style}
    />
  );
}
