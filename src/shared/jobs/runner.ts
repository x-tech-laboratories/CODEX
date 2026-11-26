// Running jobs where the store lives, on the one device the user chose: each due job starts an ordinary run in a
// conversation of its own, with nobody present, so only calls at the background level are applied and the rest wait as
// proposals. Nothing runs while background work is off; a live conversation always goes first; a job never runs twice
// at once and runs once however many times it was missed; the caps hold a day at a time on every device together; and a
// job that runs only when its context changed makes no engine call when nothing did.

// ── Imports ──────────────────────────────────────────────────────────────────

import { asc, eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_items, contexts, items } from "../contexts/schema.ts";
import { assistant_host } from "../conversations/host.ts";
import { conversation_item_id } from "../conversations/model.ts";
import { add_conversation_record, has_conversation, rename_conversation_record } from "../conversations/records.ts";
import { has_live_runs, start_run, type RunEnd } from "../conversations/run.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { note_event_mood } from "../mood/mood.ts";
import { proposal_of } from "../policy/proposals.ts";
import { subtree } from "../search/documents.ts";
import { text_hash } from "../search/text.ts";
import type { JobRun } from "./model.ts";
import { as_run, background_setting, counted_today, fields_of, is_paused, last_mark, last_turn_at, note_check, rows_with_ids, runs_here, type JobRow } from "./records.ts";
import { is_due } from "./schedule.ts";
import { job_runs, jobs } from "./schema.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

export interface JobHost {
  database: () => SqlDatabase;
  // This device's name, which each run records.
  device: string;
  now: () => number;
  // Hears each run once it ended, such as to tell the user what waits for them.
  on_finished?: (run: JobRun) => void;
}

let current: JobHost | null = null;
// The job whose run is going here now, if any; one at a time.
let running: { job_id: string; done: Promise<JobRun> } | null = null;

export function use_job_host(host: JobHost | null): void {
  current = host;
}

export function job_host(): JobHost {
  if (!current) throw new Error("Jobs run only where the store runs: on the server or in the desktop app's daemon.");
  return current;
}

export function job_running(): string | null {
  return running?.job_id ?? null;
}

// Settles once the job running now, if any, has ended; for tests and for stopping cleanly.
export async function wait_for_job(): Promise<void> {
  await running?.done;
}

// ── Context marks ────────────────────────────────────────────────────────────

// What a context and those inside it hold now, as a hash, leaving out the job's own conversation; with no context,
// every context and item. Equal marks mean nothing changed.
export function context_mark(database: SqlDatabase, context_id: string | null, leave_out: string): string {
  const db = drizzle_of(database);
  const all = db.select({ id: contexts.id, parent_id: contexts.parent_id, name: contexts.name, notes: contexts.notes, is_archived: contexts.is_archived }).from(contexts).orderBy(asc(contexts.id)).all();
  const ids = context_id ? subtree(new Map(all.map((row) => [row.id, row])), context_id) : new Set(all.map((row) => row.id));
  const held = db.select().from(context_items).all().filter((row) => ids.has(row.context_id) && row.item_id !== leave_out).sort((first, second) => `${first.context_id}${first.item_id}`.localeCompare(`${second.context_id}${second.item_id}`));
  const item_ids = [...new Set(held.map((row) => row.item_id))];
  const kept = item_ids.length ? db.select({ id: items.id, title: items.title, snippet: items.snippet, status: items.status, detail: items.detail }).from(items).where(inArray(items.id, item_ids)).orderBy(asc(items.id)).all() : [];
  return text_hash(JSON.stringify([all.filter((row) => ids.has(row.id)), held.map((row) => [row.context_id, row.item_id, row.note]), kept]));
}

// ── Running ──────────────────────────────────────────────────────────────────

// What a run applied and proposed, in plain words, from its tool calls.
function what_it_did(database: SqlDatabase, end: RunEnd): { applied: string[]; proposed: string[] } {
  const applied: string[] = [];
  const proposed: string[] = [];
  for (const call of end.tool_calls) {
    if (call.outcome === "ran" && call.applied_by) applied.push(call.undo?.summary ?? call.name);
    else if (call.outcome === "proposed" && call.proposal_id) {
      try {
        proposed.push(proposal_of(database, call.proposal_id).summary);
      } catch {
        proposed.push(call.name);
      }
    } else if (call.outcome === "ran" && call.name.startsWith("propose_")) proposed.push(call.result.split("\n")[0]!.slice(0, 200));
  }
  return { applied, proposed };
}

// The conversation the job's runs are kept in, made in its context, named after it, when it has none or it was deleted.
function conversation_of(database: SqlDatabase, row: JobRow): string {
  if (row.conversation_id && has_conversation(database, row.conversation_id)) return row.conversation_id;
  const id = add_conversation_record(database, row.context_id || null);
  rename_conversation_record(database, id, row.title);
  drizzle_of(database).update(jobs).set({ conversation_id: id }).where(eq(jobs.id, row.id)).run();
  return id;
}

function finish(database: SqlDatabase, run_id: string, values: Partial<typeof job_runs.$inferInsert>): JobRun {
  drizzle_of(database).update(job_runs).set(values).where(eq(job_runs.id, run_id)).run();
  return as_run(rows_with_ids(database, [run_id])[0]!);
}

// Starts one run of the job, within what is left of today's caps, and settles with its record once it ended.
function run_job(host: JobHost, row: JobRow, mark: string): Promise<JobRun> {
  const database = host.database();
  const fields = fields_of(row);
  const today = counted_today(database, host.now());
  const tokens_left = Math.max(1000, background_setting(database, "daily_tokens") - today.tokens);
  const limits = { max_rounds: fields.limits.max_rounds, max_tokens: Math.min(fields.limits.max_tokens, tokens_left) };
  const id = new_id();
  const started_at = new Date(host.now()).toISOString();
  const conversation_id = conversation_of(database, row);
  drizzle_of(database).insert(job_runs).values({ id, job_id: row.id, title: row.title, started_at, device: host.device, conversation_id, context_mark: mark }).run();
  assistant_host().announce();
  const done = new Promise<JobRun>((resolve) => {
    const on_end = (end: RunEnd) => {
      const did = what_it_did(host.database(), end);
      const outcome = end.stopped_by === "gave_way" ? "gave_way" : end.stopped_by ? "limit" : end.error ? "error" : "done";
      const record = finish(host.database(), id, {
        ended_at: new Date(host.now()).toISOString(),
        engine: end.engine,
        model: end.model,
        rounds: end.rounds,
        input_tokens: end.input_tokens,
        output_tokens: end.output_tokens,
        applied: JSON.stringify(did.applied),
        proposed: JSON.stringify(did.proposed),
        outcome,
        note: end.error,
        run_id: end.run_id,
      });
      assistant_host().announce();
      resolve(record);
    };
    start_run(database, row.context_id || null, row.instruction, conversation_id, { presence: "background", limits, on_end }).catch((error: unknown) => {
      const record = finish(host.database(), id, { ended_at: new Date(host.now()).toISOString(), outcome: "error", note: error instanceof Error ? error.message : String(error) });
      assistant_host().announce();
      resolve(record);
    });
  });
  const ending = done.then((record) => {
    running = null;
    // A job that failed leaves the assistant mildly concerned, and does nothing else.
    if (record.outcome === "error") note_event_mood(host.database(), "concerned", `The job “${record.title}” failed.`, host.now());
    host.on_finished?.(record);
    return record;
  });
  running = { job_id: row.id, done: ending };
  return ending;
}

// Why a job cannot run now, or empty when it can: background work off, a run going, or a cap reached.
export function why_not(database: SqlDatabase, row: JobRow, now: number): string {
  if (!background_setting(database, "enabled")) return "The assistant's jobs are off; turn them on under Settings → Assistant → The assistant's jobs.";
  if (is_paused(database)) return "Background work is paused; carry on under Settings → Assistant → Background work.";
  if (running) return running.job_id === row.id ? "This job is running now." : "Another job is running now; one runs at a time.";
  if (has_live_runs()) return "A reply is being written in a conversation, which goes first.";
  const today = counted_today(database, now);
  if (today.runs >= background_setting(database, "daily_runs")) return "Today's cap on background runs is reached.";
  if (today.tokens >= background_setting(database, "daily_tokens")) return "Today's cap on background tokens is reached.";
  if (counted_today(database, now, row.id).runs >= row.max_runs_per_day) return "This job has run as often as it may today.";
  return "";
}

// Runs the job now, whatever its schedule, within the switch, the caps and one at a time; its own condition is not asked.
export function run_now(row: JobRow): Promise<JobRun> {
  const host = job_host();
  const reason = why_not(host.database(), row, host.now());
  if (reason) throw new Error(reason);
  return run_job(host, row, context_mark(host.database(), row.context_id || null, row.conversation_id ? conversation_item_id(row.conversation_id) : ""));
}

// Looks once for a job that is due and starts it, if this device runs background work; gives back the run started.
export function check_jobs(): Promise<JobRun> | null {
  const host = job_host();
  const database = host.database();
  if (running || !runs_here(database) || !background_setting(database, "enabled") || is_paused(database) || has_live_runs()) return null;
  const now = host.now();
  for (const row of drizzle_of(database).select().from(jobs).where(eq(jobs.is_on, 1)).orderBy(asc(jobs.created_at)).all()) {
    if (!is_due(fields_of(row).schedule, last_turn_at(database, row), now)) continue;
    if (why_not(database, row, now)) continue;
    const mark = context_mark(database, row.context_id || null, row.conversation_id ? conversation_item_id(row.conversation_id) : "");
    if (row.only_when_changed === 1 && last_mark(database, row.id) === mark) {
      note_check(database, row.id, new Date(now).toISOString(), mark);
      continue;
    }
    return run_job(host, row, mark);
  }
  return null;
}

// Looks for due jobs every half minute; stop() ends the looking and waits for the run in hand.
export function keep_running_jobs(host: JobHost, interval_ms = 30_000): { stop: () => Promise<void>; check: () => Promise<JobRun> | null } {
  use_job_host(host);
  const check = () => {
    try {
      return check_jobs();
    } catch (error) {
      console.warn("jobs:", error);
      return null;
    }
  };
  const timer = setInterval(check, interval_ms);
  return {
    check,
    stop: async () => {
      clearInterval(timer);
      await wait_for_job();
      use_job_host(null);
    },
  };
}
