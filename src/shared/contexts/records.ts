// The rows behind contexts and their items: reading the tree and what each context holds, writing them, and keeping
// Global at the top of the tree.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, count, desc, eq, inArray, isNull, like, ne, notInArray, or, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { feed_key, item_id_of, type FoundItem } from "../collectors/collector.ts";
import { blueprint_collector } from "../blueprints/model.ts";
import { conversation_collector } from "../conversations/model.ts";
import { finding_collector } from "../interests/model.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { context_or_global, global_context_id, type CardPlace, type ContextDetail, type ContextItem, type ContextSummary, type ContextView, type FollowedFeed, type Item, type KeptItem, type SeededFrom } from "./model.ts";
import { context_feeds, context_items, context_seeds, context_views, contexts, items } from "./schema.ts";
import { collector_of } from "./feeds.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

const most_kept_found = 50;

function as_item(row: typeof items.$inferSelect): Item {
  let detail: Record<string, string> = {};
  try {
    detail = JSON.parse(row.detail) as Record<string, string>;
  } catch {
    detail = {};
  }
  return { ...row, detail };
}

export function list_contexts(database: SqlDatabase, include_archived = false): ContextSummary[] {
  const db = drizzle_of(database);
  const counts = new Map(
    db
      .select({ context_id: context_items.context_id, total: count() })
      .from(context_items)
      .groupBy(context_items.context_id)
      .all()
      .map((row) => [row.context_id, row.total]),
  );
  return db
    .select()
    .from(contexts)
    .where(include_archived ? undefined : eq(contexts.is_archived, 0))
    .orderBy(asc(contexts.position), asc(contexts.name))
    .all()
    .map((row) => ({ id: row.id, parent_id: parent_of_row(row), name: row.name, position: row.position, is_archived: row.is_archived === 1, item_count: counts.get(row.id) ?? 0 }));
}

// Global has no parent; any other context with none, as an older device may sync in, sits under Global.
function parent_of_row(row: { id: string; parent_id: string | null }): string | null {
  return row.id === global_context_id ? null : (row.parent_id ?? global_context_id);
}

export function context_row(database: SqlDatabase, id: string) {
  const row = drizzle_of(database).select().from(contexts).where(eq(contexts.id, id)).get();
  if (!row) throw new Error(`There is no context ${id}.`);
  return row;
}

// The contexts holding each item, by item id.
export function holders_of(database: SqlDatabase, item_ids: string[]): Map<string, { id: string; name: string }[]> {
  const holders = new Map<string, { id: string; name: string }[]>();
  if (item_ids.length === 0) return holders;
  const rows = drizzle_of(database)
    .select({ item_id: context_items.item_id, id: contexts.id, name: contexts.name })
    .from(context_items)
    .innerJoin(contexts, eq(contexts.id, context_items.context_id))
    .where(inArray(context_items.item_id, item_ids))
    .orderBy(asc(contexts.name))
    .all();
  for (const row of rows) holders.set(row.item_id, [...(holders.get(row.item_id) ?? []), { id: row.id, name: row.name }]);
  return holders;
}

export function get_context(database: SqlDatabase, id: string): ContextDetail {
  const row = context_row(database, id);
  const rows = drizzle_of(database)
    .select({ item: items, note: context_items.note, added_at: context_items.added_at, via: context_items.via })
    .from(context_items)
    .innerJoin(items, eq(items.id, context_items.item_id))
    .where(eq(context_items.context_id, id))
    .orderBy(desc(context_items.added_at))
    .all();
  const holders = holders_of(database, rows.map((each) => each.item.id));
  const feeds = feeds_of(database, id);
  const label_of = new Map(feeds.map((feed) => [feed_key(feed.collector, feed.feed_id), feed.label]));
  const held: ContextItem[] = rows.map((each) => ({
    ...as_item(each.item),
    note: each.note,
    added_at: each.added_at,
    also_in: (holders.get(each.item.id) ?? []).filter((holder) => holder.id !== id),
    via_label: each.via ? (label_of.get(each.via) ?? "") : "",
  }));
  return {
    id: row.id,
    parent_id: parent_of_row(row),
    name: row.name,
    notes: row.notes,
    position: row.position,
    is_archived: row.is_archived === 1,
    created_at: row.created_at,
    item_count: held.length,
    items: held,
    feeds,
    ...view_of(database, id),
    seeded_from: seed_of(database, id),
  };
}

export function seed_of(database: SqlDatabase, context_id: string): SeededFrom | null {
  const row = drizzle_of(database).select().from(context_seeds).where(eq(context_seeds.context_id, context_id)).get();
  return row ? { collector: row.collector, group_id: row.group_id, label: row.label } : null;
}

function view_of(database: SqlDatabase, context_id: string): { view: ContextView; card_places: CardPlace[] } {
  const row = drizzle_of(database).select().from(context_views).where(eq(context_views.context_id, context_id)).get();
  let card_places: CardPlace[] = [];
  try {
    card_places = row ? (JSON.parse(row.card_places) as CardPlace[]) : [];
  } catch {
    card_places = [];
  }
  return { view: row?.view === "cards" || row?.view === "grouped" || row?.view === "graph" ? row.view : "list", card_places };
}

export function save_view(database: SqlDatabase, context_id: string, values: { view?: ContextView; card_places?: string }): void {
  context_row(database, context_id);
  drizzle_of(database)
    .insert(context_views)
    .values({ context_id, ...values })
    .onConflictDoUpdate({ target: context_views.context_id, set: values })
    .run();
}

// A place is whole cells within reason; anything else is refused before it reaches other devices.
export function checked_places(places: CardPlace[]): CardPlace[] {
  const whole = (value: unknown, least: number) => Number.isInteger(value) && (value as number) >= least && (value as number) <= 1000;
  for (const place of places) {
    if (typeof place.id !== "string" || !whole(place.x, 0) || !whole(place.y, 0) || !whole(place.w, 1) || !whole(place.h, 1)) throw new Error("A card's place is whole cells: a column, a row, a width and a height.");
  }
  return places.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
}

export function feeds_of(database: SqlDatabase, context_id: string): FollowedFeed[] {
  return drizzle_of(database)
    .select({ collector: context_feeds.collector, feed_id: context_feeds.feed_id, label: context_feeds.label, added_at: context_feeds.added_at })
    .from(context_feeds)
    .where(eq(context_feeds.context_id, context_id))
    .orderBy(asc(context_feeds.added_at))
    .all();
}

// Items already kept whose title, snippet or address holds the text, with the contexts holding each.
export function search_kept_items(database: SqlDatabase, query: string): KeptItem[] {
  const pattern = `%${query.trim()}%`;
  const rows = drizzle_of(database)
    .select()
    .from(items)
    .where(or(like(items.title, pattern), like(items.snippet, pattern), like(items.uri, pattern)))
    .orderBy(desc(items.created_at))
    .limit(most_kept_found)
    .all();
  const holders = holders_of(database, rows.map((row) => row.id));
  return rows.map((row) => ({ ...as_item(row), contexts: holders.get(row.id) ?? [] })).filter((item) => item.contexts.length > 0);
}

export function get_item(database: SqlDatabase, id: string): KeptItem {
  const row = drizzle_of(database).select().from(items).where(eq(items.id, id)).get();
  if (!row) throw new Error(`There is no item ${id}.`);
  return { ...as_item(row), contexts: holders_of(database, [id]).get(id) ?? [] };
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

function next_position(database: SqlDatabase, parent_id: string | null): number {
  const row = drizzle_of(database)
    .select({ last: sql<number | null>`max(${contexts.position})` })
    .from(contexts)
    .where(parent_id === null ? sql`${contexts.parent_id} IS NULL` : eq(contexts.parent_id, parent_id))
    .get();
  return (row?.last ?? -1) + 1;
}

// Every context goes under another; null or none given puts it directly under Global.
export function add_context(database: SqlDatabase, name: string, given_parent: string | null = null): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the context a name.");
  const parent_id = context_or_global(given_parent);
  context_row(database, parent_id);
  const id = new_id();
  drizzle_of(database).insert(contexts).values({ id, parent_id, name: trimmed, position: next_position(database, parent_id), created_at: now() }).run();
  return id;
}

// The ids of a context and every context inside it.
export function subtree_of(database: SqlDatabase, id: string): string[] {
  const all = drizzle_of(database).select({ id: contexts.id, parent_id: contexts.parent_id }).from(contexts).all();
  const found = [id];
  for (let index = 0; index < found.length; index++) for (const row of all) if (row.parent_id === found[index]) found.push(row.id);
  return found;
}

export const global_fixed = "Global is the root that holds every other context, so it cannot be moved, archived or deleted; it can be renamed.";

export function move_context(database: SqlDatabase, id: string, given_parent: string | null, position: number | null = null): void {
  context_row(database, id);
  if (id === global_context_id) throw new Error(global_fixed);
  const parent_id = context_or_global(given_parent);
  if (subtree_of(database, id).includes(parent_id)) throw new Error("A context cannot go inside itself.");
  context_row(database, parent_id);
  drizzle_of(database)
    .update(contexts)
    .set({ parent_id, position: position ?? next_position(database, parent_id) })
    .where(eq(contexts.id, id))
    .run();
}

// Told, after contexts are removed, which items they left in no context at all, such as CODEX's own conversations,
// which go with the last context holding them.
type ItemsLeft = (database: SqlDatabase, item_ids: string[]) => void;

const items_left_listeners: ItemsLeft[] = [];

export function when_items_left(listener: ItemsLeft): void {
  if (!items_left_listeners.includes(listener)) items_left_listeners.push(listener);
}

export function remove_context(database: SqlDatabase, id: string): void {
  context_row(database, id);
  if (id === global_context_id) throw new Error(global_fixed);
  const removed = subtree_of(database, id);
  const db = drizzle_of(database);
  const held = db.select({ item_id: context_items.item_id }).from(context_items).where(inArray(context_items.context_id, removed)).all().map((row) => row.item_id);
  const elsewhere = new Set(held.length > 0 ? db.select({ item_id: context_items.item_id }).from(context_items).where(and(inArray(context_items.item_id, held), notInArray(context_items.context_id, removed))).all().map((row) => row.item_id) : []);
  db.delete(contexts).where(inArray(contexts.id, removed)).run();
  const left = [...new Set(held)].filter((item_id) => !elsewhere.has(item_id));
  if (left.length > 0) for (const listener of items_left_listeners) listener(database, left);
}

// Keeps what the collector said of the item, adding it the first time; the note and contexts stay as they are.
export function keep_item(database: SqlDatabase, collector: string, found: FoundItem): string {
  if (!found.source_id) throw new Error("The item has no id in its own app.");
  if (!found.title?.trim()) throw new Error("The item has no title.");
  const id = item_id_of(collector, found.source_id);
  const values = {
    kind: found.kind,
    title: found.title.trim(),
    snippet: found.snippet ?? "",
    uri: found.uri ?? "",
    status: found.status ?? "",
    detail: JSON.stringify(found.detail ?? {}),
    seen_at: now(),
  };
  drizzle_of(database)
    .insert(items)
    .values({ id, collector, source_id: found.source_id, created_at: now(), ...values })
    .onConflictDoUpdate({ target: items.id, set: values })
    .run();
  return id;
}

// Adds the item to each context given that does not hold it yet; the item itself stays in its own app.
export function add_item(database: SqlDatabase, context_ids: string[], collector: string, found: FoundItem, note = ""): string {
  if (context_ids.length === 0) throw new Error("Pick at least one context.");
  if (collector === conversation_collector) throw new Error("A conversation is started in the Assistant pane; add_item_to_contexts puts one in more contexts.");
  if (collector === blueprint_collector) throw new Error("A blueprint is written with add_blueprint; add_item_to_contexts makes one apply in more contexts.");
  if (collector === finding_collector) throw new Error("A finding is saved only by the Research interests job; add_item_to_contexts puts one in more contexts.");
  for (const context_id of context_ids) context_row(database, context_id);
  return in_transaction(database, () => {
    const item_id = keep_item(database, collector, found);
    for (const context_id of context_ids) {
      // Adding by hand an item a feed brought keeps it there when the feed lets it go.
      drizzle_of(database).insert(context_items).values({ context_id, item_id, note, added_at: now() }).onConflictDoUpdate({ target: [context_items.context_id, context_items.item_id], set: { via: "" } }).run();
    }
    return item_id;
  });
}

export async function add_manual_item(database: SqlDatabase, context_ids: string[], collector: string, values: Record<string, string>, note = ""): Promise<string> {
  const source = await collector_of(database, collector);
  if (!source.manual) throw new Error(`The ${source.label} collector does not take items typed in by hand.`);
  return add_item(database, context_ids, collector, source.manual.make(values), note);
}

// A note makes the item the user's own, so a feed that lets it go leaves it.
export function set_item_note(database: SqlDatabase, context_id: string, item_id: string, note: string): void {
  drizzle_of(database)
    .update(context_items)
    .set(note.trim() ? { note, via: "" } : { note })
    .where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, item_id)))
    .run();
}

// A conversation or a blueprint is CODEX's own, so it is never left in no context by this: it is deleted with its own call.
export function remove_item(database: SqlDatabase, context_id: string, item_id: string): void {
  const db = drizzle_of(database);
  const memberships = db.select({ context_id: context_items.context_id }).from(context_items).where(eq(context_items.item_id, item_id)).all();
  const is_last = memberships.length === 1 && memberships[0]!.context_id === context_id;
  const collector = is_last ? db.select({ collector: items.collector }).from(items).where(eq(items.id, item_id)).get()?.collector : undefined;
  if (collector === conversation_collector) throw new Error("This is the last context holding that conversation; delete it with delete_conversation, or move it with move_item.");
  // A blueprint left in no context would apply everywhere, as one in Global does, so that is only done on purpose, with place_blueprint.
  if (collector === blueprint_collector) throw new Error("This is the last context holding that blueprint; delete it with remove_blueprint, move it with move_item, or make it apply everywhere on its page.");
  db.delete(context_items)
    .where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, item_id)))
    .run();
}

function kept_item_row(database: SqlDatabase, item_id: string) {
  const row = drizzle_of(database).select().from(items).where(eq(items.id, item_id)).get();
  if (!row) throw new Error(`There is no item ${item_id}.`);
  if (row.collector === conversation_collector && row.status === "missing") throw new Error("That conversation was deleted.");
  if (row.collector === blueprint_collector && row.status === "missing") throw new Error("That blueprint was deleted.");
  return row;
}

// Puts an item CODEX already keeps, such as one in another context, in more contexts.
export function add_item_to_contexts(database: SqlDatabase, item_id: string, context_ids: string[], note = ""): void {
  if (context_ids.length === 0) throw new Error("Pick at least one context.");
  kept_item_row(database, item_id);
  for (const context_id of context_ids) context_row(database, context_id);
  in_transaction(database, () => {
    for (const context_id of context_ids) drizzle_of(database).insert(context_items).values({ context_id, item_id, note, added_at: now() }).onConflictDoNothing().run();
  });
}

// Moves an item from one context to another, its note with it; one the other already holds keeps that note.
export function move_item(database: SqlDatabase, context_id: string, item_id: string, to_context_id: string): void {
  kept_item_row(database, item_id);
  context_row(database, context_id);
  context_row(database, to_context_id);
  if (to_context_id === context_id) return;
  const db = drizzle_of(database);
  const membership = db.select().from(context_items).where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, item_id))).get();
  if (!membership) throw new Error("That context does not hold that item.");
  in_transaction(database, () => {
    db.insert(context_items).values({ context_id: to_context_id, item_id, note: membership.note, added_at: now() }).onConflictDoNothing().run();
    db.delete(context_items).where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, item_id))).run();
  });
}

// ── Global ───────────────────────────────────────────────────────────────────

// Keeps Global the root, as the migration made it: there, at the top and never archived, every other top-level
// context under it, and CODEX's own conversations and blueprints in no context held by it. A device not yet updated can
// sync in a context at the top level or a conversation in none, so this runs on every open and write; the fixed id and
// the memberships' keys make every device write the same rows, so sync merges them. It writes only what is out of place.
export function ensure_global(database: SqlDatabase): void {
  const db = drizzle_of(database);
  const global = db.select().from(contexts).where(eq(contexts.id, global_context_id)).get();
  if (!global) db.insert(contexts).values({ id: global_context_id, parent_id: null, name: "Global", position: 0, created_at: now() }).run();
  else if (global.parent_id !== null || global.is_archived !== 0) db.update(contexts).set({ parent_id: null, is_archived: 0 }).where(eq(contexts.id, global_context_id)).run();
  db.update(contexts).set({ parent_id: global_context_id }).where(and(isNull(contexts.parent_id), ne(contexts.id, global_context_id))).run();
  const held = db.selectDistinct({ item_id: context_items.item_id }).from(context_items);
  const loose = db
    .select({ id: items.id })
    .from(items)
    .where(and(inArray(items.collector, [conversation_collector, blueprint_collector]), ne(items.status, "missing"), notInArray(items.id, held)))
    .all();
  for (const row of loose) db.insert(context_items).values({ context_id: global_context_id, item_id: row.id, note: "", added_at: now() }).onConflictDoNothing().run();
}
