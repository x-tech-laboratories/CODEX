// The action policy's tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A change an engine asked for that waits for the user to approve or reject it.
export const proposals = sqliteTable(
  "proposals",
  {
    id: text().primaryKey(),
    // The conversation it was proposed in: a context's id, or "general".
    conversation_id: text().notNull(),
    // The call, such as rename_context, and its arguments as a JSON object.
    method: text().notNull(),
    arguments: text().notNull().default("{}"),
    // What it would do, in plain words.
    summary: text().notNull(),
    // Why it waits: "level" when its level asks for approval, "outside content" when the run had read other apps' text.
    reason: text().notNull().default("level"),
    // The sources whose content the run that proposed it had read, or its summary names, as a JSON list of collector
    // ids; ["*"] when not recorded.
    sources: text().notNull().default('["*"]'),
    // "waiting", "approved", "rejected" or "failed".
    status: text().notNull().default("waiting"),
    // The call's answer as JSON once approved, or why it failed.
    result: text().notNull().default(""),
    created_at: text().notNull(),
    resolved_at: text().notNull().default(""),
  },
  (table) => [index("proposals_by_conversation").on(table.conversation_id, table.status)],
);

export const policy_tables = [proposals];
