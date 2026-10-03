import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

/**
 * A text field that wraps and grows with its content:
 * one line when empty, taller as the text needs, capped at `maxRows` and scrolling inside
 * beyond that. Replaces the single-line inputs whose long text used to run off the right
 * edge in the drives and lorebook editors, the world tick, the audit rulings and the
 * wizard forms. `singleLineEnter` keeps Enter from inserting a newline where the value is a
 * one-line thing (a want, a key list); Shift+Enter still breaks a line there. Re-measures
 * when the value or the width changes.
 */
export type AutoTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> & {
  minRows?: number;
  maxRows?: number;
  singleLineEnter?: boolean;
};

export const AutoTextarea = forwardRef<HTMLTextAreaElement, AutoTextareaProps>(function AutoTextarea(
  { minRows = 1, maxRows = 8, singleLineEnter = false, className, value, onKeyDown, style, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 20;
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const min = Math.ceil(minRows * line + pad + border);
      const max = Math.ceil(maxRows * line + pad + border);
      el.style.height = "auto";
      const wanted = el.scrollHeight + border;
      const next = Math.max(min, Math.min(wanted, max));
      el.style.height = `${next}px`;
      el.style.overflowY = wanted > max ? "auto" : "hidden";
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [value, minRows, maxRows]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (singleLineEnter && event.key === "Enter" && !event.shiftKey) event.preventDefault();
    onKeyDown?.(event);
  };

  return (
    <textarea
      ref={inner}
      rows={minRows}
      className={`auto-textarea${className ? ` ${className}` : ""}`}
      value={value}
      onKeyDown={handleKeyDown}
      style={style}
      {...rest}
    />
  );
});
