// The bundled plugin that reads any app answering the standard item calls, read-only: one collector per app the user
// added, each with its own id, label, kinds and marks, so a new X-app becomes a source by configuration alone. A refresh
// asks each app only for what changed since the last one, by list_item_changes and a cursor kept on this device. An
// item's full text, from get_item_texts for a kind that has it, goes only to the local search index, read again only
// once the item's changed_at moved; an app without the call gives its snippet.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq } from "@x-tech-laboratories/x-libs/drizzle";
import { is_deleted_item, item_client, type ItemApp, type ItemClient } from "@x-tech-laboratories/x-libs/item_client";
import type { Item, ItemKind } from "@x-tech-laboratories/x-libs/items";
import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { item_id_of, type Collector, type FoundItem } from "../collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { item_sources_manifest } from "../collectors/manifests.ts";
import { items } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { collector_of_source, type ItemSourceRecord, type SourceKind } from "./model.ts";
import { read_sources } from "./records.ts";
import { item_source_cursors, item_source_stamps } from "./schema.ts";

// ── Client ───────────────────────────────────────────────────────────────────

const page_size = 100;

const client_of = (source: ItemApp): ItemClient => item_client(source, { page_size });

// The app's kinds now, each with whether it has text, in plain words when it cannot answer.
export async function list_kinds(source: ItemApp): Promise<SourceKind[]> {
  return (await client_of(source).list_item_kinds()).map(({ kind, label, has_text }: ItemKind) => ({ kind, label, ...(has_text ? { has_text: true } : {}) }));
}

// ── Items ────────────────────────────────────────────────────────────────────

const most_found = 30;

// The most pages of changes one refresh reads before reading the items themselves instead.
const most_pages = 20;

export function found_of(item: Item): FoundItem {
  return {
    source_id: item.id,
    kind: item.kind,
    title: String(item.title ?? "").trim() || "Untitled",
    snippet: String(item.snippet ?? ""),
    uri: String(item.link ?? ""),
    status: String(item.status ?? ""),
    detail: item.detail && typeof item.detail === "object" ? Object.fromEntries(Object.entries(item.detail).map(([key, value]) => [key, String(value)])) : {},
  };
}

function parse_detail(text: string): Record<string, string> {
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch {
    return {};
  }
}

// ── Cursors ──────────────────────────────────────────────────────────────────

export function read_cursor(database: SqlDatabase, source_id: string): string | null {
  return drizzle_of(database).select().from(item_source_cursors).where(eq(item_source_cursors.source_id, source_id)).get()?.cursor ?? null;
}

function write_cursor(database: SqlDatabase, source_id: string, cursor: string): void {
  const updated_at = new Date().toISOString();
  drizzle_of(database)
    .insert(item_source_cursors)
    .values({ source_id, cursor, updated_at })
    .onConflictDoUpdate({ target: item_source_cursors.source_id, set: { cursor, updated_at } })
    .run();
}

export function forget_cursor(database: SqlDatabase, source_id: string): void {
  drizzle_of(database).delete(item_source_cursors).where(eq(item_source_cursors.source_id, source_id)).run();
}

// ── Stamps ───────────────────────────────────────────────────────────────────

// Keeps when each item last changed as the app said, by kept item id.
function write_stamps(database: SqlDatabase, source: ItemSourceRecord, found: { id: string; changed_at: unknown }[]): void {
  const collector = collector_of_source(source.id);
  const db = drizzle_of(database);
  for (const { id, changed_at } of found) {
    if (typeof changed_at !== "string" || changed_at === "") continue;
    const item_id = item_id_of(collector, id);
    db.insert(item_source_stamps).values({ item_id, source_id: source.id, changed_at }).onConflictDoUpdate({ target: item_source_stamps.item_id, set: { changed_at } }).run();
  }
}

// Forgets how far an app was read and when its items changed, as when it is taken away.
export function forget_source_reading(database: SqlDatabase, source_id: string): void {
  forget_cursor(database, source_id);
  drizzle_of(database).delete(item_source_stamps).where(eq(item_source_stamps.source_id, source_id)).run();
}

const latest = (times: string[], from: string | null) => times.reduce<string | null>((last, time) => (last === null || time > last ? time : last), from);

// What became of the items asked for: those changed since the cursor as the app now says, those deleted left out, the
// rest as kept, and any not kept yet read whole. The cursor moves on only when every kept item was asked for, so a
// refresh of one context never skips a change to an item it did not ask about.
async function resolve_source(database: SqlDatabase, source: ItemSourceRecord, collector: string, source_ids: string[]): Promise<Record<string, FoundItem>> {
  const kept = new Map(drizzle_of(database).select().from(items).where(eq(items.collector, collector)).all().map((row) => [row.source_id, row]));
  const asked = new Set(source_ids);
  const asks_all = [...kept.keys()].every((id) => asked.has(id));
  const answers: Record<string, FoundItem> = {};
  const cursor = read_cursor(database, source.id);

  const client = client_of(source);
  const read_whole = async (ids: string[]) => {
    const found = await client.get_items(ids);
    write_stamps(database, source, found);
    for (const item of found) if (asked.has(item.id)) answers[item.id] = found_of(item);
    return found.map((item) => item.changed_at).filter((time): time is string => typeof time === "string");
  };

  if (cursor === null) {
    const times = await read_whole(source_ids);
    const next = latest(times, null);
    if (asks_all && next !== null) write_cursor(database, source.id, next);
    return answers;
  }

  const changed = new Map<string, Item | null>();
  let since = cursor;
  let finished = false;
  for (let page = 0; page < most_pages; page++) {
    const batch = await client.list_item_changes(since, page_size);
    for (const change of batch) changed.set(change.id, is_deleted_item(change) ? null : (change as Item));
    if (batch.length > 0) since = latest(batch.map((change) => change.changed_at), since)!;
    if (batch.length < page_size) {
      finished = true;
      break;
    }
  }
  if (!finished) {
    // Too much changed to read change by change: every item is read again, and the cursor starts from there.
    const times = await read_whole(source_ids);
    if (asks_all) write_cursor(database, source.id, latest(times, since)!);
    return answers;
  }

  const unknown: string[] = [];
  write_stamps(database, source, [...changed.values()].filter((item): item is Item => item !== null && asked.has(item.id)));
  for (const id of source_ids) {
    if (changed.has(id)) {
      const item = changed.get(id);
      if (item) answers[id] = found_of(item);
      continue;
    }
    const row = kept.get(id);
    if (!row) unknown.push(id);
    else if (row.status !== "missing") answers[id] = { source_id: id, kind: row.kind, title: row.title, snippet: row.snippet, uri: row.uri, status: row.status, detail: parse_detail(row.detail) };
  }
  if (unknown.length > 0) await read_whole(unknown);
  if (asks_all) write_cursor(database, source.id, since);
  return answers;
}

// ── Text ─────────────────────────────────────────────────────────────────────

// Each item's text for the local index: its full text where its kind has text and the app answers get_item_texts,
// otherwise its snippet. Nothing of it is kept in the store.
async function read_texts(source: ItemSourceRecord, source_ids: string[]): Promise<Record<string, string>> {
  const client = client_of(source);
  const found = await client.get_items(source_ids);
  const with_text = new Set((await client.list_item_kinds()).filter((each) => each.has_text).map((each) => each.kind));
  const wanted = found.filter((item) => with_text.has(item.kind)).map((item) => item.id);
  const texts = wanted.length > 0 ? await client.get_item_texts(wanted) : null;
  const full = new Map((texts ?? []).map((each) => [each.id, each.text]));
  const answers: Record<string, string> = {};
  for (const item of found) {
    const text = full.get(item.id) ?? String(item.snippet ?? "");
    if (text.trim()) answers[item.id] = text;
  }
  return answers;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function source_collector(database: SqlDatabase, source: ItemSourceRecord): Collector {
  const collector = collector_of_source(source.id);
  return {
    label: source.name,
    kinds: source.kinds.map((each) => each.kind),
    marked_alone: true,
    search: async (query) => (await client_of(source).search_items(query, most_found)).map(found_of),
    resolve: (source_ids) => resolve_source(database, source, collector, source_ids),
    content: (source_ids) => read_texts(source, source_ids),
  };
}

// The plugin for the database the plugin host was opened on, with a collector for each app added in Settings.
export function item_sources_plugin(database: SqlDatabase): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...item_sources_manifest,
    start: (context) => {
      for (const source of read_sources(database)) context.provide("collector", collector_of_source(source.id), source_collector(database, source));
    },
  });
}
