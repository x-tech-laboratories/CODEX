// Jobs: the assistant's own recurring work, each an instruction run on a schedule in a conversation of its own, with
// nobody present. The user's recurring tasks live in X-Tasks; these are the assistant's. The user makes and manages
// them, and the engine may ask for one in a conversation, as a change under the action policy like any other.

// ── Imports ──────────────────────────────────────────────────────────────────

import { asc, desc, eq, inArray, like, not, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { settings_of } from "@x-tech-laboratories/x-libs/settings";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { current_caller } from "../caller.ts";
import { context_or_global } from "../contexts/model.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import { background_defaults, background_settings, maintenance_prefix, type BackgroundState, type Job, type JobFields, type JobRun } from "./model.ts";
import { as_job, as_run, background_setting, checked_fields, counted_today, device_id_of, fields_of, job_row, list_devices, rows_with_ids, runs_here, runs_of } from "./records.ts";
import { write_setting } from "../settings.ts";
import { job_host, job_running, run_now } from "./runner.ts";
import { job_runs, job_tables, jobs } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

function now_of(): number {
  try {
    return job_host().now();
  } catch {
    return Date.now();
  }
}

function list_jobs(database: SqlDatabase, context_id?: string | null): Job[] {
  const rows = drizzle_of(database).select().from(jobs).orderBy(asc(jobs.title), asc(jobs.id)).all();
  const wanted = context_id === undefined ? rows : rows.filter((row) => context_or_global(row.context_id) === context_or_global(context_id));
  return wanted.map((row) => as_job(database, row, now_of()));
}

function get_job(database: SqlDatabase, id: string): Job & { runs: JobRun[] } {
  const row = job_row(database, id);
  return { ...as_job(database, row, now_of()), runs: runs_of(database, id) };
}

function list_job_runs(database: SqlDatabase, job_id: string | null = null, limit = 50): JobRun[] {
  const most = Math.max(1, Math.min(500, Number(limit) || 50));
  if (job_id) return runs_of(database, job_id, most);
  // The maintenance jobs' runs are listed with them, under Settings → Background work.
  return drizzle_of(database).select().from(job_runs).where(not(like(job_runs.job_id, `${maintenance_prefix}%`))).orderBy(desc(job_runs.started_at)).limit(most).all().map(as_run);
}

function get_background_state(database: SqlDatabase): BackgroundState {
  const today = counted_today(database, now_of());
  let device = "";
  try {
    device = job_host().device;
  } catch {
    // Not where jobs run, such as a test's store.
  }
  return {
    enabled: background_setting(database, "enabled"),
    paused: background_setting(database, "paused"),
    runs_here: runs_here(database),
    device_id: device ? device_id_of(database) : "",
    device,
    chosen_device: background_setting(database, "device"),
    devices: list_devices(database),
    tick_minutes: background_setting(database, "tick_minutes"),
    hosted_allowed: background_setting(database, "hosted"),
    daily_runs: background_setting(database, "daily_runs"),
    daily_tokens: background_setting(database, "daily_tokens"),
    runs_today: today.runs,
    tokens_today: today.tokens,
    is_running: job_running() !== null,
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

// A job the user makes, one the engine asked for and the user approved, or one the engine made at a level that lets
// it, is on at once; one a program adds through a token or MCP starts off, for the user to turn on.
function add_job(database: SqlDatabase, fields: JobFields): string {
  const caller = current_caller();
  const by_program = caller === "program";
  const checked = checked_fields(database, fields);
  const id = new_id();
  const at = new Date(now_of()).toISOString();
  drizzle_of(database)
    .insert(jobs)
    .values({
      id,
      title: checked.title,
      instruction: checked.instruction,
      context_id: checked.context_id ?? "",
      schedule: JSON.stringify(checked.schedule),
      only_when_changed: checked.only_when_changed ? 1 : 0,
      ...checked.limits,
      is_on: by_program ? 0 : 1,
      made_by: caller === "page" ? "user" : caller,
      created_at: at,
      updated_at: at,
    })
    .run();
  return id;
}

function change_job(database: SqlDatabase, id: string, fields: Partial<JobFields>): void {
  const row = job_row(database, id);
  const checked = checked_fields(database, fields ?? {}, fields_of(row));
  drizzle_of(database)
    .update(jobs)
    .set({
      title: checked.title,
      instruction: checked.instruction,
      context_id: checked.context_id ?? "",
      schedule: JSON.stringify(checked.schedule),
      only_when_changed: checked.only_when_changed ? 1 : 0,
      ...checked.limits,
      updated_at: new Date(now_of()).toISOString(),
    })
    .where(eq(jobs.id, id))
    .run();
}

function remove_job(database: SqlDatabase, id: string): void {
  job_row(database, id);
  drizzle_of(database).delete(jobs).where(eq(jobs.id, id)).run();
}

function set_job_on(database: SqlDatabase, id: string, on: boolean): void {
  job_row(database, id);
  drizzle_of(database).update(jobs).set({ is_on: on ? 1 : 0, updated_at: new Date(now_of()).toISOString() }).where(eq(jobs.id, id)).run();
}

// Starts the job now; answers once its run has started, while it goes on in the background.
async function run_job_now(database: SqlDatabase, id: string): Promise<{ started: true }> {
  void run_now(job_row(database, id)).catch((error: unknown) => console.warn("jobs:", error));
  return { started: true };
}

// Names the one device that runs background work; every other device does none.
function set_background_device(database: SqlDatabase, device_id: string): void {
  if (typeof device_id !== "string" || !list_devices(database).some((device) => device.id === device_id)) throw new Error("Choose one of the devices get_background_state lists.");
  write_setting(database, background_settings.device, device_id);
}

// Sets runs that ended badly aside, so the Inbox no longer lists them.
function dismiss_job_runs(database: SqlDatabase, ids: string[]): number {
  const found = rows_with_ids(database, Array.isArray(ids) ? ids.map(String) : []).filter((row) => !row.dismissed_at);
  if (found.length === 0) return 0;
  drizzle_of(database)
    .update(job_runs)
    .set({ dismissed_at: new Date(now_of()).toISOString() })
    .where(inArray(job_runs.id, found.map((row) => row.id)))
    .run();
  return found.length;
}

// ── Feature ──────────────────────────────────────────────────────────────────

const schedule_schema = {
  type: "object",
  description: 'When it runs: { "kind": "every", "every": 2, "unit": "hours" } (minutes, at least 5; hours; or days), or { "kind": "at", "time": "07:30", "weekdays": [1, 2, 3, 4, 5] } in local time, 0 being Sunday.',
  properties: {
    kind: { type: "string", enum: ["every", "at"] },
    every: { type: "integer", minimum: 1 },
    unit: { type: "string", enum: ["minutes", "hours", "days"] },
    time: { type: "string" },
    weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
  },
} as const;

const limits_schema = {
  type: "object",
  description: "The most one run may use, and how often it may run: max_rounds (1 to 20), max_tokens (1,000 to 1,000,000) and max_runs_per_day (1 to 288); left out, 8, 40,000 and 6.",
  properties: { max_rounds: { type: "integer" }, max_tokens: { type: "integer" }, max_runs_per_day: { type: "integer" } },
} as const;

const fields_schema = (all: boolean) => ({
  type: "object",
  description: all ? "The job." : "The fields to change; those left out stay.",
  properties: {
    title: text("A short title, such as “Morning review”."),
    instruction: text("What the assistant is to do each time, written as the user would ask it."),
    context_id: { type: ["string", "null"], description: "The context it works in, from list_contexts; null for Global, where it covers everything." },
    schedule: schedule_schema,
    only_when_changed: { type: "boolean", description: "Run only when something in its context changed since its last run; no engine call is made otherwise." },
    limits: limits_schema,
  },
  ...(all ? { required: ["title", "instruction", "schedule"] } : {}),
});

const job_param = { name: "id", schema: id_of("job") };

export const jobs_feature = define_feature({
  id: "jobs",
  migrations: migrations.map((migration) => migration.statements),
  // This device's own switch and checks stay here.
  tables: synced_tables(job_tables),
  methods: { list_jobs, get_job, list_job_runs, get_background_state, add_job, change_job, remove_job, set_job_on, run_job_now, set_background_device, dismiss_job_runs },
  api: {
    list_jobs: {
      description:
        "Lists the assistant's own recurring jobs, each with its title, instruction, context, schedule in plain words, whether it runs only when its context changed, its limits, whether it is on, its latest run and when it falls due next. The user's own recurring tasks are in X-Tasks, not here.",
      params: [{ name: "context_id", schema: { type: ["string", "null"], description: "Only the jobs of this context, Global's for null; left out for all." }, optional: true }],
    },
    get_job: { description: "Gets one job with its latest runs, newest first: when each ran, on which device, with which engine, what it used, applied and proposed, and how it ended.", params: [job_param] },
    list_job_runs: {
      description: "Lists the runs of one job, or of every job for null, newest first.",
      params: [
        { name: "job_id", schema: { type: ["string", "null"], description: "The job's id, or null for every job." }, optional: true },
        { name: "limit", schema: { type: "integer", minimum: 1, maximum: 500, description: "How many at most; 50 unless given." }, optional: true },
      ],
    },
    get_background_state: {
      description:
        "Says whether the assistant's jobs are on and whether all background work is paused, which device runs background work and every device that can, whether this device is that one, how often the maintenance jobs look for work, whether background work may use a hosted engine, today's caps on the assistant's jobs' runs and tokens with today's use, and whether a job runs now.",
      params: [],
    },
    add_job: {
      description:
        "Adds one of the assistant's own recurring jobs: an instruction run on a schedule in a conversation of its own, with nobody present, so only changes allowed in the background are made and the rest wait for the user as proposals. One added through a token or MCP starts off.",
      params: [{ name: "fields", schema: fields_schema(true) }],
    },
    change_job: { description: "Changes a job's title, instruction, context, schedule, condition or limits.", params: [job_param, { name: "fields", schema: fields_schema(false) }] },
    remove_job: { description: "Removes a job; its runs and its conversation stay.", params: [job_param], destructive: true },
    set_job_on: {
      page_only: true,
      description: "Turns a job on or off. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [job_param, { name: "on", schema: { type: "boolean", description: "true to turn it on." } }],
    },
    run_job_now: {
      page_only: true,
      description: "Runs a job now, whatever its schedule, if background work is on and today's caps allow; answers once it has started. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [job_param],
    },
    set_background_device: {
      page_only: true,
      description:
        "Chooses the one device, a desktop app or a server, that runs background work: the assistant's jobs, the maintenance jobs and asking the apps what changed; every other device does none. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [{ name: "device_id", schema: text("The device's id, from get_background_state's devices.") }],
    },
    dismiss_job_runs: {
      description: "Sets runs that ended in an error or at a limit aside, so the Inbox no longer lists them; gives back how many.",
      params: [{ name: "ids", schema: { type: "array", items: { type: "string" }, description: "The runs' ids, from list_job_runs or list_inbox." } }],
    },
  },
  settings: settings_of(background_defaults, { user_only: true }),
});
