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

export function NumericInput({ value, onChange, min, max, step, disabled, style, "aria-label": ariaLabel, className }: NumericInputProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
    let clamped = parsed;
    if (min != null) clamped = Math.max(min, clamped);
    if (max != null) clamped = Math.min(max, clamped);
    if (step != null && step > 0) clamped = Math.round(clamped / step) * step;
    clamped = Math.round(clamped * 1e10) / 1e10;
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
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
