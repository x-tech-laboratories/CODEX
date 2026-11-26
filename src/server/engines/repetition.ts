// Notices a reply going round in circles: looping text packs far smaller than prose, code or data does.

// ── Imports ──────────────────────────────────────────────────────────────────

import { deflateRawSync } from "node:zlib";

// ── Repetition ───────────────────────────────────────────────────────────────

export const repeat_window_chars = 1200;
// How much new text arrives between checks.
export const repeat_check_chars = 200;
const repeat_ratio = 0.2;

export function is_repeating(text: string): boolean {
  if (text.length < repeat_window_chars) return false;
  const tail = Buffer.from(text.slice(-repeat_window_chars), "utf8");
  return deflateRawSync(tail).length / tail.length < repeat_ratio;
}

// Says, as text streams in, whether it has started repeating; checks every repeat_check_chars.
export function repetition_watch(): (text: string) => boolean {
  let checked = 0;
  return (text) => {
    if (text.length - checked < repeat_check_chars) return false;
    checked = text.length;
    return is_repeating(text);
  };
}
