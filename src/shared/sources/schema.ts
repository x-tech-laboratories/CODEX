// The item sources' one table, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// How far each app's changes have been read, so a refresh asks only for what changed since; this device's alone,
// since each device refreshes on its own.
export const item_source_cursors = sqliteTable("item_source_cursors", {
  source_id: text().primaryKey(),
  // The changed_at of the last change read, as the app gave it.
  cursor: text().notNull(),
  updated_at: text().notNull(),
});
