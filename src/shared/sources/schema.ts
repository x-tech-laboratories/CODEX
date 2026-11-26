// The item sources' tables, from which drizzle-kit writes the migrations and the store reads its row types.

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

// When each item last changed as its app gave it, so its text is read again only once that moved; this device's alone,
// like the index it feeds, and never the text itself.
export const item_source_stamps = sqliteTable("item_source_stamps", {
  // The kept item's id, its collector and its id in the app.
  item_id: text().primaryKey(),
  source_id: text().notNull(),
  changed_at: text().notNull(),
});
