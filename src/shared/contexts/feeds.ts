// What the collectors say: searching and reading their apps, the feeds a context follows, and the refresh that asks
// each collector what became of its items.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { feed_key, item_id_of, type CollectorSummary, type Feed, type FoundItem, type ReadItem } from "../collectors/collector.ts";
import { open_plugin_host } from "../collectors/host.ts";
import { drizzle_of } from "../feature.ts";
import { scope_of, type RefreshReport } from "./model.ts";
import { context_feeds, context_items, context_seeds, items } from "./schema.ts";
import { add_context, context_row, feeds_of, holders_of, keep_item, now, seed_of, subtree_of } from "./records.ts";

// ── Collectors ───────────────────────────────────────────────────────────────

async function running_collectors(database: SqlDatabase) {
  return (await open_plugin_host(database)).providers("collector");
}

export async function collector_of(database: SqlDatabase, id: string) {
  const found = (await running_collectors(database)).find((provided) => provided.id === id);
  if (!found) throw new Error(`The ${id} collector is not running; turn its plugin on under Settings → Plugins.`);
  return found.value;
}

export async function list_collectors(database: SqlDatabase): Promise<CollectorSummary[]> {
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
export async function search_collector(database: SqlDatabase, collector: string, query: string): Promise<(FoundItem & { kept_in: string[] })[]> {
  const source = await collector_of(database, collector);
  if (!source.search) throw new Error(`The ${source.label} collector cannot search; its items are sent to CODEX from elsewhere.`);
  const found = await source.search(query);
  const holders = holders_of(database, found.map((item) => item_id_of(collector, item.source_id)));
  return found.map((item) => ({ ...item, kept_in: (holders.get(item_id_of(collector, item.source_id)) ?? []).map((holder) => holder.id) }));
}

// What the collector says now of one item in its app, by its id there, with the contexts that already hold it.
export async function get_source_item(database: SqlDatabase, collector: string, source_id: string): Promise<FoundItem & { kept_in: string[] }> {
  const source = await collector_of(database, collector);
  if (!source.resolve) throw new Error(`The ${source.label} collector cannot read one item; search it with search_collector.`);
  const id = source_id.trim();
  const found = (await source.resolve([id]))[id];
  if (!found) throw new Error(`${source.label} has no item ${id}.`);
  const holders = holders_of(database, [item_id_of(collector, found.source_id)]);
  return { ...found, kept_in: (holders.get(item_id_of(collector, found.source_id)) ?? []).map((holder) => holder.id) };
}

// One item's whole current content and attributes, read live from its app and never kept, with the contexts holding it.
export async function get_source_content(database: SqlDatabase, collector: string, source_id: string): Promise<ReadItem & { kept_in: string[] }> {
  const source = await collector_of(database, collector);
  if (!source.read) throw new Error(`The ${source.label} collector cannot read an item's content; read what it says of one with get_source_item.`);
  const id = source_id.trim();
  const found = await source.read(id);
  if (!found) throw new Error(`${source.label} has no item ${id}.`);
  const holders = holders_of(database, [item_id_of(collector, found.source_id)]);
  return { ...found, kept_in: (holders.get(item_id_of(collector, found.source_id)) ?? []).map((holder) => holder.id) };
}

export async function list_collector_feeds(database: SqlDatabase, collector: string): Promise<Feed[]> {
  const source = await collector_of(database, collector);
  if (!source.feeds) throw new Error(`The ${source.label} collector has nothing to follow.`);
  return source.feeds.list();
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

export async function follow_feed(database: SqlDatabase, context_id: string, collector: string, feed_id: string, label: string): Promise<RefreshReport> {
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
export function unfollow_feed(database: SqlDatabase, context_id: string, collector: string, feed_id: string): void {
  in_transaction(database, () => {
    const db = drizzle_of(database);
    db.delete(context_feeds).where(and(eq(context_feeds.context_id, context_id), eq(context_feeds.collector, collector), eq(context_feeds.feed_id, feed_id))).run();
    db.delete(context_items).where(and(eq(context_items.context_id, context_id), eq(context_items.via, feed_key(collector, feed_id)))).run();
  });
}

// Makes a context for each feed, named for it and following it, under the parent given; gives back their ids.
export async function add_contexts_from_feeds(database: SqlDatabase, collector: string, feeds: { id: string; label: string }[], parent_id: string | null = null): Promise<string[]> {
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
export async function add_contexts_from_feed_group(database: SqlDatabase, collector: string, group_id: string, parent_id: string | null = null): Promise<string> {
  const feeds = outer_feeds_of(await list_collector_feeds(database, collector), group_id);
  const group = feeds[0]?.group;
  if (!group) throw new Error("That group has nothing to follow.");
  const id = add_context(database, group.label, parent_id);
  drizzle_of(database).insert(context_seeds).values({ context_id: id, collector, group_id, label: group.label, added_at: now() }).run();
  await add_contexts_from_feeds(database, collector, feeds.map((feed) => ({ id: feed.id, label: feed.label })), id);
  return id;
}

// The feeds of the group a context was made from that no context inside it follows yet, such as a tag added later.
export async function list_feed_group_news(database: SqlDatabase, context_id: string): Promise<Feed[]> {
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
export async function refresh_items(database: SqlDatabase, given_context: string | null = null): Promise<RefreshReport> {
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
