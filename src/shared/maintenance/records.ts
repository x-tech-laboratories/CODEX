// Reading and writing what the maintenance jobs keep: each job's switch and budget from the synced setting, what each
// device found when it last looked, today's use from the runs, and the runs themselves beside the assistant's jobs'.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, desc, eq, gte, like, lt } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of, new_id } from "../feature.ts";
import { maintenance_prefix, type JobRun, type JobRunOutcome } from "../jobs/model.ts";
import { as_run, background_setting, counted_today, list_devices } from "../jobs/records.ts";
import { start_of_day } from "../jobs/schedule.ts";
import { job_runs } from "../jobs/schema.ts";
import { read_setting } from "../settings.ts";
import { budget_bounds, is_maintenance_key, maintenance_jobs, maintenance_setting, type BudgetName, type MaintenanceBudget, type MaintenanceJobSetting, type MaintenanceKey, type MaintenanceUse } from "./model.ts";
import { maintenance_checks } from "./schema.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

export function stored_job_settings(database: SqlDatabase): Partial<Record<MaintenanceKey, MaintenanceJobSetting>> {
  const saved = read_setting(database, maintenance_setting);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved as Record<string, unknown>).filter(([key, value]) => is_maintenance_key(key) && value && typeof value === "object")) as Partial<Record<MaintenanceKey, MaintenanceJobSetting>>;
}

// A budget's part as set, or the job's default when what is set is not a whole number within its bounds.
function part_of(given: unknown, name: BudgetName, fallback: number): number {
  const [least, most] = budget_bounds[name];
  const number = Number(given);
  return given !== undefined && given !== null && Number.isInteger(number) && number >= least && number <= most ? number : fallback;
}

export function job_on(database: SqlDatabase, key: MaintenanceKey): boolean {
  const on = stored_job_settings(database)[key]?.on;
  return typeof on === "boolean" ? on : maintenance_jobs[key].default_on;
}

export function budget_of(database: SqlDatabase, key: MaintenanceKey): MaintenanceBudget {
  const given = stored_job_settings(database)[key]?.budget ?? {};
  const fallback = maintenance_jobs[key].default_budget;
  return Object.fromEntries((Object.keys(fallback) as BudgetName[]).map((name) => [name, part_of(given[name], name, fallback[name])])) as unknown as MaintenanceBudget;
}

// A budget change checked against its bounds, saying plainly what is wrong.
export function checked_budget(given: unknown): Partial<MaintenanceBudget> {
  if (given === undefined || given === null) return {};
  if (typeof given !== "object" || Array.isArray(given)) throw new Error("A budget is an object, such as { runs_per_day: 12 }.");
  const checked: Partial<MaintenanceBudget> = {};
  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    if (!(name in budget_bounds)) throw new Error(`A budget holds ${Object.keys(budget_bounds).join(", ")}; not ${name}.`);
    const [least, most] = budget_bounds[name as BudgetName];
    const number = Number(value);
    if (!Number.isInteger(number) || number < least || number > most) throw new Error(`${name} is a whole number from ${least.toLocaleString("en")} to ${most.toLocaleString("en")}.`);
    checked[name as BudgetName] = number;
  }
  return checked;
}

// ── Days ─────────────────────────────────────────────────────────────────────

// The local day holding the moment given, such as 2026-11-27.
export function day_of(now: number): string {
  const day = new Date(start_of_day(now));
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export function job_id_of(key: MaintenanceKey): string {
  return `${maintenance_prefix}${key}`;
}

// Today's use of one job: on this device for a job every device runs, else on every device together.
export function use_today(database: SqlDatabase, key: MaintenanceKey, now: number, device: string): MaintenanceUse {
  const counted = counted_today(database, now, job_id_of(key), maintenance_jobs[key].where === "every" ? device : undefined);
  return { runs: counted.runs, items: counted.items, model_calls: counted.rounds, tokens: counted.tokens };
}

// How long a maintenance job's runs are kept.
export const keep_runs_days = 30;

export interface RunValues {
  ended_at: string;
  items: number;
  applied: string[];
  proposed: string[];
  outcome: JobRunOutcome;
  note: string;
  engine?: string;
  model?: string;
  rounds?: number;
  input_tokens?: number;
  output_tokens?: number;
  conversation_id?: string;
  run_id?: string;
}

export function start_run_record(database: SqlDatabase, key: MaintenanceKey, device: string, now: number): string {
  const id = new_id();
  drizzle_of(database).insert(job_runs).values({ id, job_id: job_id_of(key), title: maintenance_jobs[key].title, started_at: new Date(now).toISOString(), device }).run();
  return id;
}

// Ends a run's record, and lets go of the maintenance runs older than the days kept.
export function finish_run_record(database: SqlDatabase, id: string, values: RunValues, now: number): void {
  const db = drizzle_of(database);
  db.update(job_runs)
    .set({ ...values, applied: JSON.stringify(values.applied), proposed: JSON.stringify(values.proposed) })
    .where(eq(job_runs.id, id))
    .run();
  db.delete(job_runs)
    .where(and(like(job_runs.job_id, `${maintenance_prefix}%`), lt(job_runs.started_at, new Date(now - keep_runs_days * 86_400_000).toISOString())))
    .run();
}

export function last_run_of(database: SqlDatabase, key: MaintenanceKey, device?: string): JobRun | null {
  const row = drizzle_of(database)
    .select()
    .from(job_runs)
    .where(and(eq(job_runs.job_id, job_id_of(key)), device ? eq(job_runs.device, device) : undefined))
    .orderBy(desc(job_runs.started_at))
    .limit(1)
    .get();
  return row ? as_run(row) : null;
}

// The maintenance runs started at or after the moment given, newest first.
export function runs_since(database: SqlDatabase, since: string): JobRun[] {
  return drizzle_of(database)
    .select()
    .from(job_runs)
    .where(and(like(job_runs.job_id, `${maintenance_prefix}%`), gte(job_runs.started_at, since)))
    .orderBy(desc(job_runs.started_at))
    .all()
    .map(as_run);
}

// ── Checks ───────────────────────────────────────────────────────────────────

export type CheckRow = typeof maintenance_checks.$inferSelect;

export function check_of(database: SqlDatabase, key: MaintenanceKey, device: string): CheckRow | null {
  return drizzle_of(database).select().from(maintenance_checks).where(and(eq(maintenance_checks.job, key), eq(maintenance_checks.device, device))).get() ?? null;
}

export function checks_of(database: SqlDatabase): CheckRow[] {
  return drizzle_of(database).select().from(maintenance_checks).all();
}

// Notes that the job looked and did nothing, and why; the day's count of such looks goes up by one.
export function note_skip(database: SqlDatabase, key: MaintenanceKey, device: string, reason: string, now: number, used_up = ""): void {
  const at = new Date(now).toISOString();
  const day = day_of(now);
  const was = check_of(database, key, device);
  const skips = was && was.day === day ? was.skips + 1 : 1;
  const values = { checked_at: at, day, skips, skip_reason: reason, skipped_at: at, used_up };
  drizzle_of(database)
    .insert(maintenance_checks)
    .values({ job: key, device, ...values })
    .onConflictDoUpdate({ target: [maintenance_checks.job, maintenance_checks.device], set: values })
    .run();
}

// Notes that the job looked and found work, which it ran.
export function note_ran(database: SqlDatabase, key: MaintenanceKey, device: string, now: number): void {
  const at = new Date(now).toISOString();
  const day = day_of(now);
  const was = check_of(database, key, device);
  const values = { checked_at: at, day, skips: was && was.day === day ? was.skips : 0, skip_reason: "", skipped_at: "", used_up: "" };
  drizzle_of(database)
    .insert(maintenance_checks)
    .values({ job: key, device, ...values })
    .onConflictDoUpdate({ target: [maintenance_checks.job, maintenance_checks.device], set: values })
    .run();
}

// The device whose checks and runs a job shows: this one for a job every device runs, else the one chosen.
export function shown_device(database: SqlDatabase, key: MaintenanceKey, own_name: string): string {
  if (maintenance_jobs[key].where === "every") return own_name;
  const chosen = background_setting(database, "device");
  return list_devices(database).find((device) => device.id === chosen)?.name ?? "";
}
