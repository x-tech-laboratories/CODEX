// The self-maintenance loop where the store runs: every so many minutes a tick asks each maintenance job, in order,
// whether there is work, which costs no model call and no request to any app; a job with nothing to do leaves only a
// count of the times it looked. A job with work runs within its budget: runs a day, things handled in one run and time
// for one run, and for the model job model calls and tokens a day. Nothing runs while background work is paused; the
// loop waits while a reply is being written; and only the chosen device runs the jobs that change synced data, while
// every device keeps its own index.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { has_live_runs } from "../conversations/run.ts";
import { note_event_mood } from "../mood/mood.ts";
import { background_setting, is_paused, register_device, runs_here } from "../jobs/records.ts";
import type { BackgroundDevice } from "../jobs/model.ts";
import { job_work, type Done, type JobContext } from "./jobs.ts";
import { maintenance_jobs, maintenance_keys, type MaintenanceKey } from "./model.ts";
import { budget_of, finish_run_record, job_on, note_ran, note_skip, start_run_record, use_today } from "./records.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

export interface MaintenanceHost {
  database: () => SqlDatabase;
  index: () => SqlDatabase;
  // This device as runs record it, and whether it is a desktop app or a server.
  device: string;
  kind: BackgroundDevice["kind"];
  now: () => number;
  // Told when a job changed the store, so History records it and pages hear of it.
  on_change?: () => void;
  // How long to wait between looks while a reply is being written or a pause is on.
  wait_ms?: number;
}

let current: MaintenanceHost | null = null;
let ticking: Promise<TickReport> | null = null;
let stopping = new AbortController();

export function use_maintenance_host(host: MaintenanceHost | null): void {
  current = host;
  if (host && stopping.signal.aborted) stopping = new AbortController();
}

export function maintenance_host(): MaintenanceHost | null {
  return current;
}

// ── Waiting ──────────────────────────────────────────────────────────────────

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits while a reply the user waits for is being written; false when background work was paused or stopped meanwhile.
async function wait_for_quiet(host: MaintenanceHost): Promise<boolean> {
  while (has_live_runs()) {
    if (stopping.signal.aborted || is_paused(host.database())) return false;
    await pause(host.wait_ms ?? 2000);
  }
  return !stopping.signal.aborted && !is_paused(host.database());
}

// A signal that aborts at the run's time limit, when background work is paused, or when the loop stops.
function run_signal(host: MaintenanceHost, seconds: number): { signal: AbortSignal; end: () => void } {
  const control = new AbortController();
  const time = setTimeout(() => control.abort(new Error("time")), seconds * 1000);
  const watch = setInterval(() => {
    if (is_paused(host.database())) control.abort(new Error("paused"));
  }, host.wait_ms ?? 2000);
  const on_stop = () => control.abort(new Error("stopped"));
  stopping.signal.addEventListener("abort", on_stop, { once: true });
  return {
    signal: control.signal,
    end: () => {
      clearTimeout(time);
      clearInterval(watch);
      stopping.signal.removeEventListener("abort", on_stop);
    },
  };
}

// ── One job ──────────────────────────────────────────────────────────────────

// What one job did on a tick: ran, did nothing and why, or was not this device's to look at.
export type JobOutcome = { key: MaintenanceKey; ran: false; reason: string } | { key: MaintenanceKey; ran: true; done: Done };

// Why the job may not run today, in plain words, or empty while its budget allows.
function used_up_reason(database: SqlDatabase, key: MaintenanceKey, now: number, device: string): string {
  const budget = budget_of(database, key);
  const used = use_today(database, key, now, device);
  if (used.runs >= budget.runs_per_day) return `It used today's ${budget.runs_per_day.toLocaleString("en")} ${budget.runs_per_day === 1 ? "run" : "runs"}; it runs again tomorrow.`;
  if (maintenance_jobs[key].uses_model) {
    if (used.model_calls >= budget.model_calls_per_day) return `It used today's ${budget.model_calls_per_day.toLocaleString("en")} model calls; it runs again tomorrow.`;
    if (used.tokens >= budget.tokens_per_day) return `It used today's ${budget.tokens_per_day.toLocaleString("en")} tokens; it runs again tomorrow.`;
  }
  return "";
}

// The jobs whose work is finding something new: links, likely duplicates, proposals and findings on the web.
const finding_jobs: ReadonlySet<MaintenanceKey> = new Set(["rules", "similarity", "tidy", "suggest", "research"]);

// A run that failed leaves the assistant mildly concerned; one that found something new, mildly curious.
function note_finding_mood(database: SqlDatabase, key: MaintenanceKey, result: Done, now: number): void {
  const title = maintenance_jobs[key].title;
  if (result.error) note_event_mood(database, "concerned", `${title} failed.`, now);
  else if (finding_jobs.has(key) && result.applied.length + result.proposed.length > 0) note_event_mood(database, "curious", `${title} found something new.`, now);
}

// Looks for one job's work and runs it within its budget; a job turned off, out of budget or with nothing to do only
// notes why.
export async function run_maintenance_job(host: MaintenanceHost, key: MaintenanceKey): Promise<JobOutcome> {
  const database = host.database();
  const now = host.now();
  const skip = (reason: string, used_up = ""): JobOutcome => {
    note_skip(database, key, host.device, reason, now, used_up);
    return { key, ran: false, reason };
  };
  if (!job_on(database, key)) return skip("It is turned off.");
  const used_up = used_up_reason(database, key, now, host.device);
  if (used_up) return skip(used_up, used_up);
  const budget = budget_of(database, key);
  const used = use_today(database, key, now, host.device);
  const { signal, end } = run_signal(host, budget.seconds_per_run);
  const context: JobContext = { database, index: host.index(), now, signal, budget, used, device: host.device };
  try {
    const work = await job_work[key].check(context);
    if (work.reason) return skip(work.reason);
    if (work.count === 0) return skip("Nothing changed, so there was nothing to do.");
    note_ran(database, key, host.device, now);
    const id = start_run_record(database, key, host.device, now);
    let result: Done;
    try {
      result = await job_work[key].run(context);
    } catch (error) {
      result = { items: 0, applied: [], proposed: [], note: "", error: error instanceof Error ? error.message : String(error) };
    }
    const reason = signal.reason instanceof Error ? signal.reason.message : "";
    const timed_out = signal.aborted && reason === "time";
    const gave_way = result.gave_way || (signal.aborted && !timed_out);
    const note = [result.note, timed_out ? `It stopped at its limit of ${budget.seconds_per_run} seconds; the rest waits for the next run.` : "", gave_way ? "It stopped for a pause or a conversation, and carries on later." : ""].filter(Boolean).join(" ");
    finish_run_record(
      host.database(),
      id,
      {
        ended_at: new Date(host.now()).toISOString(),
        items: result.items,
        applied: result.applied,
        proposed: result.proposed,
        outcome: result.error ? "error" : gave_way ? "gave_way" : "done",
        note: result.error ? [result.error, note].filter(Boolean).join(" ") : note,
        engine: result.engine ?? "",
        model: result.model ?? "",
        rounds: result.rounds ?? 0,
        input_tokens: result.input_tokens ?? 0,
        output_tokens: result.output_tokens ?? 0,
        conversation_id: result.conversation_id ?? "",
        run_id: result.run_id ?? "",
      },
      host.now(),
    );
    note_finding_mood(host.database(), key, result, host.now());
    if (result.changed_store) host.on_change?.();
    // A run that used up the day's budget says so at once, for Settings and the digest.
    const now_used_up = used_up_reason(host.database(), key, host.now(), host.device);
    if (now_used_up) note_skip(host.database(), key, host.device, now_used_up, host.now(), now_used_up);
    return { key, ran: true, done: result };
  } finally {
    end();
  }
}

// ── Ticks ────────────────────────────────────────────────────────────────────

export interface TickReport {
  // Why the tick did nothing at all, or empty when it looked.
  reason: string;
  jobs: JobOutcome[];
}

// Looks once at every job this device runs, in order, waiting while a reply is written and stopping at a pause.
export function tick(): Promise<TickReport> {
  if (ticking) return ticking;
  const host = current;
  if (!host) return Promise.resolve({ reason: "Maintenance runs only where the store runs.", jobs: [] });
  const looking = async (): Promise<TickReport> => {
    const jobs: JobOutcome[] = [];
    if (is_paused(host.database())) return { reason: "Background work is paused.", jobs };
    for (const key of maintenance_keys) {
      // A job turned off, or not this device's, is not looked at at all.
      if ((maintenance_jobs[key].where === "chosen" && !runs_here(host.database())) || !job_on(host.database(), key)) continue;
      if (!(await wait_for_quiet(host))) return { reason: stopping.signal.aborted ? "Stopped." : "Background work is paused.", jobs };
      try {
        jobs.push(await run_maintenance_job(host, key));
      } catch (error) {
        console.warn(`maintenance ${key}:`, error);
      }
    }
    return { reason: "", jobs };
  };
  // Let go of only once settled, after it is kept here, even when it ends at once.
  const started = looking().finally(() => {
    if (ticking === started) ticking = null;
  });
  ticking = started;
  return ticking;
}

// Settles once the tick in hand, if any, has ended.
export async function settle_maintenance(): Promise<void> {
  while (ticking) await ticking;
}

// Says this device can run background work, then ticks every so many minutes, as the setting says, looking each
// minute whether one is due; stop() ends the work in hand at its next safe point.
export function keep_maintaining(host: MaintenanceHost, poll_ms = 60_000): { stop: () => Promise<void>; tick: () => Promise<TickReport> } {
  use_maintenance_host(host);
  register_device(host.database(), host.device, host.kind, host.now());
  let last = 0;
  const poll = () => {
    const minutes = Math.max(1, background_setting(host.database(), "tick_minutes"));
    if (host.now() - last < minutes * 60_000) return;
    last = host.now();
    void tick().catch((error: unknown) => console.warn("maintenance:", error));
  };
  const timer = setInterval(poll, poll_ms);
  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      await settle_maintenance();
      use_maintenance_host(null);
    },
  };
}
