// How History keeps the graph: an entity's versions hold its row and its links, so a removed entity comes back with
// them; a link's versions hold its row and what its ends were called, so a removed link can come back while both
// ends exist.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { HistoryWatch } from "@x-tech-laboratories/x-libs/history";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { node_key, type NodeKind } from "./model.ts";
import { read_nodes } from "./records.ts";

// ── Snapshots ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

const entity_links = "SELECT * FROM graph_links WHERE (from_kind = 'entity' AND from_id = ?) OR (to_kind = 'entity' AND to_id = ?) ORDER BY id";

export function insert_row(database: SqlDatabase, table: string, row: Row): void {
  const existing = new Set((database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((column) => column.name));
  const columns = Object.keys(row).filter((column) => existing.has(column));
  database.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...(columns.map((column) => row[column]) as never[]));
}

// Whether a link's ends both exist, so putting it back never leaves a link to nothing.
export function link_ends_exist(database: SqlDatabase, row: Row): boolean {
  const keys = [node_key(row.from_kind as NodeKind, String(row.from_id)), node_key(row.to_kind as NodeKind, String(row.to_id))];
  const found = read_nodes(database, keys);
  return keys.every((key) => found.has(key));
}

// ── Kinds ────────────────────────────────────────────────────────────────────

export interface GraphHistoryKind {
  kind: string;
  label: string;
  item_table: string;
  watches: HistoryWatch[];
  read: (database: SqlDatabase, item_id: string) => Snapshot | null;
  apply: (database: SqlDatabase, item_id: string, snapshot: Snapshot) => void;
  name_of: (snapshot: Snapshot) => string;
  summary: (snapshot: Snapshot) => string;
}

export const entity_history: GraphHistoryKind = {
  kind: "entity",
  label: "Entity",
  item_table: "graph_entities",
  // A link noted by an end that is not an entity reads as nothing here, and keeps no version.
  watches: [
    { table: "graph_entities", item_columns: ["id"] },
    { table: "graph_links", item_columns: ["from_id", "to_id"] },
  ],
  read: (database, id) => {
    const row = database.prepare("SELECT * FROM graph_entities WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return { graph_entities: [{ ...row }], graph_links: (database.prepare(entity_links).all(id, id) as Row[]).map((link) => ({ ...link })) };
  },
  apply: (database, id, snapshot) => {
    database.prepare("DELETE FROM graph_links WHERE (from_kind = 'entity' AND from_id = ?) OR (to_kind = 'entity' AND to_id = ?)").run(id, id);
    database.prepare("DELETE FROM graph_entities WHERE id = ?").run(id);
    for (const row of snapshot.graph_entities ?? []) insert_row(database, "graph_entities", row);
    for (const row of snapshot.graph_links ?? []) if (link_ends_exist(database, row)) insert_row(database, "graph_links", row);
  },
  name_of: (snapshot) => String(snapshot.graph_entities?.[0]?.name ?? "Entity"),
  summary: (snapshot) => {
    const total = snapshot.graph_links?.length ?? 0;
    return `${String(snapshot.graph_entities?.[0]?.kind ?? "entity")}, ${total} link${total === 1 ? "" : "s"}`;
  },
};

export const link_history: GraphHistoryKind = {
  kind: "link",
  label: "Link",
  item_table: "graph_links",
  watches: [{ table: "graph_links", item_columns: ["id"] }],
  read: (database, id) => {
    const row = database.prepare("SELECT * FROM graph_links WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const keys = [node_key(row.from_kind as NodeKind, String(row.from_id)), node_key(row.to_kind as NodeKind, String(row.to_id))];
    const found = read_nodes(database, keys);
    return { graph_links: [{ ...row }], ends: keys.map((key) => ({ key, label: found.get(key)?.label ?? "" })) };
  },
  apply: (database, id, snapshot) => {
    const row = snapshot.graph_links?.[0];
    if (!row) return;
    if (!link_ends_exist(database, row)) throw new Error("One end of this link no longer exists, so it cannot come back.");
    database.prepare("DELETE FROM graph_links WHERE id = ?").run(id);
    insert_row(database, "graph_links", row);
  },
  name_of: (snapshot) => {
    const [from, to] = snapshot.ends ?? [];
    return `${String(from?.label || "?")} → ${String(to?.label || "?")}`;
  },
  summary: (snapshot) => {
    const row = snapshot.graph_links?.[0];
    return row ? `${String(row.type).replace("_", " ")}${row.label ? ` (${String(row.label)})` : ""}, ${String(row.status)}${row.valid_until ? ", closed" : ""}` : "";
  },
};
