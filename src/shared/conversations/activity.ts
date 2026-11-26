// How many replies are being written now where the store runs, so background work such as embedding can wait for them.

// ── Activity ─────────────────────────────────────────────────────────────────

let replies_going = 0;

export function reply_started(): void {
  replies_going += 1;
}

export function reply_ended(): void {
  replies_going = Math.max(0, replies_going - 1);
}

export function is_replying(): boolean {
  return replies_going > 0;
}
