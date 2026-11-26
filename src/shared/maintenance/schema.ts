// The maintenance jobs' tables, from which drizzle-kit writes the migrations and the store reads its row types. Their
// runs are kept with the assistant's jobs' runs, in job_runs.

// ── Imports ──────────────────────────────────────────────────────────────────

import { integer, primaryKey, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Synced ───────────────────────────────────────────────────────────────────

// What each device last found when one of the jobs looked for work, so every device shows what the one doing it found.
export const maintenance_checks = sqliteTable(
  "maintenance_checks",
  {
    job: text().notNull(),
    device: text().notNull(),
    checked_at: text().notNull(),
    // The local day the counts below are for, such as 2026-11-27.
    day: text().notNull(),
    // How many times that day it looked and found nothing to do.
    skips: integer().notNull().default(0),
    // Why it last did nothing, and when; empty once it ran.
    skip_reason: text().notNull().default(""),
    skipped_at: text().notNull().default(""),
    // The part of its budget used up that day, in plain words; empty while it may run.
    used_up: text().notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.job, table.device] })],
);

// What each context held when Suggest links last ran on it in the background, and the conversation it ran in.
export const maintenance_contexts = sqliteTable("maintenance_contexts", {
  context_id: text().primaryKey(),
  context_mark: text().notNull(),
  conversation_id: text().notNull().default(""),
  suggested_at: text().notNull(),
});

export const maintenance_tables = [maintenance_checks, maintenance_contexts];
