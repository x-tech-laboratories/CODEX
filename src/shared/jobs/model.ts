// The shapes the jobs store hands the page and other programs: the assistant's own recurring work, its runs, and the
// switches and caps that let it run at all. The page imports only these types.

// ── Schedules ────────────────────────────────────────────────────────────────

export type IntervalUnit = "minutes" | "hours" | "days";

// Every so many minutes, hours or days; or at a time of day on the weekdays chosen (0 is Sunday).
export type JobSchedule = { kind: "every"; every: number; unit: IntervalUnit } | { kind: "at"; time: string; weekdays: number[] };

// ── Jobs ─────────────────────────────────────────────────────────────────────

export interface JobLimits {
  // The most rounds of model calls, and tokens read and written, one run may use.
  max_rounds: number;
  max_tokens: number;
  // The most runs a day, on every device together.
  max_runs_per_day: number;
}

export const default_limits: JobLimits = { max_rounds: 8, max_tokens: 40_000, max_runs_per_day: 6 };

// The fields a job is written with; on a change, those left out stay.
export interface JobFields {
  title: string;
  instruction: string;
  context_id: string | null;
  schedule: JobSchedule;
  only_when_changed: boolean;
  limits: JobLimits;
}

export type JobMaker = "user" | "engine" | "program";

export interface Job extends JobFields {
  id: string;
  is_on: boolean;
  made_by: JobMaker;
  // The context's name, or empty for a job in no context.
  context_name: string;
  // The conversation its runs are kept in; empty before its first run.
  conversation_id: string;
  created_at: string;
  updated_at: string;
  // The schedule in plain words, such as "every 2 hours".
  when: string;
  // Its latest run, and when it falls due next.
  last_run: JobRun | null;
  next_due_at: string;
  runs_today: number;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// How a run ended: done, failed, stopped at a limit, gave way to a live conversation, or still running.
export type JobRunOutcome = "running" | "done" | "error" | "limit" | "gave_way";

export interface JobRun {
  id: string;
  job_id: string;
  // The job's title when it ran.
  title: string;
  started_at: string;
  ended_at: string;
  // The device that ran it, by name.
  device: string;
  engine: string;
  model: string;
  rounds: number;
  input_tokens: number;
  output_tokens: number;
  // What it applied and what it proposed, in plain words.
  applied: string[];
  proposed: string[];
  outcome: JobRunOutcome;
  // Why it ended so, in plain words; empty when it simply finished.
  note: string;
  conversation_id: string;
  run_id: string;
  // When the user set it aside in the Inbox; empty while it waits there.
  dismissed_at: string;
}

// ── Background work ──────────────────────────────────────────────────────────

export interface BackgroundState {
  // The global switch, off by default: nothing runs while it is off.
  enabled: boolean;
  // Whether this device is the one that runs jobs; a setting of this device alone.
  runs_here: boolean;
  // This device's name, as runs record it.
  device: string;
  // The caps on every device together, a day at a time, and today's use.
  daily_runs: number;
  daily_tokens: number;
  runs_today: number;
  tokens_today: number;
  // Whether a job's run is going now here.
  is_running: boolean;
}

// The synced settings behind the global switch and caps, which only the user at the page may change.
export const background_settings = { enabled: "background.enabled", daily_runs: "background.daily_runs", daily_tokens: "background.daily_tokens" } as const;

export const background_defaults = { [background_settings.enabled]: false, [background_settings.daily_runs]: 24, [background_settings.daily_tokens]: 200_000 };
