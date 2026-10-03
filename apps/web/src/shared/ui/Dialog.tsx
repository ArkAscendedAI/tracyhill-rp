import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { Icon } from "./Icon";
import type { IconName } from "./iconSprite";

/**
 * The one dialog primitive. Every modal surface — the
 * account and admin dialogs, the campaign / lorebook / drives panels, the world, audit
 * and wizard dialogs and the confirm prompts — renders through it, so they share one
 * chrome (header with eyebrow/title/icon, a scrolling body, an optional footer, the
 * top-right close) and one behaviour: Escape closes the topmost open dialog, Tab stays
 * inside it, focus lands on the first control and returns to the opener on close, the
 * page behind stops scrolling. Backdrop clicks dismiss only where a dialog opts in
 * (forms keep the old "explicit close" habit so a stray click cannot lose typed input).
 * The close button is named "Close" (title + aria-label), which the browser suites and
 * users' habits rely on; `label` is the dialog's accessible name, unchanged per surface.
 */
export type DialogSize = "sm" | "md" | "lg" | "xl" | "wide" | "panel";

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible name (aria-label) — the strings the suites select dialogs by. */
  label: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  icon?: IconName;
  size?: DialogSize;
  className?: string;
  /** "dialog-body-flush" for panels that lay out their own split panes; "dialog-body-stack" for a simple column. */
  bodyClassName?: string;
  /** Controls between the title and the close button (tabs, selects, a Refresh button). */
  headerExtra?: ReactNode;
  footer?: ReactNode;
  closeDisabled?: boolean;
  hideClose?: boolean;
  dismissOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  zIndex?: number;
  children: ReactNode;
};

// Only the topmost open dialog answers Escape; the body scroll lock releases when the last closes.
const openStack: symbol[] = [];
let lockCount = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open, onClose, label, eyebrow, title, icon, size = "md", className, bodyClassName, headerExtra, footer,
  closeDisabled = false, hideClose = false, dismissOnBackdrop = false, closeOnEscape = true, zIndex, children,
}: DialogProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const idRef = useRef(Symbol("dialog"));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    openStack.push(id);
    const opener = document.activeElement as HTMLElement | null;
    lockCount += 1;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
    const raf = requestAnimationFrame(() => {
      const els = focusables();
      const first = els.find((el) => !el.classList.contains("dialog-close")) ?? els[0];
      first?.focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (event.key === "Escape") {
        if (!closeOnEscapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const els = focusables();
        if (!els.length) return;
        const first = els[0]!;
        const last = els[els.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        const inside = Boolean(active && cardRef.current?.contains(active));
        if (event.shiftKey && (active === first || !inside)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      const at = openStack.indexOf(id);
      if (at >= 0) openStack.splice(at, 1);
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) document.body.style.overflow = "";
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const onBackdrop = dismissOnBackdrop
    ? (event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); }
    : undefined;
  const hasHead = Boolean(eyebrow || title || icon || headerExtra || !hideClose);

  return (
    <div className="dialog-backdrop" role="presentation" style={zIndex ? { zIndex } : undefined} onMouseDown={onBackdrop}>
      <section ref={cardRef} className={`dialog-card dialog-${size}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        {hasHead ? (
          <header className="dialog-head">
            {icon ? <span className="dialog-icon" aria-hidden="true"><Icon name={icon} size={16} /></span> : null}
            <div className="dialog-head-text">
              {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
              {title ? <h3 className="dialog-title">{title}</h3> : null}
            </div>
            {headerExtra ? <div className="dialog-head-extra">{headerExtra}</div> : null}
            {!hideClose ? (
              <button type="button" className="ghost-button dialog-close" onClick={onClose} disabled={closeDisabled} title="Close" aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            ) : null}
          </header>
        ) : null}
        <div className={`dialog-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </section>
    </div>
  );
}
