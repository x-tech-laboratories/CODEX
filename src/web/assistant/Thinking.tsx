// What a reasoning model is thinking, or thought, folded under a Thinking row.

import { FormGroup } from "@x-tech-laboratories/x-libs/web/react/layout";

import { use_pinned_scroll } from "./pinned_scroll.ts";

// What a reasoning model is thinking, or thought, folded under a Thinking row that opens to about ten lines, following
// the newest text as it streams unless the reader has scrolled up.
export function Thinking({ text, active = true }: { text: string; active?: boolean }) {
  const tail = use_pinned_scroll<HTMLParagraphElement>(text, active);
  return (
    <FormGroup class_name="reply-thinking" summary={<span className="muted small">{active ? "Thinking…" : "Thinking"}</span>}>
      <p ref={tail.ref} className="muted small reply-thinking-text" onScroll={tail.on_scroll}>
        {text}
      </p>
    </FormGroup>
  );
}
