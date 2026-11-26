// Who is making the call in hand: the user at CODEX's own page (a signed-in browser, the desktop window, or the
// assistant working for them), or a program through a token or MCP. Set around each call's synchronous part, which is
// where a store reads it.

// ── Caller ───────────────────────────────────────────────────────────────────

export type Caller = "page" | "program";

let current: Caller = "page";

// Runs the work as the caller given; the caller before comes back once its synchronous part ends.
export function as_caller<Result>(caller: Caller, work: () => Result): Result {
  const before = current;
  current = caller;
  try {
    return work();
  } finally {
    current = before;
  }
}

export function current_caller(): Caller {
  return current;
}
