// How each offered call that can answer with other apps' text is screened before its engine reads it: which source
// each part came from, what a hosted engine may not be sent, and so whether reading it counts as outside content.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { feed_key, item_id_of, type Feed, type FoundItem } from "../collectors/collector.ts";
import type { ContextDetail, KeptItem, RefreshReport } from "../contexts/model.ts";
import { contexts_feature } from "../contexts/store.ts";
import type { SearchHit } from "../search/model.ts";
import { may_send, screen_entries, screen_sourced, type Screen, type Screened } from "./screen.ts";

// ── Screeners ────────────────────────────────────────────────────────────────

type Screener = (database: SqlDatabase, screen: Screen, args: unknown[], value: unknown) => Screened<unknown>;

function feed_entry_key(collector: string, feed_id: string): string {
  return `feed:${feed_key(collector, feed_id)}`;
}

// A context's items, followed feeds and the group it was made from come from their apps; its name, notes, the
// names of the contexts also holding an item, and the notes on items are the user's own.
function screen_context(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const detail = value as ContextDetail;
  const items = screen_entries(screen, detail.items, (item) => item.collector, (item) => item.id);
  const feeds = screen_entries(screen, detail.feeds, (feed) => feed.collector, (feed) => feed_entry_key(feed.collector, feed.feed_id));
  const seed = detail.seeded_from ? screen_entries(screen, [detail.seeded_from], (each) => each.collector, (each) => `group:${each.collector}:${each.group_id}`) : null;
  const kept_ids = new Set(items.value.map((item) => item.id));
  const sources = new Set([...items.sources, ...feeds.sources, ...(seed?.sources ?? [])]);
  const withheld = new Map<string, number>();
  for (const part of [items.withheld, feeds.withheld, seed?.withheld ?? new Map<string, number>()]) for (const [collector, count] of part) withheld.set(collector, (withheld.get(collector) ?? 0) + count);
  return {
    value: { ...detail, items: items.value, feeds: feeds.value, seeded_from: seed?.value[0] ?? null, card_places: detail.card_places.filter((place) => kept_ids.has(place.id)) },
    sources,
    withheld,
  };
}

function screen_kept_items(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  return screen_entries(screen, value as KeptItem[], (item) => item.collector, (item) => item.id);
}

// One item, or a note in its place saying it was withheld.
function screen_kept_item(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const item = value as KeptItem;
  const screened = screen_entries(screen, [item], (each) => each.collector, (each) => each.id);
  return { ...screened, value: screened.value[0] ?? { id: item.id, withheld: true } };
}

// What one collector answered, all from the collector named in the call's first argument.
function from_collector<Entry>(key_of: (collector: string, entry: Entry) => string): Screener {
  return (_database, screen, args, value) => {
    const collector = String(args[0] ?? "");
    return screen_entries(screen, value as Entry[], () => collector, (entry) => key_of(collector, entry));
  };
}

// The feeds of the group a context was made from, which come from that group's collector.
function screen_group_news(database: SqlDatabase, screen: Screen, args: unknown[], value: unknown): Screened<unknown> {
  const collector = contexts_feature.methods.get_context(database, String(args[0] ?? "")).seeded_from?.collector ?? "";
  return screen_entries(screen, value as Feed[], () => collector, (feed) => feed_entry_key(collector, feed.id));
}

// A refresh answers with counts, which are CODEX's own, and a line from each collector that could not answer, whose
// words may come from its app; a hosted engine is not sent the line of a source not marked for it.
function screen_report(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const report = value as RefreshReport;
  const collector_of = (line: string): string => screen.collectors.find((collector) => line.startsWith(`${screen.label_of(collector)}:`)) ?? `problem:${line.split(":")[0]}`;
  const problems = screen_entries(screen, report.problems, collector_of, (line) => `problem:${line}`);
  return { ...problems, value: { ...report, problems: problems.value } };
}

// Each hit carries its sources: an item its collector, an answer what its run had read, the user's own words none.
function screen_hits(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  return screen_sourced(screen, value as SearchHit[], (hit) => hit.sources, (hit) => (hit.kind === "item" ? hit.id : `${hit.kind}:${hit.id}`));
}

// Every offered call that can answer with other apps' text; a test holds this to the calls the policy says bring it.
export const result_screeners: Record<string, Screener> = {
  get_context: screen_context,
  search_kept_items: screen_kept_items,
  get_item: screen_kept_item,
  search_collector: from_collector<FoundItem>((collector, item) => item_id_of(collector, item.source_id)),
  list_collector_feeds: from_collector<Feed>((collector, feed) => feed_entry_key(collector, feed.id)),
  list_feed_group_news: screen_group_news,
  refresh_items: screen_report,
  follow_feed: screen_report,
  search_index: screen_hits,
};

// The answer as the engine may read it. A call with no screener is held back whole from a hosted engine unless every
// source may be sent to it, and always counts as outside content.
export function screen_result(database: SqlDatabase, screen: Screen, method: string, args: unknown[], value: unknown): Screened<unknown> {
  const screener = result_screeners[method];
  if (screener) return screener(database, screen, args, value);
  const unknown_source = `call:${method}`;
  if (!may_send(screen, unknown_source)) return { value: `${method} answered, but its answer was withheld from this hosted engine.`, sources: new Set(), withheld: new Map() };
  return { value, sources: new Set([unknown_source]), withheld: new Map() };
}
