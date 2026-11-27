// The blueprints themselves and the items that stand for them: each is an item of kind "blueprint" in the contexts it
// applies in, Global when it applies everywhere, kept up to date here so every view, search, History and "also in"
// treat it like any other item.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, desc, eq, inArray, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_or_global, global_context_id } from "../contexts/model.ts";
import { context_items, contexts, items } from "../contexts/schema.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import {
  blueprint_collector,
  blueprint_item_id,
  blueprint_kind,
  blueprint_link,
  type Blueprint,
  type BlueprintChange,
  type BlueprintMaker,
  type BlueprintStatus,
  type BlueprintSummary,
  type ChangeStatus,
} from "./model.ts";
import { blueprint_changes, blueprint_uses, blueprints } from "./schema.ts";

// ── Limits ───────────────────────────────────────────────────────────────────

export const longest_title = 120;
export const longest_applies_when = 400;
export const longest_body = 20_000;

function checked(text: unknown, longest: number, what: string, required = false): string {
  const value = String(text ?? "").trim();
  if (required && !value) throw new Error(`A blueprint needs ${what}.`);
  if (value.length > longest) throw new Error(`A blueprint's ${what} is at most ${longest.toLocaleString("en")} characters.`);
  return value;
}

// The text given, checked: a title, when it applies, and the body.
export function checked_text(text: { title?: unknown; applies_when?: unknown; body?: unknown }): { title: string; applies_when: string; body: string } {
  return {
    title: checked(text.title, longest_title, "a title", true).replace(/\s+/g, " "),
    applies_when: checked(text.applies_when, longest_applies_when, "when it applies", true).replace(/\s+/g, " "),
    body: checked(text.body, longest_body, "body with its rules and steps", true),
  };
}

export function now(): string {
  return new Date().toISOString();
}

// ── Reading ──────────────────────────────────────────────────────────────────

export type BlueprintRow = typeof blueprints.$inferSelect;

export function blueprint_row(database: SqlDatabase, id: string): BlueprintRow {
  const row = drizzle_of(database).select().from(blueprints).where(eq(blueprints.id, id)).get();
  if (!row) throw new Error(`There is no blueprint ${id}.`);
  return row;
}

export function has_blueprint(database: SqlDatabase, id: string): boolean {
  return drizzle_of(database).select({ id: blueprints.id }).from(blueprints).where(eq(blueprints.id, id)).get() !== undefined;
}

// The contexts holding each blueprint, by blueprint id, by name.
function holders_of(database: SqlDatabase, ids: string[]): Map<string, { id: string; name: string }[]> {
  const holders = new Map<string, { id: string; name: string }[]>();
  if (ids.length === 0) return holders;
  const rows = drizzle_of(database)
    .select({ item_id: context_items.item_id, id: contexts.id, name: contexts.name })
    .from(context_items)
    .innerJoin(contexts, eq(contexts.id, context_items.context_id))
    .where(inArray(context_items.item_id, ids.map(blueprint_item_id)))
    .orderBy(asc(contexts.name))
    .all();
  for (const row of rows) {
    const id = row.item_id.slice(blueprint_collector.length + 1);
    holders.set(id, [...(holders.get(id) ?? []), { id: row.id, name: row.name }]);
  }
  return holders;
}

// How often and when each blueprint was last used, by blueprint id.
function uses_of(database: SqlDatabase, ids: string[]): Map<string, { count: number; last: string }> {
  if (ids.length === 0) return new Map();
  const rows = drizzle_of(database)
    .select({ id: blueprint_uses.blueprint_id, count: sql<number>`count(*)`, last: sql<string>`max(${blueprint_uses.used_at})` })
    .from(blueprint_uses)
    .where(inArray(blueprint_uses.blueprint_id, ids))
    .groupBy(blueprint_uses.blueprint_id)
    .all();
  return new Map(rows.map((row) => [row.id, { count: Number(row.count), last: row.last ?? "" }]));
}

function waiting_of(database: SqlDatabase, ids: string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  const rows = drizzle_of(database)
    .select({ id: blueprint_changes.blueprint_id, count: sql<number>`count(*)` })
    .from(blueprint_changes)
    .where(and(inArray(blueprint_changes.blueprint_id, ids), eq(blueprint_changes.status, "waiting")))
    .groupBy(blueprint_changes.blueprint_id)
    .all();
  return new Map(rows.map((row) => [row.id, Number(row.count)]));
}

// The blueprints with these ids as summaries, in the order of the rows given.
export function summaries_of(database: SqlDatabase, rows: BlueprintRow[]): BlueprintSummary[] {
  const ids = rows.map((row) => row.id);
  const holders = holders_of(database, ids);
  const uses = uses_of(database, ids);
  const waiting = waiting_of(database, ids);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    applies_when: row.applies_when,
    status: row.status as BlueprintStatus,
    made_by: row.made_by as BlueprintMaker,
    engine: row.engine,
    model: row.model,
    contexts: holders.get(row.id) ?? [],
    sources: parse_sources(row.sources),
    conversation_id: row.conversation_id,
    use_count: uses.get(row.id)?.count ?? 0,
    last_used_at: uses.get(row.id)?.last ?? "",
    waiting_changes: waiting.get(row.id) ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    link: blueprint_link(row.id),
  }));
}

export function as_change(row: typeof blueprint_changes.$inferSelect): BlueprintChange {
  return { ...row, status: row.status as ChangeStatus, made_by: row.made_by as BlueprintMaker, sources: parse_sources(row.sources) };
}

export function changes_of(database: SqlDatabase, blueprint_id: string): BlueprintChange[] {
  return drizzle_of(database).select().from(blueprint_changes).where(eq(blueprint_changes.blueprint_id, blueprint_id)).orderBy(desc(blueprint_changes.created_at), asc(blueprint_changes.id)).all().map(as_change);
}

export function blueprint_of(database: SqlDatabase, id: string): Blueprint {
  const row = blueprint_row(database, id);
  return { ...summaries_of(database, [row])[0]!, body: row.body, changes: changes_of(database, id) };
}

// The ids of the blueprints a context holds, Global's for null: those apply everywhere.
export function blueprint_ids_in(database: SqlDatabase, context_id: string | null): string[] {
  const held = drizzle_of(database)
    .select({ item_id: context_items.item_id })
    .from(context_items)
    .where(and(eq(context_items.context_id, context_or_global(context_id)), sql`${context_items.item_id} LIKE ${`${blueprint_collector}:%`}`))
    .all();
  return held.map((row) => row.item_id.slice(blueprint_collector.length + 1));
}

// The context and every context above it, nearest first, Global last; one with no parent synced in sits under Global.
export function context_and_above(database: SqlDatabase, context_id: string): string[] {
  const rows = drizzle_of(database).select({ id: contexts.id, parent_id: contexts.parent_id }).from(contexts).all();
  const parent_of = new Map(rows.map((row) => [row.id, row.id === global_context_id ? null : (row.parent_id ?? global_context_id)]));
  if (!parent_of.has(context_id)) throw new Error(`There is no context ${context_id}.`);
  const path: string[] = [];
  for (let at: string | null | undefined = context_id; at && !path.includes(at); at = parent_of.get(at)) path.push(at);
  return path;
}

// The blueprints that apply in a context: its own and those of the contexts above it, up to Global's, which apply
// everywhere; for null, only Global's.
export function blueprint_ids_applying(database: SqlDatabase, context_id: string | null): string[] {
  const places = context_and_above(database, context_or_global(context_id));
  return [...new Set([...places.flatMap((place) => blueprint_ids_in(database, place)), ...blueprint_ids_in(database, null)])];
}

export function rows_of(database: SqlDatabase, ids: string[] | null, status?: BlueprintStatus): BlueprintRow[] {
  if (ids !== null && ids.length === 0) return [];
  const where = and(ids === null ? undefined : inArray(blueprints.id, ids), status ? eq(blueprints.status, status) : undefined);
  return drizzle_of(database).select().from(blueprints).where(where).orderBy(asc(blueprints.title), asc(blueprints.id)).all();
}

// ── Items ────────────────────────────────────────────────────────────────────

// Each blueprint as its item: its title, when it applies, where it opens, its status when not active, and the sources
// a proposed one carries, so screening can hold it back from a hosted engine.
export function found_blueprint_items(database: SqlDatabase, ids: string[]) {
  const rows = rows_of(database, ids);
  const uses = uses_of(database, ids);
  return Object.fromEntries(
    rows.map((row) => {
      const sources = parse_sources(row.sources);
      const detail: Record<string, string> = { uses: String(uses.get(row.id)?.count ?? 0), ...(uses.get(row.id)?.last ? { last_used_at: uses.get(row.id)!.last } : {}), ...(sources.length ? { sources: JSON.stringify(sources) } : {}) };
      return [row.id, { source_id: row.id, kind: blueprint_kind, title: row.title, snippet: row.applies_when, uri: blueprint_link(row.id), status: row.status === "active" ? "" : row.status, detail }];
    }),
  );
}

// Writes each blueprint's item as it is now; one that no longer exists keeps its item, marked missing, so History can
// still put a context back with it.
export function refresh_blueprint_items(database: SqlDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const found = found_blueprint_items(database, ids);
  const at = now();
  const db = drizzle_of(database);
  for (const id of ids) {
    const item = found[id];
    const item_id = blueprint_item_id(id);
    if (!item) {
      db.update(items).set({ status: "missing", snippet: "Deleted.", seen_at: at }).where(eq(items.id, item_id)).run();
      continue;
    }
    const values = { kind: item.kind, title: item.title, snippet: item.snippet, uri: item.uri, status: item.status, detail: JSON.stringify(item.detail) };
    const kept = db.select({ title: items.title, snippet: items.snippet, status: items.status, detail: items.detail, uri: items.uri }).from(items).where(eq(items.id, item_id)).get();
    if (kept && kept.title === values.title && kept.snippet === values.snippet && kept.status === values.status && kept.detail === values.detail && kept.uri === values.uri) continue;
    db.insert(items)
      .values({ id: item_id, collector: blueprint_collector, source_id: id, created_at: at, seen_at: at, ...values })
      .onConflictDoUpdate({ target: items.id, set: { ...values, seen_at: at } })
      .run();
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewBlueprint {
  title: string;
  applies_when: string;
  body: string;
  status: BlueprintStatus;
  made_by: BlueprintMaker;
  engine?: string;
  model?: string;
  sources?: string[];
  conversation_id?: string;
}

// Makes a blueprint in the context given, Global for null, and gives back its id.
export function insert_blueprint(database: SqlDatabase, values: NewBlueprint, context_id: string | null): string {
  const id = new_id();
  const at = now();
  in_transaction(database, () => {
    drizzle_of(database)
      .insert(blueprints)
      .values({ id, ...values, engine: values.engine ?? "", model: values.model ?? "", sources: JSON.stringify([...new Set(values.sources ?? [])].sort()), conversation_id: values.conversation_id ?? "", created_at: at, updated_at: at })
      .run();
    refresh_blueprint_items(database, [id]);
    drizzle_of(database).insert(context_items).values({ context_id: context_or_global(context_id), item_id: blueprint_item_id(id), note: "", added_at: at }).onConflictDoNothing().run();
  });
  return id;
}

export function update_blueprint(database: SqlDatabase, id: string, set: Partial<Omit<BlueprintRow, "id" | "created_at">>): void {
  drizzle_of(database).update(blueprints).set({ ...set, updated_at: now() }).where(eq(blueprints.id, id)).run();
  refresh_blueprint_items(database, [id]);
}

// Puts the blueprint in the one context given, or in Global for null so it applies everywhere.
export function place_blueprint_record(database: SqlDatabase, id: string, given_context: string | null): void {
  blueprint_row(database, id);
  const context_id = context_or_global(given_context);
  in_transaction(database, () => {
    const db = drizzle_of(database);
    const item_id = blueprint_item_id(id);
    db.delete(context_items).where(and(eq(context_items.item_id, item_id), sql`${context_items.context_id} != ${context_id}`)).run();
    db.insert(context_items).values({ context_id, item_id, note: "", added_at: now() }).onConflictDoNothing().run();
  });
}

// Deletes a blueprint with its changes and uses, and takes its item out of every context.
export function delete_blueprint_records(database: SqlDatabase, id: string): void {
  in_transaction(database, () => {
    const db = drizzle_of(database);
    db.delete(blueprint_changes).where(eq(blueprint_changes.blueprint_id, id)).run();
    db.delete(blueprint_uses).where(eq(blueprint_uses.blueprint_id, id)).run();
    db.delete(blueprints).where(eq(blueprints.id, id)).run();
    db.delete(context_items).where(eq(context_items.item_id, blueprint_item_id(id))).run();
    refresh_blueprint_items(database, [id]);
  });
}

// Notes that a run was given these blueprints to follow.
export function record_uses(database: SqlDatabase, ids: string[], conversation_id: string, run_id: string): void {
  if (ids.length === 0) return;
  const at = now();
  in_transaction(database, () => {
    for (const blueprint_id of ids) drizzle_of(database).insert(blueprint_uses).values({ id: new_id(), blueprint_id, conversation_id, run_id, used_at: at }).run();
    refresh_blueprint_items(database, ids);
  });
}
