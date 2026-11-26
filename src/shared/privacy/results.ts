// How each offered call that can answer with other apps' text is screened before its engine reads it: which source
// each part came from, what a hosted engine may not be sent, and so whether reading it counts as outside content.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { feed_key, item_id_of, type Feed, type FoundItem } from "../collectors/collector.ts";
import type { Blueprint, BlueprintSummary } from "../blueprints/model.ts";
import type { Interest } from "../interests/model.ts";
import type { ContextDetail, KeptItem, RefreshReport } from "../contexts/model.ts";
import { contexts_feature } from "../contexts/store.ts";
import type { NodeLinks } from "../graph/model.ts";
import type { SearchHit } from "../search/model.ts";
import { conversation_collector } from "../conversations/model.ts";
import { item_sources, merge_withheld, may_send, screen_entries, screen_sourced, type Screen, type Screened } from "./screen.ts";

// ── Screeners ────────────────────────────────────────────────────────────────

// A conversation item as a run may see it: its title, the user's words, without its latest exchange, which may carry
// what another run read.
function own_view<Entry extends { collector: string; snippet: string; detail: Record<string, string> }>(item: Entry): Entry {
  return item.collector === conversation_collector ? { ...item, snippet: "", detail: {} } : item;
}

type Screener = (database: SqlDatabase, screen: Screen, args: unknown[], value: unknown) => Screened<unknown>;

function feed_entry_key(collector: string, feed_id: string): string {
  return `feed:${feed_key(collector, feed_id)}`;
}

// A context's items, followed feeds and the group it was made from come from their apps; its name, notes, the
// names of the contexts also holding an item, and the notes on items are the user's own.
function screen_context(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const detail = value as ContextDetail;
  const items = screen_sourced(screen, detail.items.map(own_view), item_sources, (item) => item.id);
  const feeds = screen_entries(screen, detail.feeds, (feed) => feed.collector, (feed) => feed_entry_key(feed.collector, feed.feed_id), () => "followed feed");
  const seed = detail.seeded_from ? screen_entries(screen, [detail.seeded_from], (each) => each.collector, (each) => `group:${each.collector}:${each.group_id}`, () => "group") : null;
  const kept_ids = new Set(items.value.map((item) => item.id));
  const sources = new Set([...items.sources, ...feeds.sources, ...(seed?.sources ?? [])]);
  return {
    value: { ...detail, items: items.value, feeds: feeds.value, seeded_from: seed?.value[0] ?? null, card_places: detail.card_places.filter((place) => kept_ids.has(place.id)) },
    sources,
    ...merge_withheld([items, feeds, ...(seed ? [seed] : [])]),
  };
}

// A conversation is found only by its title here, since its latest exchange is not the run's to see.
function screen_kept_items(_database: SqlDatabase, screen: Screen, args: unknown[], value: unknown): Screened<unknown> {
  const query = String(args[0] ?? "").trim().toLowerCase();
  const found = (value as KeptItem[]).filter((item) => item.collector !== conversation_collector || item.title.toLowerCase().includes(query));
  return screen_sourced(screen, found.map(own_view), item_sources, (item) => item.id);
}

// One item, or a note in its place saying it was withheld.
function screen_kept_item(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const item = value as KeptItem;
  const screened = screen_sourced(screen, [own_view(item)], item_sources, (each) => each.id);
  return { ...screened, value: screened.value[0] ?? { id: item.id, withheld: true } };
}

// What one collector answered, all from the collector named in the call's first argument.
function from_collector<Entry>(kind: string, key_of: (collector: string, entry: Entry) => string): Screener {
  return (_database, screen, args, value) => {
    const collector = String(args[0] ?? "");
    return screen_entries(screen, value as Entry[], () => collector, (entry) => key_of(collector, entry), () => kind);
  };
}

// The feeds of the group a context was made from, which come from that group's collector.
function screen_group_news(database: SqlDatabase, screen: Screen, args: unknown[], value: unknown): Screened<unknown> {
  const collector = contexts_feature.methods.get_context(database, String(args[0] ?? "")).seeded_from?.collector ?? "";
  return screen_entries(screen, value as Feed[], () => collector, (feed) => feed_entry_key(collector, feed.id), () => "feed");
}

// A refresh answers with counts, which are CODEX's own, and a line from each collector that could not answer, whose
// words may come from its app; a hosted engine is not sent the line of a source not marked for it.
function screen_report(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const report = value as RefreshReport;
  const collector_of = (line: string): string => screen.collectors.find((collector) => line.startsWith(`${screen.label_of(collector)}:`)) ?? `problem:${line.split(":")[0]}`;
  const problems = screen_entries(screen, report.problems, collector_of, (line) => `problem:${line}`, () => "problem line");
  return { ...problems, value: { ...report, problems: problems.value } };
}

// Each hit carries its sources: an item its collector, an answer what its run had read, the user's own words none.
function screen_hits(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  return screen_sourced(screen, value as SearchHit[], (hit) => hit.sources, (hit) => (hit.kind === "item" ? hit.id : `${hit.kind}:${hit.id}`), (hit) => hit.kind);
}

// A node's links: the node itself withheld whole when its sources may not be sent, and each link when it or the node at
// its other end carries a source that may not.
function screen_node_links(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const { node, links } = value as NodeLinks;
  const own = screen_sourced(screen, [node], (each) => each.sources, (each) => `node:${each.key}`, () => "node");
  if (own.value.length === 0) return { value: { node: { key: node.key, withheld: true }, links: [] }, sources: own.sources, ...merge_withheld([own]) };
  const kept = screen_sourced(screen, links, (link) => [...link.sources, ...link.other.sources], (link) => `link:${link.id}`, () => "link");
  return { value: { node, links: kept.value }, sources: new Set([...own.sources, ...kept.sources]), ...merge_withheld([own, kept]) };
}

// A blueprint written during a run carries what that run had read until the user makes it theirs; an active one is
// the user's own and carries nothing.
function screen_blueprints(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  return screen_sourced(screen, value as BlueprintSummary[], (each) => each.sources, (each) => `blueprint:${each.id}`, () => "blueprint");
}

// One blueprint, or a note in its place, and each change proposed to it on its own sources.
function screen_blueprint(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  const blueprint = value as Blueprint;
  const own = screen_sourced(screen, [blueprint], (each) => each.sources, (each) => `blueprint:${each.id}`, () => "blueprint");
  if (own.value.length === 0) return { ...own, value: { id: blueprint.id, withheld: true } };
  const changes = screen_sourced(screen, blueprint.changes, (each) => each.sources, (each) => `blueprint_change:${each.id}`, () => "blueprint change");
  return { value: { ...blueprint, changes: changes.value }, sources: new Set([...own.sources, ...changes.sources]), ...merge_withheld([own, changes]) };
}

// The interests, each on the sources the run that proposed it had read; one the user added carries nothing.
function screen_interests(_database: SqlDatabase, screen: Screen, _args: unknown[], value: unknown): Screened<unknown> {
  return screen_sourced(screen, value as Interest[], (each) => each.sources, (each) => `interest:${each.id}`, () => "interest");
}

// Every offered call that can answer with other apps' text; a test holds this to the calls the policy says bring it.
export const result_screeners: Record<string, Screener> = {
  get_context: screen_context,
  search_kept_items: screen_kept_items,
  get_item: screen_kept_item,
  search_collector: from_collector<FoundItem>("item", (collector, item) => item_id_of(collector, item.source_id)),
  list_collector_feeds: from_collector<Feed>("feed", (collector, feed) => feed_entry_key(collector, feed.id)),
  list_feed_group_news: screen_group_news,
  refresh_items: screen_report,
  follow_feed: screen_report,
  search_index: screen_hits,
  get_node_links: screen_node_links,
  list_blueprints: screen_blueprints,
  get_blueprint: screen_blueprint,
  list_interests: screen_interests,
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
