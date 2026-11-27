// Reading and writing jobs, their runs and this device's own job settings.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, desc, eq, gte, inArray, like, ne, not } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { contexts } from "../contexts/schema.ts";
import { context_or_global } from "../contexts/model.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { settings_feature } from "../settings.ts";
import { background_defaults, background_settings, default_limits, maintenance_prefix, type BackgroundDevice, type Job, type JobFields, type JobLimits, type JobMaker, type JobRun, type JobRunOutcome, type JobSchedule } from "./model.ts";
import { checked_schedule, describe_schedule, next_due, start_of_day } from "./schedule.ts";
import { background_devices, job_checks, job_device, job_runs, jobs } from "./schema.ts";

// ── Checking ─────────────────────────────────────────────────────────────────

const longest_title = 120;
const longest_instruction = 4000;

function whole(value: unknown, least: number, most: number, what: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < least || number > most) throw new Error(`A job's ${what} is a whole number from ${least.toLocaleString("en")} to ${most.toLocaleString("en")}.`);
  return number;
}

export function checked_limits(given: Partial<JobLimits> | undefined, base: JobLimits = default_limits): JobLimits {
  return {
    max_rounds: whole(given?.max_rounds ?? base.max_rounds, 1, 20, "most rounds a run"),
    max_tokens: whole(given?.max_tokens ?? base.max_tokens, 1000, 1_000_000, "most tokens a run"),
    max_runs_per_day: whole(given?.max_runs_per_day ?? base.max_runs_per_day, 1, 288, "most runs a day"),
  };
}

export function checked_fields(database: SqlDatabase, given: Partial<JobFields>, base?: JobFields): JobFields {
  const title = String(given.title ?? base?.title ?? "").replace(/\s+/g, " ").trim();
  const instruction = String(given.instruction ?? base?.instruction ?? "").trim();
  if (!title) throw new Error("A job needs a title.");
  if (title.length > longest_title) throw new Error(`A job's title is at most ${longest_title} characters.`);
  if (!instruction) throw new Error("A job needs an instruction: what the assistant is to do each time.");
  if (instruction.length > longest_instruction) throw new Error(`A job's instruction is at most ${longest_instruction.toLocaleString("en")} characters.`);
  const context_id = given.context_id === undefined ? (base?.context_id ?? null) : given.context_id || null;
  if (context_id && !drizzle_of(database).select({ id: contexts.id }).from(contexts).where(eq(contexts.id, context_id)).get()) throw new Error(`There is no context ${context_id}.`);
  return {
    title,
    instruction,
    context_id,
    schedule: checked_schedule(given.schedule ?? base?.schedule),
    only_when_changed: Boolean(given.only_when_changed ?? base?.only_when_changed ?? false),
    limits: checked_limits(given.limits, base?.limits ?? default_limits),
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type JobRow = typeof jobs.$inferSelect;
type RunRow = typeof job_runs.$inferSelect;

export function job_row(database: SqlDatabase, id: string): JobRow {
  const row = drizzle_of(database).select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw new Error(`There is no job ${id}.`);
  return row;
}

export function schedule_of(row: JobRow): JobSchedule {
  try {
    return checked_schedule(JSON.parse(row.schedule));
  } catch {
    return { kind: "every", every: 1, unit: "days" };
  }
}

export function fields_of(row: JobRow): JobFields {
  return {
    title: row.title,
    instruction: row.instruction,
    context_id: row.context_id || null,
    schedule: schedule_of(row),
    only_when_changed: row.only_when_changed === 1,
    limits: { max_rounds: row.max_rounds, max_tokens: row.max_tokens, max_runs_per_day: row.max_runs_per_day },
  };
}

function strings(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export function as_run(row: RunRow): JobRun {
  const { context_mark: _mark, ...rest } = row;
  return { ...rest, applied: strings(row.applied), proposed: strings(row.proposed), outcome: row.outcome as JobRunOutcome };
}

// A job's runs, newest first.
export function runs_of(database: SqlDatabase, job_id: string, limit = 20): JobRun[] {
  return drizzle_of(database).select().from(job_runs).where(eq(job_runs.job_id, job_id)).orderBy(desc(job_runs.started_at)).limit(limit).all().map(as_run);
}

// When the job last ran or was checked unchanged here, or was made; a run that gave way does not count.
export function last_turn_at(database: SqlDatabase, row: JobRow): number {
  const db = drizzle_of(database);
  const ran = db.select({ at: job_runs.started_at }).from(job_runs).where(and(eq(job_runs.job_id, row.id), ne(job_runs.outcome, "gave_way"))).orderBy(desc(job_runs.started_at)).limit(1).get()?.at;
  const checked = db.select({ at: job_checks.checked_at }).from(job_checks).where(eq(job_checks.job_id, row.id)).get()?.at;
  return Math.max(Date.parse(row.created_at), ran ? Date.parse(ran) : 0, checked ? Date.parse(checked) : 0);
}

// What the job's context looked like at its last run or check, for "only when changed".
export function last_mark(database: SqlDatabase, job_id: string): string {
  const db = drizzle_of(database);
  const ran = db.select({ at: job_runs.started_at, mark: job_runs.context_mark }).from(job_runs).where(and(eq(job_runs.job_id, job_id), ne(job_runs.context_mark, ""))).orderBy(desc(job_runs.started_at)).limit(1).get();
  const checked = db.select().from(job_checks).where(eq(job_checks.job_id, job_id)).get();
  if (checked && (!ran || checked.checked_at > ran.at)) return checked.context_mark;
  return ran?.mark ?? "";
}

export function note_check(database: SqlDatabase, job_id: string, at: string, mark: string): void {
  drizzle_of(database).insert(job_checks).values({ job_id, checked_at: at, context_mark: mark }).onConflictDoUpdate({ target: job_checks.job_id, set: { checked_at: at, context_mark: mark } }).run();
}

// The runs started today that count against the caps: every one but those that gave way. Left without a job, the
// assistant's own jobs on every device together, the maintenance jobs, with budgets of their own, left out; a device
// given counts only its runs.
export function counted_today(database: SqlDatabase, now: number, job_id?: string, device?: string): { runs: number; tokens: number; rounds: number; items: number } {
  const since = new Date(start_of_day(now)).toISOString();
  const rows = drizzle_of(database)
    .select({ input: job_runs.input_tokens, output: job_runs.output_tokens, rounds: job_runs.rounds, items: job_runs.items })
    .from(job_runs)
    .where(and(gte(job_runs.started_at, since), ne(job_runs.outcome, "gave_way"), job_id ? eq(job_runs.job_id, job_id) : not(like(job_runs.job_id, `${maintenance_prefix}%`)), device ? eq(job_runs.device, device) : undefined))
    .all();
  return { runs: rows.length, tokens: rows.reduce((sum, row) => sum + row.input + row.output, 0), rounds: rows.reduce((sum, row) => sum + row.rounds, 0), items: rows.reduce((sum, row) => sum + row.items, 0) };
}

export function as_job(database: SqlDatabase, row: JobRow, now: number): Job {
  const fields = fields_of(row);
  const context_name = drizzle_of(database).select({ name: contexts.name }).from(contexts).where(eq(contexts.id, context_or_global(fields.context_id))).get()?.name ?? "";
  return {
    ...fields,
    id: row.id,
    is_on: row.is_on === 1,
    made_by: row.made_by as JobMaker,
    context_name,
    conversation_id: row.conversation_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    when: describe_schedule(fields.schedule),
    last_run: runs_of(database, row.id, 1)[0] ?? null,
    next_due_at: new Date(next_due(fields.schedule, last_turn_at(database, row))).toISOString(),
    runs_today: counted_today(database, now, row.id).runs,
  };
}

export function rows_with_ids(database: SqlDatabase, ids: string[]): RunRow[] {
  return ids.length === 0 ? [] : drizzle_of(database).select().from(job_runs).where(inArray(job_runs.id, ids)).all();
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function background_setting<Key extends keyof typeof background_settings>(database: SqlDatabase, key: Key): (typeof background_defaults)[(typeof background_settings)[Key]] {
  const name = background_settings[key];
  const saved = settings_feature.methods.get_settings(database)[name];
  const fallback = background_defaults[name];
  if (typeof fallback === "boolean") return (typeof saved === "boolean" ? saved : fallback) as never;
  if (typeof fallback === "string") return (typeof saved === "string" ? saved : fallback) as never;
  return (Number.isFinite(Number(saved)) && Number(saved) >= 0 && saved !== null && saved !== "" ? Number(saved) : fallback) as never;
}

// ── Devices ──────────────────────────────────────────────────────────────────

const device_id_key = "device_id";

// This device's own id, made once and kept in its own table, never synced.
export function device_id_of(database: SqlDatabase): string {
  const db = drizzle_of(database);
  const kept = db.select({ value: job_device.value }).from(job_device).where(eq(job_device.key, device_id_key)).get()?.value;
  if (kept) return kept;
  const id = new_id();
  db.insert(job_device).values({ key: device_id_key, value: id }).onConflictDoNothing().run();
  return db.select({ value: job_device.value }).from(job_device).where(eq(job_device.key, device_id_key)).get()!.value;
}

// A setting of this device alone, never synced, such as a model chosen over the one its configuration declares; empty when unset.
export function device_value(database: SqlDatabase, key: string): string {
  return drizzle_of(database).select({ value: job_device.value }).from(job_device).where(eq(job_device.key, key)).get()?.value ?? "";
}

// Sets a setting of this device alone; an empty value removes it.
export function set_device_value(database: SqlDatabase, key: string, value: string): void {
  const db = drizzle_of(database);
  if (!value) db.delete(job_device).where(eq(job_device.key, key)).run();
  else db.insert(job_device).values({ key, value }).onConflictDoUpdate({ target: job_device.key, set: { value } }).run();
}

// Says this device can run background work, under its name now; the first to start with none chosen becomes the one.
export function register_device(database: SqlDatabase, name: string, kind: BackgroundDevice["kind"], now: number): string {
  const id = device_id_of(database);
  const started_at = new Date(now).toISOString();
  drizzle_of(database).insert(background_devices).values({ id, name, kind, started_at }).onConflictDoUpdate({ target: background_devices.id, set: { name, kind, started_at } }).run();
  if (!background_setting(database, "device")) settings_feature.methods.set_setting(database, background_settings.device, id);
  return id;
}

export function list_devices(database: SqlDatabase): BackgroundDevice[] {
  return drizzle_of(database)
    .select()
    .from(background_devices)
    .orderBy(asc(background_devices.name), asc(background_devices.id))
    .all()
    .map((row) => ({ ...row, kind: row.kind === "server" ? "server" : "desktop" }));
}

// Whether this device is the one the user chose to run background work; every other device does none.
export function runs_here(database: SqlDatabase): boolean {
  const chosen = background_setting(database, "device");
  return chosen !== "" && chosen === device_id_of(database);
}

// Whether background work goes on at all now: not paused.
export function is_paused(database: SqlDatabase): boolean {
  return background_setting(database, "paused");
}
