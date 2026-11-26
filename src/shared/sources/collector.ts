// The bundled plugin that reads any app answering the standard item calls, read-only: one collector per app the user
// added, each with its own id, label, kinds and marks, so a new X-app becomes a source by configuration alone. A refresh
// asks each app only for what changed since the last one, by list_item_changes and a cursor kept on this device.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { Item } from "@x-tech-laboratories/x-libs/items";
import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { Collector, FoundItem } from "../collectors/collector.ts";
import type { ContextPlugin, ContextPluginApi } from "../collectors/host.ts";
import { item_sources_manifest } from "../collectors/manifests.ts";
import { items } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { changes, get, is_deleted, page_size, search } from "./client.ts";
import { collector_of_source, type ItemSourceRecord } from "./model.ts";
import { read_sources } from "./records.ts";
import { item_source_cursors } from "./schema.ts";

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

  const read_whole = async (ids: string[]) => {
    const found = await get(source, ids);
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
    const batch = await changes(source, since, page_size);
    for (const change of batch) changed.set(change.id, is_deleted(change) ? null : (change as Item));
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

// ── Plugin ───────────────────────────────────────────────────────────────────

export function source_collector(database: SqlDatabase, source: ItemSourceRecord): Collector {
  const collector = collector_of_source(source.id);
  return {
    label: source.name,
    kinds: source.kinds.map((each) => each.kind),
    marked_alone: true,
    search: async (query) => (await search(source, query, most_found)).map(found_of),
    resolve: (source_ids) => resolve_source(database, source, collector, source_ids),
    // Only the snippet is there to index, as the item calls give nothing more.
    content: async (source_ids) => Object.fromEntries((await get(source, source_ids)).filter((item) => String(item.snippet ?? "").trim()).map((item) => [item.id, String(item.snippet)])),
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
