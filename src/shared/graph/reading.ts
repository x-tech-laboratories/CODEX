// Reading the graph as the page draws it and the engine asks of it: the graph around a context or the whole of it,
// what one node is linked to, the proposals waiting, and how many links each node has.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_items, contexts } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { context_tree, subtree } from "../search/documents.ts";
import { node_key, parse_node_key, type GraphFilter, type GraphLink, type GraphNode, type GraphProposals, type GraphStatus, type GraphView, type NodeLinks, type ProposedLink } from "./model.ts";
import { as_entity, as_link, canonical, evidence_labels, from_key, held_item_ids, is_open, links_touching, read_joins, read_nodes, resolve_node, to_key, type Joins, type LinkRow } from "./records.ts";
import { graph_entities, graph_links } from "./schema.ts";

// ── Scope ────────────────────────────────────────────────────────────────────

export const default_graph_limit = 300;
export const most_graph_nodes = 5000;

interface Scope {
  // The contexts and items drawn, by node key, the context asked for first.
  keys: string[];
  structure: { from: string; to: string }[];
}

// A context with every context inside it and the items they hold, or every context not archived and every item kept.
function scope_of(database: SqlDatabase, context_id: string | null): Scope {
  const db = drizzle_of(database);
  const tree = context_tree(database);
  let context_ids: string[];
  if (context_id !== null) {
    if (!tree.has(context_id)) throw new Error(`There is no context ${context_id}.`);
    context_ids = [...subtree(tree, context_id)];
  } else {
    context_ids = db.select({ id: contexts.id }).from(contexts).where(eq(contexts.is_archived, 0)).all().map((row) => row.id);
  }
  const shown = new Set(context_ids);
  const structure: { from: string; to: string }[] = [];
  for (const id of context_ids) {
    const parent = tree.get(id)?.parent_id;
    if (parent && shown.has(parent)) structure.push({ from: node_key("context", parent), to: node_key("context", id) });
  }
  const memberships = context_ids.length > 0 ? db.select({ context_id: context_items.context_id, item_id: context_items.item_id }).from(context_items).where(inArray(context_items.context_id, context_ids)).all() : [];
  const item_keys = new Set<string>();
  for (const membership of memberships) {
    structure.push({ from: node_key("context", membership.context_id), to: node_key("item", membership.item_id) });
    item_keys.add(node_key("item", membership.item_id));
  }
  // The whole graph also holds the conversations in no context.
  if (context_id === null) for (const id of held_item_ids(database)) item_keys.add(node_key("item", id));
  return { keys: [...context_ids.map((id) => node_key("context", id)), ...item_keys], structure };
}

// ── Filters ──────────────────────────────────────────────────────────────────

const default_statuses: GraphStatus[] = ["accepted", "proposed"];

function passes(row: LinkRow, filter: GraphFilter, at: string): boolean {
  const statuses = filter.statuses?.length ? filter.statuses : default_statuses;
  if (!statuses.includes(row.status as GraphStatus)) return false;
  if (filter.link_types?.length && !filter.link_types.includes(row.type as never)) return false;
  return filter.include_closed === true || is_open(row, at);
}

function node_passes(node: GraphNode, filter: GraphFilter): boolean {
  if (node.kind === "entity" && node.status === "rejected" && !filter.statuses?.includes("rejected")) return false;
  return !filter.node_types?.length || filter.node_types.includes(node.kind) || filter.node_types.includes(node.type);
}

// ── The graph ────────────────────────────────────────────────────────────────

// The links kept between nodes that exist, each end read as the node it is joined to, never one node to itself.
function drawn_links(database: SqlDatabase, rows: LinkRow[], joins: Joins, filter: GraphFilter): GraphLink[] {
  const at = new Date().toISOString();
  const kept = rows.filter((row) => passes(row, filter, at) && !joins.join_links.has(row.id));
  const labels = evidence_labels(database, kept.map((row) => row.evidence_ref).filter(Boolean));
  return kept.map((row) => as_link(row, joins, labels)).filter((link) => link.from !== link.to);
}

// The graph around a context, or the whole graph: its nodes, the links among them and how many more there were.
export function get_graph(database: SqlDatabase, context_id: string | null = null, filter: GraphFilter = {}): GraphView {
  const joins = read_joins(database);
  const scope = scope_of(database, context_id || null);
  const base = new Set(scope.keys);
  let links: GraphLink[];
  let entity_keys: Set<string>;
  if (context_id) {
    const reached = drawn_links(database, links_touching(database, scope.keys), joins, filter);
    entity_keys = new Set(reached.flatMap((link) => [link.from, link.to]).filter((key) => key.startsWith("entity:") && !base.has(key)));
    const members = [...entity_keys].flatMap((key) => joins.members_of(key.slice(7)).map((id) => node_key("entity", id)));
    const among = drawn_links(database, links_touching(database, members), joins, filter);
    links = [...new Map([...reached, ...among].map((link) => [link.id, link])).values()];
  } else {
    links = drawn_links(database, drizzle_of(database).select().from(graph_links).all(), joins, filter);
    entity_keys = new Set(drizzle_of(database).select({ id: graph_entities.id }).from(graph_entities).all().map((row) => canonical(joins, node_key("entity", row.id))));
  }
  const nodes = read_nodes(database, [...scope.keys, ...entity_keys], joins);
  const wanted = new Map([...nodes].filter(([, node]) => node_passes(node, filter)));
  const kept_links = links.filter((link) => wanted.has(link.from) && wanted.has(link.to));
  for (const link of kept_links) {
    wanted.get(link.from)!.link_count += 1;
    wanted.get(link.to)!.link_count += 1;
  }
  // Contexts first, the one asked for leading, then items and entities with the most links.
  const rank = (node: GraphNode) => (node.kind === "context" ? 0 : node.kind === "item" ? 1 : 2);
  const order = new Map(scope.keys.map((key, index) => [key, index]));
  const sorted = [...wanted.values()].sort((first, second) => rank(first) - rank(second) || (first.kind === "context" ? order.get(first.key)! - order.get(second.key)! : 0) || second.link_count - first.link_count || first.label.localeCompare(second.label));
  const limit = Math.max(1, Math.min(most_graph_nodes, Math.floor(Number(filter.limit) || default_graph_limit)));
  const shown = sorted.slice(0, limit);
  const shown_keys = new Set(shown.map((node) => node.key));
  const shown_links = kept_links.filter((link) => shown_keys.has(link.from) && shown_keys.has(link.to));
  return {
    nodes: shown,
    links: shown_links,
    structure: scope.structure.filter((edge) => shown_keys.has(edge.from) && shown_keys.has(edge.to)),
    hidden_nodes: sorted.length - shown.length,
    hidden_links: kept_links.length - shown_links.length,
  };
}

// ── One node ─────────────────────────────────────────────────────────────────

// Every link of a node, of any status, open or closed, the joins within an entity left to its joined list.
export function get_node_links(database: SqlDatabase, node: string): NodeLinks {
  const joins = read_joins(database);
  const key = canonical(joins, resolve_node(database, node));
  const parsed = parse_node_key(key)!;
  const own = parsed.kind === "entity" ? joins.members_of(parsed.id).map((id) => node_key("entity", id)) : [key];
  const rows = links_touching(database, own).filter((row) => !joins.join_links.has(row.id));
  const labels = evidence_labels(database, rows.map((row) => row.evidence_ref).filter(Boolean));
  const links = rows.map((row) => as_link(row, joins, labels)).filter((link) => link.from !== link.to);
  const nodes = read_nodes(database, [key, ...links.flatMap((link) => [link.from, link.to])], joins);
  const self = nodes.get(key)!;
  const at = new Date().toISOString();
  const order: Record<GraphStatus, number> = { proposed: 0, accepted: 1, rejected: 2 };
  const listed = links
    .flatMap((link) => {
      const other = nodes.get(link.from === key ? link.to : link.from);
      if (!other) return [];
      const direction: "out" | "in" | "both" = link.type === "related_to" || link.type === "same_as" ? "both" : link.from === key ? "out" : "in";
      return [{ ...link, direction, other }];
    })
    .sort((first, second) => order[first.status] - order[second.status] || Number(!is_open(first, at)) - Number(!is_open(second, at)) || second.recorded_at.localeCompare(first.recorded_at));
  self.link_count = listed.filter((link) => link.status !== "rejected" && is_open(link, at)).length;
  return { node: self, links: listed };
}

// ── Proposals ────────────────────────────────────────────────────────────────

// The links and entities waiting for the user, in one context and those inside it with the entities linked there, or
// everywhere; oldest first.
export function list_graph_proposals(database: SqlDatabase, context_id: string | null = null): GraphProposals {
  const joins = read_joins(database);
  const db = drizzle_of(database);
  let rows: LinkRow[];
  let entity_ids: Set<string> | null = null;
  if (context_id) {
    const scope = scope_of(database, context_id);
    const touching = links_touching(database, scope.keys);
    entity_ids = new Set(touching.flatMap((row) => [from_key(row), to_key(row)]).filter((key) => key.startsWith("entity:")).map((key) => key.slice(7)));
    const reached = links_touching(database, [...entity_ids].map((id) => node_key("entity", id)));
    rows = [...new Map([...touching, ...reached].map((row) => [row.id, row])).values()];
  } else rows = db.select().from(graph_links).where(eq(graph_links.status, "proposed")).all();
  const at = new Date().toISOString();
  const waiting = rows.filter((row) => row.status === "proposed" && is_open(row, at));
  const entity_rows = db
    .select()
    .from(graph_entities)
    .where(and(eq(graph_entities.status, "proposed"), entity_ids ? inArray(graph_entities.id, [...entity_ids]) : undefined))
    .all();
  const labels = evidence_labels(database, [...waiting, ...entity_rows].map((row) => row.evidence_ref).filter(Boolean));
  const links = waiting.map((row) => as_link(row, joins, labels));
  const nodes = read_nodes(database, links.flatMap((link) => [link.from, link.to]), joins);
  const proposed: ProposedLink[] = links.flatMap((link) => {
    const [from_node, to_node] = [nodes.get(link.from), nodes.get(link.to)];
    return from_node && to_node && link.from !== link.to ? [{ ...link, from_node, to_node }] : [];
  });
  return {
    links: proposed.sort((first, second) => first.recorded_at.localeCompare(second.recorded_at) || first.id.localeCompare(second.id)),
    entities: entity_rows.map((row) => as_entity(row, labels)).sort((first, second) => first.created_at.localeCompare(second.created_at) || first.id.localeCompare(second.id)),
  };
}

// How many open links, accepted or proposed, a context and each item it holds has, by node key.
export function list_link_counts(database: SqlDatabase, context_id: string): Record<string, number> {
  const ids = drizzle_of(database).select({ item_id: context_items.item_id }).from(context_items).where(eq(context_items.context_id, context_id)).all().map((row) => node_key("item", row.item_id));
  const keys = [node_key("context", context_id), ...ids];
  const joins = read_joins(database);
  const at = new Date().toISOString();
  const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of links_touching(database, keys)) {
    if (row.status === "rejected" || !is_open(row, at) || joins.join_links.has(row.id)) continue;
    for (const end of new Set([from_key(row), to_key(row)])) if (end in counts) counts[end]! += 1;
  }
  return counts;
}
