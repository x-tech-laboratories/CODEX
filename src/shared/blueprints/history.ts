// How History keeps a blueprint: its row and the contexts it applies in, so a deleted blueprint comes back where it was.
// Its uses and the changes proposed to it leave no version.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { HistoryWatch } from "@x-tech-laboratories/x-libs/history";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { insert_row } from "../graph/history.ts";
import { blueprint_item_id } from "./model.ts";
import { refresh_blueprint_items } from "./records.ts";

// ── Kind ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

export const blueprint_history = {
  kind: "blueprint",
  label: "Blueprint",
  item_table: "blueprints",
  watches: [{ table: "blueprints", item_columns: ["id"] }] as HistoryWatch[],
  read: (database: SqlDatabase, id: string): Snapshot | null => {
    const row = database.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const places = database.prepare("SELECT * FROM context_items WHERE item_id = ? ORDER BY context_id").all(blueprint_item_id(id)) as Row[];
    return { blueprints: [{ ...row }], context_items: places.map((place) => ({ ...place })) };
  },
  // A place in a context that is gone is left out.
  apply: (database: SqlDatabase, id: string, snapshot: Snapshot): void => {
    database.prepare("DELETE FROM blueprints WHERE id = ?").run(id);
    database.prepare("DELETE FROM context_items WHERE item_id = ?").run(blueprint_item_id(id));
    for (const row of snapshot.blueprints ?? []) insert_row(database, "blueprints", row);
    for (const place of snapshot.context_items ?? []) if (database.prepare("SELECT 1 FROM contexts WHERE id = ?").get(String(place.context_id))) insert_row(database, "context_items", place);
    refresh_blueprint_items(database, [id]);
  },
  name_of: (snapshot: Snapshot): string => String(snapshot.blueprints?.[0]?.title ?? "Blueprint"),
  summary: (snapshot: Snapshot): string => {
    const places = snapshot.context_items?.length ?? 0;
    return `${String(snapshot.blueprints?.[0]?.status ?? "")}, ${places === 0 ? "applies everywhere" : `in ${places} context${places === 1 ? "" : "s"}`}`;
  },
};
