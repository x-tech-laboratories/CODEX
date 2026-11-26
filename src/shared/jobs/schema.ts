// The jobs' tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, primaryKey, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Synced ───────────────────────────────────────────────────────────────────

// The assistant's own recurring work: an instruction run on a schedule in a conversation of its own.
export const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  // The message each run sends, as if the user had typed it.
  instruction: text().notNull(),
  // The context it works in; empty for none.
  context_id: text().notNull().default(""),
  // When it runs, as JSON: { kind: "every", every, unit } or { kind: "at", time, weekdays }.
  schedule: text().notNull(),
  // 1 to run only when something in its context changed since its last run.
  only_when_changed: integer().notNull().default(0),
  max_rounds: integer().notNull(),
  max_tokens: integer().notNull(),
  max_runs_per_day: integer().notNull(),
  is_on: integer().notNull().default(1),
  // "user", "engine" or "program".
  made_by: text().notNull(),
  // The conversation its runs are kept in; empty before its first run.
  conversation_id: text().notNull().default(""),
  created_at: text().notNull(),
  updated_at: text().notNull(),
});

// Each run of a job, wherever it ran: what it used, applied and proposed, and how it ended.
export const job_runs = sqliteTable(
  "job_runs",
  {
    id: text().primaryKey(),
    job_id: text().notNull(),
    title: text().notNull().default(""),
    started_at: text().notNull(),
    ended_at: text().notNull().default(""),
    device: text().notNull().default(""),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    rounds: integer().notNull().default(0),
    input_tokens: integer().notNull().default(0),
    output_tokens: integer().notNull().default(0),
    // JSON lists of plain sentences.
    applied: text().notNull().default("[]"),
    proposed: text().notNull().default("[]"),
    // "running", "done", "error", "limit" or "gave_way".
    outcome: text().notNull().default("running"),
    note: text().notNull().default(""),
    conversation_id: text().notNull().default(""),
    run_id: text().notNull().default(""),
    // What its context looked like when it ran, for "only when changed".
    context_mark: text().notNull().default(""),
    dismissed_at: text().notNull().default(""),
    // How many things a maintenance job's run handled, such as documents indexed or links ended; 0 for an assistant job.
    items: integer().notNull().default(0),
  },
  (table) => [index("job_runs_by_job").on(table.job_id, table.started_at)],
);

// Each device that can run background work, a desktop daemon or a server, as it last said of itself when it started.
export const background_devices = sqliteTable("background_devices", {
  id: text().primaryKey(),
  name: text().notNull(),
  // "desktop" or "server".
  kind: text().notNull(),
  started_at: text().notNull(),
});

export const job_tables = [jobs, job_runs, background_devices];

// ── This device's own ────────────────────────────────────────────────────────

// Settings of this device alone, never synced, such as whether it is the one that runs jobs.
export const job_device = sqliteTable("job_device", {
  key: text().primaryKey(),
  value: text().notNull(),
});

// Each time this device found a job's context unchanged and so made no call, so it waits for the next time.
export const job_checks = sqliteTable(
  "job_checks",
  {
    job_id: text().notNull(),
    checked_at: text().notNull(),
    context_mark: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.job_id] })],
);
