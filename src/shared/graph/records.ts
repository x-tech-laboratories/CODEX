// Reading the graph's rows for the calls, the rules and the screens: what a node is, which entities are joined into
// one, and links and entities as the page reads them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray, ne } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_items, contexts, items } from "../contexts/schema.ts";
import { blueprint_collector } from "../blueprints/model.ts";
import { conversation_collector } from "../conversations/model.ts";
import { item_sources } from "../privacy/screen.ts";
import { conversation_messages } from "../conversations/schema.ts";
import { drizzle_of } from "../feature.ts";
import { app_link } from "../links.ts";
import { parse_sources } from "../privacy/sources.ts";
import { node_key, parse_node_key, type EntityKind, type GraphEntity, type GraphEvidence, type GraphLink, type GraphNode, type GraphStatus, type LinkType, type MadeBy, type NodeKind } from "./model.ts";
import { graph_entities, graph_links } from "./schema.ts";

export type LinkRow = typeof graph_links.$inferSelect;
export type EntityRow = typeof graph_entities.$inferSelect;

// ── Values ───────────────────────────────────────────────────────────────────

export function now(): string {
  return new Date().toISOString();
}

export function parse_names(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
  } catch {
    return [];
  }
}

// A link is open while it has no end, or its end is still to come.
export function is_open(row: Pick<LinkRow, "valid_until">, at: string = now()): boolean {
  return row.valid_until === "" || row.valid_until > at;
}

// A name as it is compared: trimmed, its spaces folded, and in lower case.
export function name_key(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function from_key(row: Pick<LinkRow, "from_kind" | "from_id">): string {
  return node_key(row.from_kind as NodeKind, row.from_id);
}

export function to_key(row: Pick<LinkRow, "to_kind" | "to_id">): string {
  return node_key(row.to_kind as NodeKind, row.to_id);
}

// ── Joined entities ──────────────────────────────────────────────────────────

export interface Joins {
  // The entity each one is read as: the earliest made of those joined to it, itself when joined to none.
  rep_of: (entity_id: string) => string;
  // The entities read as each one, the representative first.
  members_of: (entity_id: string) => string[];
  // The accepted same_as links joining entities, by link id.
  join_links: Set<string>;
}

// Entities joined by accepted, open same_as links read as one: the one made first.
export function read_joins(database: SqlDatabase): Joins {
  const rows = drizzle_of(database)
    .select()
    .from(graph_links)
    .where(and(eq(graph_links.type, "same_as"), eq(graph_links.status, "accepted"), eq(graph_links.from_kind, "entity"), eq(graph_links.to_kind, "entity")))
    .all()
    .filter((row) => is_open(row));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let at = id;
    while (parent.has(at) && parent.get(at) !== at) at = parent.get(at)!;
    return at;
  };
  for (const row of rows) {
    const [first, second] = [find(row.from_id), find(row.to_id)];
    if (first !== second) parent.set(second, first);
  }
  const involved = [...new Set(rows.flatMap((row) => [row.from_id, row.to_id]))];
  const made = new Map(
    involved.length > 0
      ? drizzle_of(database)
          .select({ id: graph_entities.id, created_at: graph_entities.created_at })
          .from(graph_entities)
          .where(inArray(graph_entities.id, involved))
          .all()
          .map((row) => [row.id, row.created_at])
      : [],
  );
  const groups = new Map<string, string[]>();
  for (const id of involved) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const rep = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const group of groups.values()) {
    const ordered = group.filter((id) => made.has(id)).sort((first, second) => made.get(first)!.localeCompare(made.get(second)!) || first.localeCompare(second));
    for (const id of ordered) rep.set(id, ordered[0]!);
    members.set(ordered[0]!, ordered);
  }
  return {
    rep_of: (id) => rep.get(id) ?? id,
    members_of: (id) => members.get(rep.get(id) ?? id) ?? [id],
    join_links: new Set(rows.map((row) => row.id)),
  };
}

// The node a key names as reads show it: a joined entity as the one it is joined to.
export function canonical(joins: Joins, key: string): string {
  const parsed = parse_node_key(key);
  return parsed?.kind === "entity" ? node_key("entity", joins.rep_of(parsed.id)) : key;
}

// ── Nodes ────────────────────────────────────────────────────────────────────

function blank_node(kind: NodeKind, id: string): GraphNode {
  return { key: node_key(kind, id), kind, id, type: kind, label: id, alt_names: [], status: "accepted", uri: "", state: "", sources: [], joined: [], link_count: 0 };
}

// The nodes the keys name that exist, by key: contexts, items (a deleted conversation is no longer one) and entities.
export function read_nodes(database: SqlDatabase, keys: Iterable<string>, joins: Joins = read_joins(database)): Map<string, GraphNode> {
  const wanted: Record<NodeKind, string[]> = { context: [], item: [], entity: [] };
  for (const key of new Set(keys)) {
    const parsed = parse_node_key(key);
    if (parsed) wanted[parsed.kind].push(parsed.id);
  }
  const db = drizzle_of(database);
  const found = new Map<string, GraphNode>();
  if (wanted.context.length > 0) {
    for (const row of db.select({ id: contexts.id, name: contexts.name }).from(contexts).where(inArray(contexts.id, wanted.context)).all()) {
      found.set(node_key("context", row.id), { ...blank_node("context", row.id), label: row.name, uri: app_link(`#/context/${row.id}`) });
    }
  }
  if (wanted.item.length > 0) {
    for (const row of db.select().from(items).where(inArray(items.id, wanted.item)).all()) {
      const is_own = row.collector === conversation_collector || row.collector === blueprint_collector;
      if (is_own && row.status === "missing") continue;
      // A blueprint written during a run carries what that run read until the user makes it theirs.
      const sources = row.collector === blueprint_collector ? item_sources({ collector: row.collector, detail: parsed_detail(row.detail) }).slice(1) : is_own ? [] : [row.collector];
      found.set(node_key("item", row.id), { ...blank_node("item", row.id), type: row.kind, label: row.title, uri: row.uri, state: row.status, sources });
    }
  }
  if (wanted.entity.length > 0) {
    const all_ids = [...new Set(wanted.entity.flatMap((id) => joins.members_of(id)))];
    const rows = new Map(db.select().from(graph_entities).where(inArray(graph_entities.id, all_ids)).all().map((row) => [row.id, row]));
    const join_link_of = join_links_by_entity(database, joins);
    for (const id of wanted.entity) {
      const row = rows.get(id);
      if (!row) continue;
      const members = joins.members_of(id).filter((member) => member !== id && rows.has(member));
      const names = [...parse_names(row.alt_names), ...members.flatMap((member) => [rows.get(member)!.name, ...parse_names(rows.get(member)!.alt_names)])];
      const unique = [...new Map(names.filter((name) => name_key(name) !== name_key(row.name)).map((name) => [name_key(name), name])).values()];
      found.set(node_key("entity", id), {
        ...blank_node("entity", id),
        type: row.kind,
        label: row.name,
        alt_names: unique,
        status: row.status as GraphStatus,
        sources: [...new Set([row, ...members.map((member) => rows.get(member)!)].flatMap((each) => parse_sources(each.sources)))].sort(),
        joined: joins.rep_of(id) === id ? members.map((member) => ({ id: member, name: rows.get(member)!.name, link_id: join_link_of.get(member) ?? "" })) : [],
      });
    }
  }
  return found;
}

// For each joined entity other than its representative, an accepted same_as link that joins it, to undo.
function join_links_by_entity(database: SqlDatabase, joins: Joins): Map<string, string> {
  const by_entity = new Map<string, string>();
  if (joins.join_links.size === 0) return by_entity;
  const rows = drizzle_of(database).select().from(graph_links).where(inArray(graph_links.id, [...joins.join_links])).all();
  for (const row of rows) {
    for (const id of [row.from_id, row.to_id]) if (joins.rep_of(id) !== id && !by_entity.has(id)) by_entity.set(id, row.id);
  }
  return by_entity;
}

export function node_exists(database: SqlDatabase, key: string): boolean {
  return read_nodes(database, [key]).has(key);
}

// The node text names: a node key, or a bare context, item or entity id, which an engine may give from what it read.
export function resolve_node(database: SqlDatabase, text: string): string {
  const given = String(text ?? "").trim();
  if (!given) throw new Error("Name a node: a context, item or entity, by its id.");
  const parsed = parse_node_key(given);
  const candidates = parsed ? [given] : [node_key("context", given), node_key("item", given), node_key("entity", given)];
  const found = read_nodes(database, candidates);
  const key = candidates.find((candidate) => found.has(candidate));
  if (!key) throw new Error(`There is no context, item or entity ${given}.`);
  return key;
}

// The contexts, the items they hold and the conversations and blueprints still kept: what the whole graph draws besides entities.
function parsed_detail(text: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function held_item_ids(database: SqlDatabase): Set<string> {
  const db = drizzle_of(database);
  const held = new Set(db.selectDistinct({ item_id: context_items.item_id }).from(context_items).all().map((row) => row.item_id));
  for (const row of db.select({ id: items.id }).from(items).where(and(inArray(items.collector, [conversation_collector, blueprint_collector]), ne(items.status, "missing"))).all()) held.add(row.id);
  return held;
}

// ── Evidence ─────────────────────────────────────────────────────────────────

// What each evidence reference is called, by reference: an item's title, or who wrote a message.
export function evidence_labels(database: SqlDatabase, refs: Iterable<string>): Map<string, string> {
  const labels = new Map<string, string>();
  const item_ids: string[] = [];
  const message_ids: string[] = [];
  for (const ref of new Set(refs)) {
    if (ref.startsWith("item:")) item_ids.push(ref.slice(5));
    else if (ref.startsWith("message:")) message_ids.push(ref.slice(8));
  }
  const db = drizzle_of(database);
  if (item_ids.length > 0) for (const row of db.select({ id: items.id, title: items.title }).from(items).where(inArray(items.id, item_ids)).all()) labels.set(`item:${row.id}`, row.title);
  if (message_ids.length > 0) {
    for (const row of db.select({ id: conversation_messages.id, role: conversation_messages.role }).from(conversation_messages).where(inArray(conversation_messages.id, message_ids)).all()) {
      labels.set(`message:${row.id}`, row.role === "user" ? "Your message" : "An answer of the assistant");
    }
  }
  return labels;
}

function evidence_of(row: { evidence_ref: string; evidence_excerpt: string }, labels: Map<string, string>): GraphEvidence {
  return { ref: row.evidence_ref, excerpt: row.evidence_excerpt, label: labels.get(row.evidence_ref) ?? "" };
}

// ── Rows as read ─────────────────────────────────────────────────────────────

export function as_link(row: LinkRow, joins: Joins, labels: Map<string, string>): GraphLink {
  return {
    id: row.id,
    from: canonical(joins, from_key(row)),
    to: canonical(joins, to_key(row)),
    type: row.type as LinkType,
    label: row.label,
    status: row.status as GraphStatus,
    made_by: row.made_by as MadeBy,
    rule: row.rule,
    engine: row.engine,
    model: row.model,
    evidence: evidence_of(row, labels),
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    recorded_at: row.recorded_at,
    decided_at: row.decided_at,
    sources: parse_sources(row.sources),
  };
}

export function as_entity(row: EntityRow, labels: Map<string, string>): GraphEntity {
  return {
    id: row.id,
    kind: row.kind as EntityKind,
    name: row.name,
    alt_names: parse_names(row.alt_names),
    status: row.status as GraphStatus,
    made_by: row.made_by as MadeBy,
    rule: row.rule,
    engine: row.engine,
    model: row.model,
    evidence: evidence_of(row, labels),
    sources: parse_sources(row.sources),
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

export function link_row(database: SqlDatabase, id: string): LinkRow {
  const row = drizzle_of(database).select().from(graph_links).where(eq(graph_links.id, id)).get();
  if (!row) throw new Error(`There is no link ${id}.`);
  return row;
}

export function entity_row(database: SqlDatabase, id: string): EntityRow {
  const row = drizzle_of(database).select().from(graph_entities).where(eq(graph_entities.id, id)).get();
  if (!row) throw new Error(`There is no entity ${id}.`);
  return row;
}

// Every link with an end at one of the nodes given, of any status.
export function links_touching(database: SqlDatabase, keys: string[]): LinkRow[] {
  if (keys.length === 0) return [];
  const by_kind = new Map<string, string[]>();
  for (const key of keys) {
    const parsed = parse_node_key(key);
    if (parsed) by_kind.set(parsed.kind, [...(by_kind.get(parsed.kind) ?? []), parsed.id]);
  }
  const db = drizzle_of(database);
  const found = new Map<string, LinkRow>();
  for (const [kind, ids] of by_kind) {
    for (const row of db.select().from(graph_links).where(and(eq(graph_links.from_kind, kind), inArray(graph_links.from_id, ids))).all()) found.set(row.id, row);
    for (const row of db.select().from(graph_links).where(and(eq(graph_links.to_kind, kind), inArray(graph_links.to_id, ids))).all()) found.set(row.id, row);
  }
  return [...found.values()];
}
