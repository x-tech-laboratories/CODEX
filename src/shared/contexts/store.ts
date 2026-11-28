// Contexts and the items they hold: the tree of contexts, items added from collectors or pushed in by another app,
// and a refresh that asks each collector what became of its items. Items are only ever pointers to another app's data.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, count, desc, eq, inArray, isNull, like, ne, notInArray, or, sql, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { feed_key, item_id_of, type CollectorSummary, type Feed, type FoundItem, type ReadItem } from "../collectors/collector.ts";
import { open_plugin_host } from "../collectors/host.ts";
import { blueprint_collector } from "../blueprints/model.ts";
import { conversation_collector } from "../conversations/model.ts";
import { finding_collector } from "../interests/model.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { migrations } from "./migrations/index.ts";
import { context_or_global, global_context_id, scope_of, type CardPlace, type ContextDetail, type ContextItem, type ContextSummary, type ContextView, type FollowedFeed, type Item, type KeptItem, type RefreshReport, type SeededFrom } from "./model.ts";
import { context_feeds, context_items, context_seeds, context_tables, context_views, contexts, items } from "./schema.ts";

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

function list_contexts(database: SqlDatabase, include_archived = false): ContextSummary[] {
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

function context_row(database: SqlDatabase, id: string) {
  const row = drizzle_of(database).select().from(contexts).where(eq(contexts.id, id)).get();
  if (!row) throw new Error(`There is no context ${id}.`);
  return row;
}

// The contexts holding each item, by item id.
function holders_of(database: SqlDatabase, item_ids: string[]): Map<string, { id: string; name: string }[]> {
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

function get_context(database: SqlDatabase, id: string): ContextDetail {
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

function seed_of(database: SqlDatabase, context_id: string): SeededFrom | null {
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

function save_view(database: SqlDatabase, context_id: string, values: { view?: ContextView; card_places?: string }): void {
  context_row(database, context_id);
  drizzle_of(database)
    .insert(context_views)
    .values({ context_id, ...values })
    .onConflictDoUpdate({ target: context_views.context_id, set: values })
    .run();
}

// A place is whole cells within reason; anything else is refused before it reaches other devices.
function checked_places(places: CardPlace[]): CardPlace[] {
  const whole = (value: unknown, least: number) => Number.isInteger(value) && (value as number) >= least && (value as number) <= 1000;
  for (const place of places) {
    if (typeof place.id !== "string" || !whole(place.x, 0) || !whole(place.y, 0) || !whole(place.w, 1) || !whole(place.h, 1)) throw new Error("A card's place is whole cells: a column, a row, a width and a height.");
  }
  return places.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
}

function feeds_of(database: SqlDatabase, context_id: string): FollowedFeed[] {
  return drizzle_of(database)
    .select({ collector: context_feeds.collector, feed_id: context_feeds.feed_id, label: context_feeds.label, added_at: context_feeds.added_at })
    .from(context_feeds)
    .where(eq(context_feeds.context_id, context_id))
    .orderBy(asc(context_feeds.added_at))
    .all();
}

// Items already kept whose title, snippet or address holds the text, with the contexts holding each.
function search_kept_items(database: SqlDatabase, query: string): KeptItem[] {
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

function get_item(database: SqlDatabase, id: string): KeptItem {
  const row = drizzle_of(database).select().from(items).where(eq(items.id, id)).get();
  if (!row) throw new Error(`There is no item ${id}.`);
  return { ...as_item(row), contexts: holders_of(database, [id]).get(id) ?? [] };
}

// ── Collectors ───────────────────────────────────────────────────────────────

async function running_collectors(database: SqlDatabase) {
  return (await open_plugin_host(database)).providers("collector");
}

async function collector_of(database: SqlDatabase, id: string) {
  const found = (await running_collectors(database)).find((provided) => provided.id === id);
  if (!found) throw new Error(`The ${id} collector is not running; turn its plugin on under Settings → Plugins.`);
  return found.value;
}

async function list_collectors(database: SqlDatabase): Promise<CollectorSummary[]> {
  return (await running_collectors(database)).map(({ id, plugin_id, value }) => ({
    id,
    plugin_id,
    label: value.label,
    kinds: value.kinds,
    can_search: value.search !== undefined,
    can_refresh: value.resolve !== undefined,
    can_follow: value.feeds !== undefined,
    manual_fields: value.manual?.fields ?? [],
    pushed_from: value.pushed_from ?? "",
  }));
}

// What the collector finds for the text, each with the contexts that already hold it.
async function search_collector(database: SqlDatabase, collector: string, query: string): Promise<(FoundItem & { kept_in: string[] })[]> {
  const source = await collector_of(database, collector);
  if (!source.search) throw new Error(`The ${source.label} collector cannot search; its items are sent to CODEX from elsewhere.`);
  const found = await source.search(query);
  const holders = holders_of(database, found.map((item) => item_id_of(collector, item.source_id)));
  return found.map((item) => ({ ...item, kept_in: (holders.get(item_id_of(collector, item.source_id)) ?? []).map((holder) => holder.id) }));
}

// What the collector says now of one item in its app, by its id there, with the contexts that already hold it.
async function get_source_item(database: SqlDatabase, collector: string, source_id: string): Promise<FoundItem & { kept_in: string[] }> {
  const source = await collector_of(database, collector);
  if (!source.resolve) throw new Error(`The ${source.label} collector cannot read one item; search it with search_collector.`);
  const id = source_id.trim();
  const found = (await source.resolve([id]))[id];
  if (!found) throw new Error(`${source.label} has no item ${id}.`);
  const holders = holders_of(database, [item_id_of(collector, found.source_id)]);
  return { ...found, kept_in: (holders.get(item_id_of(collector, found.source_id)) ?? []).map((holder) => holder.id) };
}

// One item's whole current content and attributes, read live from its app and never kept, with the contexts holding it.
async function get_source_content(database: SqlDatabase, collector: string, source_id: string): Promise<ReadItem & { kept_in: string[] }> {
  const source = await collector_of(database, collector);
  if (!source.read) throw new Error(`The ${source.label} collector cannot read an item's content; read what it says of one with get_source_item.`);
  const id = source_id.trim();
  const found = await source.read(id);
  if (!found) throw new Error(`${source.label} has no item ${id}.`);
  const holders = holders_of(database, [item_id_of(collector, found.source_id)]);
  return { ...found, kept_in: (holders.get(item_id_of(collector, found.source_id)) ?? []).map((holder) => holder.id) };
}

async function list_collector_feeds(database: SqlDatabase, collector: string): Promise<Feed[]> {
  const source = await collector_of(database, collector);
  if (!source.feeds) throw new Error(`The ${source.label} collector has nothing to follow.`);
  return source.feeds.list();
}

// ── Writing ──────────────────────────────────────────────────────────────────

function now(): string {
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
function add_context(database: SqlDatabase, name: string, given_parent: string | null = null): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the context a name.");
  const parent_id = context_or_global(given_parent);
  context_row(database, parent_id);
  const id = new_id();
  drizzle_of(database).insert(contexts).values({ id, parent_id, name: trimmed, position: next_position(database, parent_id), created_at: now() }).run();
  return id;
}

// The ids of a context and every context inside it.
function subtree_of(database: SqlDatabase, id: string): string[] {
  const all = drizzle_of(database).select({ id: contexts.id, parent_id: contexts.parent_id }).from(contexts).all();
  const found = [id];
  for (let index = 0; index < found.length; index++) for (const row of all) if (row.parent_id === found[index]) found.push(row.id);
  return found;
}

const global_fixed = "Global is the root that holds every other context, so it cannot be moved, archived or deleted; it can be renamed.";

function move_context(database: SqlDatabase, id: string, given_parent: string | null, position: number | null = null): void {
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

function remove_context(database: SqlDatabase, id: string): void {
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
function keep_item(database: SqlDatabase, collector: string, found: FoundItem): string {
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
function add_item(database: SqlDatabase, context_ids: string[], collector: string, found: FoundItem, note = ""): string {
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

async function add_manual_item(database: SqlDatabase, context_ids: string[], collector: string, values: Record<string, string>, note = ""): Promise<string> {
  const source = await collector_of(database, collector);
  if (!source.manual) throw new Error(`The ${source.label} collector does not take items typed in by hand.`);
  return add_item(database, context_ids, collector, source.manual.make(values), note);
}

// A note makes the item the user's own, so a feed that lets it go leaves it.
function set_item_note(database: SqlDatabase, context_id: string, item_id: string, note: string): void {
  drizzle_of(database)
    .update(context_items)
    .set(note.trim() ? { note, via: "" } : { note })
    .where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, item_id)))
    .run();
}

// A conversation or a blueprint is CODEX's own, so it is never left in no context by this: it is deleted with its own call.
function remove_item(database: SqlDatabase, context_id: string, item_id: string): void {
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
function add_item_to_contexts(database: SqlDatabase, item_id: string, context_ids: string[], note = ""): void {
  if (context_ids.length === 0) throw new Error("Pick at least one context.");
  kept_item_row(database, item_id);
  for (const context_id of context_ids) context_row(database, context_id);
  in_transaction(database, () => {
    for (const context_id of context_ids) drizzle_of(database).insert(context_items).values({ context_id, item_id, note, added_at: now() }).onConflictDoNothing().run();
  });
}

// Moves an item from one context to another, its note with it; one the other already holds keeps that note.
function move_item(database: SqlDatabase, context_id: string, item_id: string, to_context_id: string): void {
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

// ── Feeds ──────────────────────────────────────────────────────────────────

type Collectors = Awaited<ReturnType<typeof running_collectors>>;

// Brings each feed the context follows in step: items now in a feed join, and items a feed brought that are in none of
// them now leave, unless the user has since made them their own.
async function sync_feeds(database: SqlDatabase, context_id: string, collectors: Collectors, report: RefreshReport): Promise<void> {
  const followed = feeds_of(database, context_id);
  const wanted = new Map<string, { collector: string; item: FoundItem; via: string }>();
  const answered = new Set<string>();
  for (const feed of followed) {
    const source = collectors.find((provided) => provided.id === feed.collector)?.value;
    if (!source?.feeds) {
      report.problems.push(`${feed.label}: the ${feed.collector} collector is off or cannot follow.`);
      continue;
    }
    try {
      for (const item of await source.feeds.items(feed.feed_id)) {
        const id = item_id_of(feed.collector, item.source_id);
        if (!wanted.has(id)) wanted.set(id, { collector: feed.collector, item, via: feed_key(feed.collector, feed.feed_id) });
      }
      answered.add(feed_key(feed.collector, feed.feed_id));
    } catch (error) {
      report.problems.push(`${feed.label}: ${(error as Error).message}`);
    }
  }
  in_transaction(database, () => {
    const db = drizzle_of(database);
    const held = new Map(db.select().from(context_items).where(eq(context_items.context_id, context_id)).all().map((row) => [row.item_id, row]));
    for (const [id, { collector, item, via }] of wanted) {
      keep_item(database, collector, item);
      if (held.has(id)) continue;
      db.insert(context_items).values({ context_id, item_id: id, note: "", added_at: now(), via }).run();
      report.joined++;
    }
    // A feed that could not answer keeps what it brought until it can.
    for (const row of held.values()) {
      if (!row.via || !answered.has(row.via) || wanted.has(row.item_id)) continue;
      db.delete(context_items).where(and(eq(context_items.context_id, context_id), eq(context_items.item_id, row.item_id))).run();
      report.left++;
    }
  });
}

function empty_report(): RefreshReport {
  return { checked: 0, updated: 0, missing: 0, joined: 0, left: 0, problems: [] };
}

async function follow_feed(database: SqlDatabase, context_id: string, collector: string, feed_id: string, label: string): Promise<RefreshReport> {
  context_row(database, context_id);
  const collectors = await running_collectors(database);
  const source = collectors.find((provided) => provided.id === collector)?.value;
  if (!source?.feeds) throw new Error(`The ${collector} collector is not running or has nothing to follow.`);
  drizzle_of(database)
    .insert(context_feeds)
    .values({ context_id, collector, feed_id, label: label.trim() || feed_id, added_at: now() })
    .onConflictDoUpdate({ target: [context_feeds.context_id, context_feeds.collector, context_feeds.feed_id], set: { label: label.trim() || feed_id } })
    .run();
  const report = empty_report();
  await sync_feeds(database, context_id, collectors, report);
  return report;
}

// Stops following; what the feed brought leaves, but for items the user made their own.
function unfollow_feed(database: SqlDatabase, context_id: string, collector: string, feed_id: string): void {
  in_transaction(database, () => {
    const db = drizzle_of(database);
    db.delete(context_feeds).where(and(eq(context_feeds.context_id, context_id), eq(context_feeds.collector, collector), eq(context_feeds.feed_id, feed_id))).run();
    db.delete(context_items).where(and(eq(context_items.context_id, context_id), eq(context_items.via, feed_key(collector, feed_id)))).run();
  });
}

// Makes a context for each feed, named for it and following it, under the parent given; gives back their ids.
async function add_contexts_from_feeds(database: SqlDatabase, collector: string, feeds: { id: string; label: string }[], parent_id: string | null = null): Promise<string[]> {
  if (feeds.length === 0) throw new Error("Pick at least one to follow.");
  const ids: string[] = [];
  for (const feed of feeds) {
    const id = add_context(database, feed.label, parent_id);
    await follow_feed(database, id, collector, feed.id, feed.label);
    ids.push(id);
  }
  return ids;
}

// The feeds of a group worth a context each: a feed inside another of the group, such as a tag under another, is
// left out, since the outer one's context already holds what it does.
function outer_feeds_of(feeds: Feed[], group_id: string): Feed[] {
  const in_group = feeds.filter((feed) => feed.group?.id === group_id);
  return in_group.filter((feed) => !in_group.some((other) => other !== feed && feed.label.startsWith(`${other.label}/`)));
}

// Makes a context named for a group in another app, such as an X-Tasks filter group, with a context inside it for
// each of the group's feeds, following it; remembers the group so feeds added to it later are offered. Gives back the
// new context's id.
async function add_contexts_from_feed_group(database: SqlDatabase, collector: string, group_id: string, parent_id: string | null = null): Promise<string> {
  const feeds = outer_feeds_of(await list_collector_feeds(database, collector), group_id);
  const group = feeds[0]?.group;
  if (!group) throw new Error("That group has nothing to follow.");
  const id = add_context(database, group.label, parent_id);
  drizzle_of(database).insert(context_seeds).values({ context_id: id, collector, group_id, label: group.label, added_at: now() }).run();
  await add_contexts_from_feeds(database, collector, feeds.map((feed) => ({ id: feed.id, label: feed.label })), id);
  return id;
}

// The feeds of the group a context was made from that no context inside it follows yet, such as a tag added later.
async function list_feed_group_news(database: SqlDatabase, context_id: string): Promise<Feed[]> {
  context_row(database, context_id);
  const seed = seed_of(database, context_id);
  if (!seed) return [];
  const inside = subtree_of(database, context_id);
  const followed = new Set(
    drizzle_of(database)
      .select({ feed_id: context_feeds.feed_id })
      .from(context_feeds)
      .where(and(inArray(context_feeds.context_id, inside), eq(context_feeds.collector, seed.collector)))
      .all()
      .map((row) => row.feed_id),
  );
  const feeds = await list_collector_feeds(database, seed.collector);
  return outer_feeds_of(feeds, seed.group_id).filter((feed) => !followed.has(feed.id));
}

// Brings followed feeds in step, then asks each collector what became of its items, in one context or everywhere: new
// titles and states are kept, and an item its app no longer has is marked missing rather than dropped.
async function refresh_items(database: SqlDatabase, given_context: string | null = null): Promise<RefreshReport> {
  const context_id = scope_of(given_context);
  const db = drizzle_of(database);
  const report = empty_report();
  const collectors = await running_collectors(database);
  const following = context_id === null ? [...new Set(db.select({ id: context_feeds.context_id }).from(context_feeds).all().map((row) => row.id))] : [context_id];
  for (const id of following) await sync_feeds(database, id, collectors, report);
  const rows =
    context_id === null
      ? db.select().from(items).all()
      : db.select({ item: items }).from(items).innerJoin(context_items, eq(context_items.item_id, items.id)).where(eq(context_items.context_id, context_id)).all().map((row) => row.item);
  for (const { id, value } of collectors) {
    const resolve = value.resolve;
    const own = rows.filter((row) => row.collector === id);
    if (!resolve || own.length === 0) continue;
    let answers: Record<string, FoundItem>;
    try {
      answers = await resolve(own.map((row) => row.source_id));
    } catch (error) {
      report.problems.push(`${value.label}: ${(error as Error).message}`);
      continue;
    }
    in_transaction(database, () => {
      for (const row of own) {
        report.checked++;
        const answer = answers[row.source_id];
        if (!answer) {
          if (row.status !== "missing") report.missing++;
          db.update(items).set({ status: "missing", seen_at: now() }).where(eq(items.id, row.id)).run();
          continue;
        }
        const was = JSON.stringify([row.title, row.snippet, row.uri, row.status, row.kind]);
        keep_item(database, id, answer);
        if (was !== JSON.stringify([answer.title.trim(), answer.snippet ?? "", answer.uri ?? "", answer.status ?? "", answer.kind])) report.updated++;
      }
    });
  }
  return report;
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

function export_contexts(database: SqlDatabase): ContextsExport {
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
function import_contexts(database: SqlDatabase, json: string): { contexts: number; items: number } {
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

// ── Feature ──────────────────────────────────────────────────────────────────

const found_item_schema = {
  type: "object",
  required: ["source_id", "kind", "title"],
  properties: {
    source_id: text("The item's id in its own app, such as a task id, a file's path or an email's Message-ID."),
    kind: text("What it is, such as task, note, file, email or link."),
    title: text("Its title."),
    snippet: text("A line or two of what it says."),
    uri: text("Where it opens, such as x-tasks://task/<id>, mid:<message-id> or a web address."),
    status: text('A short state, such as "done".'),
    detail: { type: "object", additionalProperties: { type: "string" }, description: "Other facts as text, such as from and date for an email." },
  },
  description: "The item as its collector describes it.",
} as const;

const context_ids_schema = { type: "array", items: { type: "string" }, minItems: 1, description: "The ids of the contexts to add it to, from list_contexts." } as const;
const collector_schema = text("The collector's id, from list_collectors, such as x-tasks, trilium, files, links or email.");
const nullable_context = { type: ["string", "null"], description: "A context's id, from list_contexts; null for Global, the root every other context sits under." } as const;

export const contexts_feature = define_feature({
  id: "contexts",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(context_tables),
  on_open: ensure_global,
  after_write: ensure_global,
  methods: {
    list_contexts,
    get_context,
    search_kept_items,
    get_item,
    list_collectors,
    search_collector,
    get_source_item,
    get_source_content,
    list_collector_feeds,
    list_feed_group_news,
    export_contexts,
    add_context,
    rename_context: (database: SqlDatabase, id: string, name: string): void => {
      if (!name.trim()) throw new Error("Give the context a name.");
      context_row(database, id);
      drizzle_of(database).update(contexts).set({ name: name.trim() }).where(eq(contexts.id, id)).run();
    },
    set_context_notes: (database: SqlDatabase, id: string, notes: string): void => {
      context_row(database, id);
      drizzle_of(database).update(contexts).set({ notes }).where(eq(contexts.id, id)).run();
    },
    set_context_archived: (database: SqlDatabase, id: string, is_archived: boolean): void => {
      context_row(database, id);
      if (id === global_context_id) throw new Error(global_fixed);
      drizzle_of(database).update(contexts).set({ is_archived: is_archived ? 1 : 0 }).where(eq(contexts.id, id)).run();
    },
    move_context,
    remove_context,
    add_item,
    add_manual_item,
    set_item_note,
    remove_item,
    add_item_to_contexts,
    move_item,
    refresh_items,
    set_context_view: (database: SqlDatabase, id: string, view: ContextView): void => {
      if (view !== "list" && view !== "cards" && view !== "grouped" && view !== "graph") throw new Error('A context shows its items as "list", "cards", "grouped" or "graph".');
      save_view(database, id, { view });
    },
    set_card_places: (database: SqlDatabase, id: string, places: CardPlace[]): void => save_view(database, id, { card_places: JSON.stringify(checked_places(places)) }),
    follow_feed,
    unfollow_feed,
    add_contexts_from_feeds,
    add_contexts_from_feed_group,
    stop_feed_group_news: (database: SqlDatabase, id: string): void => {
      context_row(database, id);
      drizzle_of(database).delete(context_seeds).where(eq(context_seeds.context_id, id)).run();
    },
    import_contexts,
  },
  api: {
    list_contexts: {
      description: "Lists the contexts, each a project or area of life, as a tree by parent_id, with how many items each holds. Global, id \"global\", is the root: every other context sits under it, its notes apply to every conversation, and it can hold items of its own.",
      params: [{ name: "include_archived", schema: { type: "boolean", description: "Whether archived contexts are listed too; they are not unless true." }, optional: true }],
    },
    get_context: {
      description: "Gets one context with its notes and every item it holds: tasks, notes, files, emails and links from other apps, newest first, each with where it opens and the other contexts holding it.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    search_kept_items: {
      description: "Finds items already in any context whose title, snippet or address holds the text, with the contexts holding each.",
      params: [{ name: "query", schema: text("The text to look for.") }],
    },
    get_item: { description: "Gets one item with every context that holds it.", params: [{ name: "id", schema: id_of("item") }] },
    list_collectors: {
      description: "Lists the running collectors, the plugins that bring items from other apps: which can search, which take items typed in by hand and which are sent items from elsewhere.",
      params: [],
    },
    search_collector: {
      description: "Searches one collector's app, such as X-Tasks or Trilium, for items to add, each with the contexts already holding it.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "query", schema: text("The text to search for.") },
      ],
    },
    get_source_item: {
      description: "Reads one item as its app has it now, such as a Trilium note or an X-Tasks task, by its id in that app, with the contexts already holding it; the item need not be in any context.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "source_id", schema: text("The item's id in its own app, such as a Trilium note id; from a link, the id it ends with.") },
      ],
    },
    get_source_content: {
      description:
        "Reads one item's whole current content from its app, live, such as a Trilium note's text with its labels and relations, or an X-Tasks task's full notes with its tags, due date and parent, by its id in that app, with the contexts already holding it. Nothing read is kept.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "source_id", schema: text("The item's id in its own app, such as a Trilium note id; from a link, the id it ends with.") },
      ],
    },
    set_context_view: {
      description:
        "Shows a context's items as a list grouped by kind, as a card per item, grouped: a card per kind, such as one holding every task, each listing its items, or as the graph of the context, its items, their entities and links. Cards sit in a grid and can be moved and resized.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "view", schema: { type: "string", enum: ["list", "cards", "grouped", "graph"], description: "list, cards, grouped or graph." } },
      ],
    },
    set_card_places: {
      description: "Sets where each item's card sits in a context's card grid, in cells of a 12-column grid; items left out are placed below the rest.",
      params: [
        { name: "id", schema: id_of("context") },
        {
          name: "places",
          schema: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "x", "y", "w", "h"],
              properties: {
                id: text("The item's id."),
                x: { type: "integer", minimum: 0, description: "Its column, from 0 at the left." },
                y: { type: "integer", minimum: 0, description: "Its row, from 0 at the top." },
                w: { type: "integer", minimum: 1, description: "Its width in columns." },
                h: { type: "integer", minimum: 1, description: "Its height in rows." },
              },
            },
            description: "Every card's place.",
          },
        },
      ],
    },
    list_collector_feeds: {
      description: "Lists what a context can follow in one collector's app, such as X-Tasks tags and tasks with subtasks, each with an id to pass to follow_feed and, for a tag, the filter group it is in.",
      params: [{ name: "collector", schema: collector_schema }],
    },
    follow_feed: {
      description:
        "Makes a context follow a feed: its items join now and on every refresh, and leave when they leave the feed, unless they were added by hand or given a note. Gives back what joined.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "collector", schema: collector_schema },
        { name: "feed_id", schema: text("The feed's id from list_collector_feeds.") },
        { name: "label", schema: text("The feed's name, as list_collector_feeds gives it.") },
      ],
    },
    unfollow_feed: {
      description: "Stops a context following a feed; the items it brought leave, but for those added by hand or given a note.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "collector", schema: collector_schema },
        { name: "feed_id", schema: text("The feed's id.") },
      ],
    },
    add_contexts_from_feeds: {
      description: "Makes a context for each feed given, named for it and following it, such as one per X-Tasks tag; gives back their ids.",
      params: [
        { name: "collector", schema: collector_schema },
        {
          name: "feeds",
          schema: {
            type: "array",
            minItems: 1,
            items: { type: "object", required: ["id", "label"], properties: { id: text("The feed's id."), label: text("The feed's name, which the context takes.") } },
            description: "The feeds from list_collector_feeds.",
          },
        },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    add_contexts_from_feed_group: {
      description:
        "Makes a context named for a group in a collector's app, such as an X-Tasks filter group, with a context inside it for each of the group's feeds, such as one per tag, each following it; gives back the new context's id. Feeds added to the group later are offered by list_feed_group_news.",
      params: [
        { name: "collector", schema: collector_schema },
        { name: "group_id", schema: text("The group's id, from the group of a feed in list_collector_feeds.") },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    list_feed_group_news: {
      description: "Lists the feeds of the group a context was made from that no context inside it follows yet, such as a tag added to an X-Tasks filter group since; empty for a context not made from a group.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    stop_feed_group_news: {
      description: "Stops offering a context the feeds added to the group it was made from; the contexts inside it stay.",
      params: [{ name: "id", schema: id_of("context") }],
    },
    export_contexts: { description: "Exports every context, item and membership as one JSON object.", params: [] },
    add_context: {
      description: "Adds a context under another, or directly under Global, and gives back its id.",
      params: [
        { name: "name", schema: text("Its name, such as a project's.") },
        { name: "parent_id", schema: nullable_context, optional: true },
      ],
    },
    rename_context: {
      description: "Renames a context, Global included.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "name", schema: text("The new name.") },
      ],
    },
    set_context_notes: {
      description: "Sets what a context is about, in Markdown.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "notes", schema: text("The notes in Markdown.") },
      ],
    },
    set_context_archived: {
      description: "Archives a context, hiding it from the list, or brings it back. Global cannot be archived.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "is_archived", schema: { type: "boolean", description: "True to archive, false to bring back." } },
      ],
    },
    move_context: {
      description: "Moves a context under another, or directly under Global for null. Global itself cannot be moved.",
      params: [
        { name: "id", schema: id_of("context") },
        { name: "parent_id", schema: nullable_context },
        { name: "position", schema: { type: ["number", "null"], description: "Its place among its new siblings; null puts it last." }, optional: true },
      ],
    },
    remove_context: {
      description: "Deletes a context and every context inside it; the items stay in their own apps. Global cannot be deleted.",
      params: [{ name: "id", schema: id_of("context") }],
      destructive: true,
    },
    add_item: {
      description: "Adds an item from another app to contexts, such as an email sent from Thunderbird or a result of search_collector, and gives back the item's id.",
      params: [
        { name: "context_ids", schema: context_ids_schema },
        { name: "collector", schema: collector_schema },
        { name: "item", schema: found_item_schema },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    add_manual_item: {
      description: "Adds an item typed in by hand, such as a web link, to contexts, with the fields list_collectors names for that collector.",
      params: [
        { name: "context_ids", schema: context_ids_schema },
        { name: "collector", schema: collector_schema },
        { name: "values", schema: { type: "object", additionalProperties: { type: "string" }, description: "The fields by key, such as url and title." } },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    set_item_note: {
      description: "Sets the note on why an item is in a context.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "item_id", schema: id_of("item") },
        { name: "note", schema: text("The note.") },
      ],
    },
    remove_item: {
      description: "Takes an item out of a context; it stays in its own app. A conversation cannot be taken out of the last context holding it; delete_conversation deletes it.",
      params: [
        { name: "context_id", schema: id_of("context") },
        { name: "item_id", schema: id_of("item") },
      ],
    },
    add_item_to_contexts: {
      description: "Puts an item CODEX already keeps, such as one in another context, in more contexts, with a note on why.",
      params: [
        { name: "item_id", schema: id_of("item") },
        { name: "context_ids", schema: context_ids_schema },
        { name: "note", schema: text("Why it belongs there; may be empty."), optional: true },
      ],
    },
    move_item: {
      description: "Moves an item, such as a conversation, from one context to another, with its note; it stays in any other context holding it.",
      params: [
        { name: "context_id", schema: { ...id_of("context"), description: "The context it is in now." } },
        { name: "item_id", schema: id_of("item") },
        { name: "to_context_id", schema: { ...id_of("context"), description: "The context it moves to." } },
      ],
    },
    refresh_items: {
      description: "Asks each collector what became of its items, in one context or, for Global or null, everywhere, keeping new titles and states and marking missing the ones gone.",
      params: [{ name: "context_id", schema: nullable_context, optional: true }],
    },
    import_contexts: {
      description: "Imports an export_contexts file; rows with the same id are replaced by the file's.",
      params: [{ name: "json", schema: text("The whole file's text.") }],
    },
  },
});
