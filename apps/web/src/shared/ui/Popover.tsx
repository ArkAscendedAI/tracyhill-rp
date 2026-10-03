import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode, RefObject } from "react";

type Align = "start" | "center" | "end";

type PopoverProps = {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: Align;
  title?: ReactNode;
  width?: number;
  children: ReactNode;
};

export function Popover(props: PopoverProps) {
  const { open, anchorRef, onClose, align = "start", title, width, children } = props;
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const update = () => {
      const anchor = anchorRef.current;
      const pop = popoverRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const popWidth = pop?.offsetWidth ?? width ?? 280;
      let left = rect.left;
      if (align === "center") left = rect.left + rect.width / 2 - popWidth / 2;
      else if (align === "end") left = rect.right - popWidth;
      const maxLeft = window.innerWidth - popWidth - 8;
      left = Math.max(8, Math.min(left, maxLeft));
      // Flip above the anchor (or clamp) when the popover would overflow the
      // viewport bottom — bottom-anchored popovers (sidebar footer badge) used
      // to render their action buttons below the fold.
      const popHeight = pop?.offsetHeight ?? 0;
      let top = rect.bottom + 4;
      if (popHeight && top + popHeight > window.innerHeight - 8) {
        const flipped = rect.top - popHeight - 4;
        top = flipped >= 8 ? flipped : Math.max(8, window.innerHeight - popHeight - 8);
      }
      setPosition({ top, left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, align, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const style: CSSProperties = {
    position: "fixed",
    top: position?.top ?? -9999,
    left: position?.left ?? -9999,
    width: width ?? undefined,
    visibility: position ? "visible" : "hidden",
  };

  // Portal to <body>: a transformed ancestor (the ≤960px overlay sidebar)
  // becomes the containing block for position:fixed and its overflow:hidden
  // clipped popovers rendered inline.
  return createPortal(
    <div ref={popoverRef} className="popover" style={style} role="dialog" aria-modal={false}>
      {title ? <div className="popover-title">{title}</div> : null}
      <div className="popover-body">{children}</div>
    </div>,
    document.body,
  );
}
