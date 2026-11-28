// A scrolling box that keeps its newest content in view only while the reader is at its bottom: scrolling up lets go,
// coming back to the bottom or jumping there holds on again, and content growing or the box scrolling itself never lets go.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";
import { at_bottom } from "@x-tech-laboratories/x-libs/web/react/following";

// ── Pinning ──────────────────────────────────────────────────────────────────

export interface PinnedScroll<Box extends HTMLElement> {
  ref: RefObject<Box | null>;
  pinned: boolean;
  on_scroll: (event: UIEvent<Box>) => void;
  // Scrolls to the bottom and holds on there.
  jump: () => void;
}

// Scrolls the box to its end whenever the content changes while pinned; active false leaves the scroll alone.
export function use_pinned_scroll<Box extends HTMLElement>(content: unknown, active = true): PinnedScroll<Box> {
  const ref = useRef<Box>(null);
  const [pinned, set_pinned] = useState(true);
  const last_top = useRef(0);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    if (pinned && active) box.scrollTop = box.scrollHeight;
    last_top.current = box.scrollTop;
  }, [content, pinned, active]);

  // Only the reader scrolling up lets go, so the box's own scroll, landing short as content grows, keeps it pinned.
  const on_scroll = useCallback((event: UIEvent<Box>) => {
    const box = event.currentTarget;
    if (at_bottom(box)) set_pinned(true);
    else if (box.scrollTop < last_top.current) set_pinned(false);
    last_top.current = box.scrollTop;
  }, []);

  const jump = useCallback(() => {
    const box = ref.current;
    if (box) box.scrollTop = box.scrollHeight;
    set_pinned(true);
  }, []);

  return { ref, pinned, on_scroll, jump };
}
