// The context tables, from which drizzle-kit writes the migrations and the store reads its row types.

// ── Imports ──────────────────────────────────────────────────────────────────

import { index, integer, primaryKey, real, sqliteTable, text } from "@x-tech-laboratories/x-libs/drizzle";

// ── Tables ───────────────────────────────────────────────────────────────────

// A project or area of life that gathers items from other apps; contexts nest.
export const contexts = sqliteTable(
  "contexts",
  {
    id: text().primaryKey(),
    parent_id: text(),
    name: text().notNull(),
    // What the context is about, in Markdown.
    notes: text().notNull().default(""),
    position: real().notNull().default(0),
    is_archived: integer().notNull().default(0),
    created_at: text().notNull(),
  },
  (table) => [index("contexts_by_parent").on(table.parent_id)],
);

// A pointer to something another app keeps, with what was last seen of it; the id is the collector and the source's own id.
export const items = sqliteTable(
  "items",
  {
    id: text().primaryKey(),
    // The collector plugin's provider id, such as "x-tasks" or "email".
    collector: text().notNull(),
    // The item's id in its own app, such as a task id or an email's Message-ID.
    source_id: text().notNull(),
    // What it is, such as "task", "note", "file", "email" or "link".
    kind: text().notNull(),
    title: text().notNull(),
    snippet: text().notNull().default(""),
    // Where it opens, such as x-tasks://task/<id>, a file:// path or a web address.
    uri: text().notNull().default(""),
    // A short state from the source, such as "done"; "missing" once the source no longer has it.
    status: text().notNull().default(""),
    // Other facts from the source as a JSON object of text, such as an email's sender.
    detail: text().notNull().default("{}"),
    // When the collector last answered for it, as an ISO timestamp; empty for never.
    seen_at: text().notNull().default(""),
    created_at: text().notNull(),
  },
  (table) => [index("items_by_collector").on(table.collector)],
);

// An item's place in a context, with the user's note on why it is there.
export const context_items = sqliteTable(
  "context_items",
  {
    context_id: text()
      .notNull()
      .references(() => contexts.id, { onDelete: "cascade" }),
    item_id: text()
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    note: text().notNull().default(""),
    position: real().notNull().default(0),
    added_at: text().notNull(),
    // The feed that brought it, as the collector and feed id such as "x-tasks:tag:<id>"; empty for one added by hand.
    via: text().notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.context_id, table.item_id] }), index("context_items_by_item").on(table.item_id)],
);

// A group in another app that a context follows, such as an X-Tasks tag, whose items come and go with it.
export const context_feeds = sqliteTable(
  "context_feeds",
  {
    context_id: text()
      .notNull()
      .references(() => contexts.id, { onDelete: "cascade" }),
    collector: text().notNull(),
    feed_id: text().notNull(),
    label: text().notNull(),
    added_at: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.context_id, table.collector, table.feed_id] })],
);

// How a context's page shows its items, kept apart from the context so moving a card leaves no version in History.
export const context_views = sqliteTable("context_views", {
  context_id: text()
    .primaryKey()
    .references(() => contexts.id, { onDelete: "cascade" }),
  // "list" or "cards".
  view: text().notNull().default("list"),
  // Each card's place in the grid as a JSON list of { id, x, y, w, h }, by item id.
  card_places: text().notNull().default("[]"),
});

// The larger group in another app a context's children were made from, such as an X-Tasks filter group, so feeds
// added to it later can be offered as new children.
export const context_seeds = sqliteTable("context_seeds", {
  context_id: text()
    .primaryKey()
    .references(() => contexts.id, { onDelete: "cascade" }),
  collector: text().notNull(),
  group_id: text().notNull(),
  label: text().notNull(),
  added_at: text().notNull(),
});

// Parents first, as sync applies them.
export const context_tables = [contexts, items, context_items, context_feeds, context_views, context_seeds];
