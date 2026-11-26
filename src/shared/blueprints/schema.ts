// The blueprints' tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A workflow the user taught: when it applies, and its rules and ordered steps. It is an item of kind "blueprint" in
// the contexts it applies in, or in none when it applies everywhere.
export const blueprints = sqliteTable(
  "blueprints",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    // A short description its recall matches the user's message against.
    applies_when: text().notNull().default(""),
    // The rules and the ordered steps, in Markdown.
    body: text().notNull().default(""),
    // "proposed", "active" or "retired".
    status: text().notNull(),
    // Who wrote it: "user", "engine" or "program"; with the engine and model for an engine's.
    made_by: text().notNull(),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    // The sources whose content the run that wrote it had read, as a JSON list of collector ids; [] once the user made it theirs.
    sources: text().notNull().default("[]"),
    // The conversation it was proposed in; empty for one the user wrote.
    conversation_id: text().notNull().default(""),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [index("blueprints_by_status").on(table.status)],
);

// A new version of a blueprint an engine or a program proposed, waiting for the user or decided.
export const blueprint_changes = sqliteTable(
  "blueprint_changes",
  {
    id: text().primaryKey(),
    blueprint_id: text().notNull(),
    title: text().notNull(),
    applies_when: text().notNull().default(""),
    body: text().notNull().default(""),
    // Why it would change, in the proposer's words.
    reason: text().notNull().default(""),
    // "waiting", "accepted" or "rejected".
    status: text().notNull().default("waiting"),
    made_by: text().notNull(),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    sources: text().notNull().default("[]"),
    conversation_id: text().notNull().default(""),
    created_at: text().notNull(),
    decided_at: text().notNull().default(""),
  },
  (table) => [index("blueprint_changes_by_blueprint").on(table.blueprint_id, table.status)],
);

// Each time a run was given a blueprint to follow, kept apart from the blueprint so a use leaves no version in History.
export const blueprint_uses = sqliteTable(
  "blueprint_uses",
  {
    id: text().primaryKey(),
    blueprint_id: text().notNull(),
    conversation_id: text().notNull().default(""),
    run_id: text().notNull().default(""),
    used_at: text().notNull(),
  },
  (table) => [index("blueprint_uses_by_blueprint").on(table.blueprint_id, table.used_at)],
);

export const blueprint_tables = [blueprints, blueprint_changes, blueprint_uses];
