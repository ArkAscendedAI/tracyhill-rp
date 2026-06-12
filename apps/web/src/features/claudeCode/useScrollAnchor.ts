import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Bottom-anchored scroll behavior for streaming timelines.
 *
 * - While the user is at (or near) the bottom, every render keeps the
 *   container pinned to the bottom via an INSTANT scrollTop write inside
 *   useLayoutEffect — applied before paint, so streaming growth never
 *   produces a visible jump or a smooth-scroll animation fighting deltas.
 * - Scrolling up unpins; scrolling back to the bottom re-pins.
 * - Programmatic writes are flagged so they never unpin themselves.
 */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>) {
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  // Runs after EVERY render of the consuming component. Cheap: one property
  // read + one conditional write. rAF-batched stream state caps renders at
  // frame rate, so this never runs more than ~60x/s.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pinnedRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    if (programmaticRef.current) { programmaticRef.current = false; return; }
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJump(false);
    programmaticRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  return { onScroll, showJump, jumpToLatest };
}
