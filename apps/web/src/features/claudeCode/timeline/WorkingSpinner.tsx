import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../shared/ui/Icon";

// CLI-style working indicator: spinning glyph + a rotating whimsical word +
// (elapsed · esc to interrupt). Self-contained ticker so only THIS component
// re-renders on the animation frame — the transcript is untouched.

const WORDS = [
  "Cogitating", "Pondering", "Noodling", "Percolating", "Ruminating", "Conjuring",
  "Marinating", "Finagling", "Spelunking", "Synthesizing", "Wrangling", "Computing",
];

export function WorkingSpinner({ note, tokens }: { note?: string | null; tokens?: number }) {
  const [tick, setTick] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setTick((t) => t + 1), 110);
    return () => window.clearInterval(iv);
  }, []);
  const elapsed = Math.floor((Date.now() - startRef.current) / 1000);
  // Rotate the word roughly every 4.4s; deterministic, no Math.random churn.
  const word = WORDS[Math.floor(tick / 40) % WORDS.length];
  const tokenStr = tokens && tokens > 0 ? ` · ↑ ${tokens >= 1000 ? `${(tokens / 1000).toFixed(0)}k` : tokens} tokens` : "";
  return (
    <div className="ccp-spinner" aria-live="polite">
      <span className="ccp-spinner-glyph"><Icon name="spinner" size={14} className="icon-spin" /></span>
      <span className="ccp-spinner-word">{note ?? word}…</span>
      <span className="ccp-spinner-meta">({elapsed}s{tokenStr} · esc to interrupt)</span>
    </div>
  );
}
