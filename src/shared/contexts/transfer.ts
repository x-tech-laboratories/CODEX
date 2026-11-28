// Contexts and their items as one JSON file, written out and read back in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { drizzle_of } from "../feature.ts";
import { context_feeds, context_items, context_seeds, context_views, contexts, items } from "./schema.ts";
import { now } from "./records.ts";

// ── Import and export ────────────────────────────────────────────────────────

export interface ContextsExport {
  app: "codex";
  kind: "contexts";
  version: 1;
  exported_at: string;
  tables: {
    contexts: Record<string, unknown>[];
    items: Record<string, unknown>[];
    context_items: Record<string, unknown>[];
    context_feeds?: Record<string, unknown>[];
    context_views?: Record<string, unknown>[];
    context_seeds?: Record<string, unknown>[];
  };
}

export function export_contexts(database: SqlDatabase): ContextsExport {
  const db = drizzle_of(database);
  return {
    app: "codex",
    kind: "contexts",
    version: 1,
    exported_at: now(),
    tables: {
      contexts: db.select().from(contexts).all(),
      items: db.select().from(items).all(),
      context_items: db.select().from(context_items).all(),
      context_feeds: db.select().from(context_feeds).all(),
      context_views: db.select().from(context_views).all(),
      context_seeds: db.select().from(context_seeds).all(),
    },
  };
}

// The apps whose exports of contexts this one reads: its own, and X-Context's, which CODEX grew from.
const importable_apps: readonly string[] = ["codex", "x-context"];

// Adds every row of an export; a row already kept with the same id is replaced by the file's.
export function import_contexts(database: SqlDatabase, json: string): { contexts: number; items: number } {
  const file = JSON.parse(json) as Partial<Omit<ContextsExport, "app">> & { app?: string };
  if (!importable_apps.includes(file.app ?? "") || file.kind !== "contexts") throw new Error("This file is not a CODEX export of contexts.");
  if ((file.version ?? 0) > 1) throw new Error("This file was made by a newer CODEX; update the app first.");
  const tables = file.tables ?? { contexts: [], items: [], context_items: [] };
  in_transaction(database, () => {
    const db = drizzle_of(database);
    for (const row of tables.contexts) db.insert(contexts).values(row as typeof contexts.$inferInsert).onConflictDoUpdate({ target: contexts.id, set: row }).run();
    for (const row of tables.items) db.insert(items).values(row as typeof items.$inferInsert).onConflictDoUpdate({ target: items.id, set: row }).run();
    for (const row of tables.context_items) {
      db.insert(context_items)
        .values(row as typeof context_items.$inferInsert)
        .onConflictDoUpdate({ target: [context_items.context_id, context_items.item_id], set: row })
        .run();
    }
    for (const row of tables.context_feeds ?? []) {
      db.insert(context_feeds)
        .values(row as typeof context_feeds.$inferInsert)
        .onConflictDoUpdate({ target: [context_feeds.context_id, context_feeds.collector, context_feeds.feed_id], set: row })
        .run();
    }
    for (const row of tables.context_views ?? []) {
      db.insert(context_views).values(row as typeof context_views.$inferInsert).onConflictDoUpdate({ target: context_views.context_id, set: row }).run();
    }
    for (const row of tables.context_seeds ?? []) {
      db.insert(context_seeds).values(row as typeof context_seeds.$inferInsert).onConflictDoUpdate({ target: context_seeds.context_id, set: row }).run();
    }
  });
  return { contexts: tables.contexts.length, items: tables.items.length };
}
