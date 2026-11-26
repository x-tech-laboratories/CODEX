// Undoing a change the assistant applied, by approval or at the auto level, through History: as the change is made, the
// contexts it touched are noted with the version each had before and the one it made; undoing restores the version
// before, or removes a context the change made, for as long as nothing has changed those contexts since. A change
// History keeps nothing of, such as a refresh, cannot be undone.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { ChangeUndo, ConversationMessage, ToolCallRecord } from "../conversations/model.ts";
import { history_of, type Snapshot } from "../history/store.ts";

// ── Noting ───────────────────────────────────────────────────────────────────

const versions = "context_history_versions";

// Where History stood just before a change: its last version on this device, and when.
export interface ChangeMark {
  last_id: number;
  at: string;
}

export function mark_before_change(database: SqlDatabase): ChangeMark {
  const row = database.prepare(`SELECT COALESCE(MAX(id), 0) AS last_id FROM ${versions}`).get() as { last_id: number };
  return { last_id: Number(row.last_id), at: new Date().toISOString() };
}

// The newest version of a context up to a point, by its uid; null when it had none.
function newest_version(database: SqlDatabase, item_id: string, up_to_id = Number.MAX_SAFE_INTEGER): string | null {
  const row = database.prepare(`SELECT uid FROM ${versions} WHERE item_id = ? AND id <= ? ORDER BY changed_at DESC, id DESC LIMIT 1`).get(item_id, up_to_id) as { uid: string } | undefined;
  return row?.uid ?? null;
}

// What a change made, once History recorded it: each context it touched, with the version before and the one it made.
export function undo_of_change(database: SqlDatabase, mark: ChangeMark, summary: string): ChangeUndo {
  const made = database.prepare(`SELECT item_id, uid FROM ${versions} WHERE id > ? AND changed_at >= ? ORDER BY id`).all(mark.last_id, mark.at) as { item_id: string; uid: string }[];
  const latest = new Map<string, string>();
  for (const row of made) latest.set(row.item_id, row.uid);
  const steps = [...latest].map(([item_id, uid]) => ({ item_id, made: uid, before: newest_version(database, item_id, mark.last_id) }));
  return { summary, steps };
}

// ── Checking ─────────────────────────────────────────────────────────────────

export type UndoState = "possible" | "undone" | "impossible";

export interface ChangeUndoState {
  message_id: string;
  call_id: string;
  state: UndoState;
  // Why it cannot be undone, in plain words; empty otherwise.
  reason: string;
}

function snapshot_of(database: SqlDatabase, uid: string): { item_id: string; kind: string; snapshot: Snapshot } | null {
  const row = database.prepare(`SELECT item_id, kind, snapshot FROM ${versions} WHERE uid = ?`).get(uid) as { item_id: string; kind: string; snapshot: string } | undefined;
  return row ? { item_id: row.item_id, kind: row.kind, snapshot: JSON.parse(row.snapshot) as Snapshot } : null;
}

// A context's own rows, without its links, which rules and the user may change without touching the context.
function own_rows(snapshot: Snapshot): string {
  const { graph_links: _links, ...rest } = snapshot;
  return JSON.stringify(rest);
}

function name_in(snapshot: Snapshot | undefined): string {
  return String(snapshot?.contexts?.[0]?.name ?? "A context");
}

// Whether undoing is still possible, and why not when it is not.
export function undo_state(database: SqlDatabase, call: ToolCallRecord): { state: UndoState; reason: string } {
  if (call.undo?.undone_at) return { state: "undone", reason: "" };
  if (!call.undo) return { state: "impossible", reason: "Made before undoing was recorded; History keeps its versions to restore by hand." };
  if (call.undo.steps.length === 0) return { state: "impossible", reason: "It changed nothing History keeps, such as what a refresh found, so it cannot be undone." };
  for (const step of call.undo.steps) {
    const made = snapshot_of(database, step.made);
    if (!made) return { state: "impossible", reason: "History no longer keeps the versions this change made." };
    const newest = newest_version(database, step.item_id);
    const now = newest ? snapshot_of(database, newest) : null;
    const unchanged = newest === step.made || (now !== null && now.kind === made.kind && own_rows(now.snapshot) === own_rows(made.snapshot));
    if (!unchanged) return { state: "impossible", reason: `${name_in(made.snapshot)} has changed since, so undoing this would undo that too.` };
    if (step.before && !snapshot_of(database, step.before)) return { state: "impossible", reason: "History no longer keeps the version from before this change." };
  }
  return { state: "possible", reason: "" };
}

// Every applied change in a conversation's messages with whether it can still be undone.
export function undo_states(database: SqlDatabase, messages: ConversationMessage[]): ChangeUndoState[] {
  return messages.flatMap((message) =>
    message.tool_calls.filter((call) => call.applied_by && call.outcome === "ran").map((call) => ({ message_id: message.id, call_id: call.id, ...undo_state(database, call) })),
  );
}

// ── Undoing ──────────────────────────────────────────────────────────────────

// Puts each context the change touched back as it was before: one it made is removed, the rest restored, a parent
// before what sits inside it.
export function undo_steps(database: SqlDatabase, undo: ChangeUndo, remove_context: (id: string) => void): void {
  const history = history_of("context");
  const exists = (id: string) => database.prepare("SELECT 1 FROM contexts WHERE id = ?").get(id) !== undefined;
  for (const step of undo.steps.filter((each) => each.before === null)) if (exists(step.item_id)) remove_context(step.item_id);
  const parent_of = (step: ChangeUndo["steps"][number]) => snapshot_of(database, step.before!)?.snapshot.contexts?.[0]?.parent_id;
  let waiting = undo.steps.filter((each) => each.before !== null);
  while (waiting.length > 0) {
    const ready = waiting.filter((step) => !waiting.some((other) => other.item_id === parent_of(step)));
    const batch = ready.length > 0 ? ready : waiting;
    for (const step of batch) history.restore(database, step.before!);
    waiting = waiting.filter((step) => !batch.includes(step));
  }
}
