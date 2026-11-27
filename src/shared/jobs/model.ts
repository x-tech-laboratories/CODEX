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
  // The context's name, Global's for a job with none.
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
  // How many things a maintenance job's run handled; 0 for an assistant job's.
  items: number;
}

// ── Background work ──────────────────────────────────────────────────────────

// A device that can run background work: a desktop daemon or a server, by the id it made for itself.
export interface BackgroundDevice {
  id: string;
  name: string;
  kind: "desktop" | "server";
  started_at: string;
}

export interface BackgroundState {
  // The switch for the assistant's own jobs, off by default: none of them runs while it is off.
  enabled: boolean;
  // Every kind of background work waits while this is on, the assistant's jobs and the maintenance jobs alike.
  paused: boolean;
  // Whether this device is the one that runs background work.
  runs_here: boolean;
  // This device's id and name, as runs record it; empty where nothing runs, such as a test's store.
  device_id: string;
  device: string;
  // The device chosen to run background work, by id, and every device that can, as each last said of itself.
  chosen_device: string;
  devices: BackgroundDevice[];
  // How many minutes apart the maintenance jobs look for work.
  tick_minutes: number;
  // Whether background work may use a hosted engine; off, it uses a local engine only.
  hosted_allowed: boolean;
  // The caps on the assistant's jobs on every device together, a day at a time, and today's use.
  daily_runs: number;
  daily_tokens: number;
  runs_today: number;
  tokens_today: number;
  // Whether a job's run is going now here.
  is_running: boolean;
}

// The synced settings behind background work, which only the user at the page may change.
export const background_settings = {
  enabled: "background.enabled",
  daily_runs: "background.daily_runs",
  daily_tokens: "background.daily_tokens",
  paused: "background.paused",
  device: "background.device",
  tick_minutes: "background.tick_minutes",
  hosted: "background.hosted",
} as const;

export const background_defaults = {
  [background_settings.enabled]: false,
  [background_settings.daily_runs]: 24,
  [background_settings.daily_tokens]: 200_000,
  [background_settings.paused]: false,
  [background_settings.device]: "",
  [background_settings.tick_minutes]: 30,
  [background_settings.hosted]: false,
};

// The conversation, in Global, that background maintenance's proposals are kept in.
export const maintenance_conversation_id = "maintenance";

// The job id under which a maintenance job's runs are kept beside the assistant's own jobs' runs.
export const maintenance_prefix = "maintenance:";
