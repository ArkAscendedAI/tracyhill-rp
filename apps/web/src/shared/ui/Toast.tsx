import { useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import { setGlobalToastPush, type ToastTone } from "./globalToast";
import { Icon } from "./Icon";

export type { ToastTone } from "./globalToast";
export { emitGlobalToast } from "./globalToast";
export type Toast = { id: string; message: string; tone: ToastTone };

const AUTO_DISMISS_MS = 6000;
const MAX_TOASTS = 4;

/**
 * Lightweight dark-themed toast layer. Surfaces transient errors/info that would
 * otherwise be silent — notably the global mutation-error layer, where
 * AppShell's workspace mutations had no onError and never rendered their .error.
 *
 * Styling is inline (the toast lives outside the owned base.css / tokens.css) but
 * uses the theme CSS variables so it tracks the dark palette.
 */
export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Record<string, number>>({});

  const dismiss = (id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timersRef.current[id];
    if (timer) {
      window.clearTimeout(timer);
      delete timersRef.current[id];
    }
  };

  // push is referentially stable (deps never change) so consumers can safely
  // depend on it without re-subscribing.
  const push = useMemo(() => (message: string, tone: ToastTone = "error") => {
    const text = (message || "").trim() || "Something went wrong.";
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => {
      // Collapse exact duplicates so a burst of identical failures shows once.
      if (current.some((toast) => toast.message === text && toast.tone === tone)) return current;
      const next = [...current, { id, message: text, tone }];
      return next.slice(-MAX_TOASTS);
    });
    timersRef.current[id] = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
  }, []);

  useEffect(() => () => {
    for (const timer of Object.values(timersRef.current)) window.clearTimeout(timer);
    timersRef.current = {};
  }, []);

  // Expose push to non-React surfaces (the QueryClient MutationCache) for the
  // lifetime of the provider.
  useEffect(() => {
    setGlobalToastPush(push);
    return () => setGlobalToastPush(null);
  }, [push]);

  // The only consumer is the module-level push registered above (the
  // QueryClient MutationCache); the React context + useToast hook that used to
  // wrap this had no callers and were removed.
  return (
    <>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: "var(--z-toast)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxWidth: "min(420px, calc(100vw - 32px))",
          pointerEvents: "none",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            style={{
              pointerEvents: "auto",
              background: "var(--surface, #161b22)",
              border: `1px solid ${toast.tone === "error" ? "var(--danger, #f85149)" : "var(--surface-border, #30363d)"}`,
              borderLeft: `3px solid ${toast.tone === "error" ? "var(--danger, #f85149)" : "var(--accent, #58a6ff)"}`,
              borderRadius: 8,
              padding: "10px 12px",
              color: "var(--text, #e6edf3)",
              fontSize: 13,
              lineHeight: 1.4,
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
            }}
          >
            <span style={{ flex: 1, wordBreak: "break-word" }}>{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted, #8b949e)",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
