// The privacy feature's table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// One run answered by a hosted engine: when, by which engine and model, and how many items of each source it was sent;
// or one use of a tool that sends outside, with the engine that asked for it.
export const hosted_sends = sqliteTable(
  "hosted_sends",
  {
    id: text().primaryKey(),
    run_id: text().notNull(),
    // The conversation it answered in: a context's id, or "general".
    conversation_id: text().notNull(),
    engine: text().notNull(),
    model: text().notNull(),
    // Items sent and items withheld, as JSON lists of { collector, label, count }; never the items themselves.
    included: text().notNull().default("[]"),
    withheld: text().notNull().default("[]"),
    // How many items were sent in all, for reading the log at a glance.
    item_count: integer().notNull().default(0),
    sent_at: text().notNull(),
    // A reply written by a hosted engine, or one use of a plugin tool that sends its arguments outside this machine.
    kind: text().notNull().default("reply"),
    // For a tool's use: the tool by its plugin's label and its own name, and how many arguments of how many characters went; never the arguments.
    tool: text().notNull().default(""),
    argument_count: integer().notNull().default(0),
    argument_chars: integer().notNull().default(0),
  },
  (table) => [index("hosted_sends_by_time").on(table.sent_at)],
);

export const privacy_tables = [hosted_sends];
