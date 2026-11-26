// The interests' table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A topic the assistant may research on the web for its own knowledge, proposed by it or added by the user, and
// researched only once the user accepted it.
export const interests = sqliteTable(
  "interests",
  {
    id: text().primaryKey(),
    // The exact text sent to a search engine, as the user accepted it.
    topic: text().notNull(),
    // Why, in the proposer's words.
    reason: text().notNull().default(""),
    // "proposed", "accepted", "paused" or "dropped".
    state: text().notNull(),
    // Who made it: "user", "engine" or "program"; with the engine and model for an engine's.
    made_by: text().notNull(),
    engine: text().notNull().default(""),
    model: text().notNull().default(""),
    // The conversation it came from, and the sources its run had read, as a JSON list of collector ids.
    conversation_id: text().notNull().default(""),
    sources: text().notNull().default("[]"),
    // The context its findings go in, made with the first one.
    context_id: text().notNull().default(""),
    // When a research run last looked into it; empty until one has.
    researched_at: text().notNull().default(""),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [index("interests_by_state").on(table.state)],
);

export const interest_tables = [interests];
