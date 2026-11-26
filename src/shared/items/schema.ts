// The item calls' one table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { primaryKey, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// When each of CODEX's own items that History does not keep, such as a conversation, last changed as other apps see
// it: what it looked like then, and when that was first noticed. This device's alone, never synced.
export const item_marks = sqliteTable(
  "item_marks",
  {
    kind: text().notNull(),
    id: text().notNull(),
    // What other apps are told of it, as JSON, or "deleted".
    fingerprint: text().notNull(),
    changed_at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.id] })],
);
