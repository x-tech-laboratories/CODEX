// The privacy feature's table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// One run answered by a hosted engine: when, by which engine and model, and how many items of each source it was sent.
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
  },
  (table) => [index("hosted_sends_by_time").on(table.sent_at)],
);

export const privacy_tables = [hosted_sends];
