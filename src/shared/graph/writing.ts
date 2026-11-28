// Writing the graph's rows: links and entities as the user, a rule, similarity or an engine makes them, the proposals
// the user decides, and the links left with an end that no longer exists.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, not, notInArray, or } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { contexts, items } from "../contexts/schema.ts";
import { conversation_collector } from "../conversations/model.ts";
import { conversation_messages } from "../conversations/schema.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import { link_types, parse_node_key, symmetric_link_types, type EvidenceInput, type GraphStatus, type LinkType, type MadeBy } from "./model.ts";
import { canonical, from_key, links_touching, now, read_joins, to_key, type EntityRow, type Joins, type LinkRow } from "./records.ts";
import { graph_decisions, graph_entities, graph_links } from "./schema.ts";

// ── Links ────────────────────────────────────────────────────────────────────

export interface NewLink {
  id?: string;
  from: string;
  to: string;
  type: LinkType;
  label?: string;
  status: GraphStatus;
  made_by: MadeBy;
  rule?: string;
  engine?: string;
  model?: string;
  evidence_ref?: string;
  evidence_excerpt?: string;
  valid_from?: string;
  sources?: string[];
}

export function checked_type(type: unknown): LinkType {
  if (!(link_types as readonly unknown[]).includes(type)) throw new Error(`A link's type is one of ${link_types.join(", ")}.`);
  return type as LinkType;
}

// A moment given as text, kept as an ISO timestamp; empty stays empty.
export function checked_moment(value: unknown, what: string): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const time = Date.parse(text);
  if (Number.isNaN(time)) throw new Error(`${what} is a date or moment, such as 2026-11-10 or 2026-11-10T18:30:00Z.`);
  return new Date(time).toISOString();
}

export function insert_link(database: SqlDatabase, link: NewLink): string {
  const id = link.id ?? new_id();
  const from = parse_node_key(link.from)!;
  const to = parse_node_key(link.to)!;
  const recorded_at = now();
  drizzle_of(database)
    .insert(graph_links)
    .values({
      id,
      from_kind: from.kind,
      from_id: from.id,
      to_kind: to.kind,
      to_id: to.id,
      type: link.type,
      label: link.label?.trim() ?? "",
      status: link.status,
      made_by: link.made_by,
      rule: link.rule ?? "",
      engine: link.engine ?? "",
      model: link.model ?? "",
      evidence_ref: link.evidence_ref ?? "",
      evidence_excerpt: link.evidence_excerpt ?? "",
      valid_from: link.valid_from ?? "",
      valid_until: "",
      recorded_at,
      decided_at: "",
      sources: JSON.stringify([...new Set(link.sources ?? [])].sort()),
    })
    .run();
  return id;
}

// The links of this type between the two nodes as reads see them, joined entities as one; either way round for a type
// that reads the same both ways.
export function same_links(database: SqlDatabase, from: string, to: string, type: LinkType | null, joins: Joins = read_joins(database)): LinkRow[] {
  const [first, second] = [canonical(joins, from), canonical(joins, to)];
  const members = (key: string) => {
    const parsed = parse_node_key(key)!;
    return parsed.kind === "entity" ? joins.members_of(parsed.id).map((id) => `entity:${id}`) : [key];
  };
  return links_touching(database, members(first)).filter((row) => {
    if (type !== null && row.type !== type) return false;
    const [at_from, at_to] = [canonical(joins, from_key(row)), canonical(joins, to_key(row))];
    if (at_from === first && at_to === second) return true;
    return (type === null || symmetric_link_types.has(type)) && at_from === second && at_to === first;
  });
}

// ── Decisions ────────────────────────────────────────────────────────────────

export function record_decision(database: SqlDatabase, target: "link" | "entity", row: Pick<LinkRow | EntityRow, "id" | "made_by" | "rule" | "engine" | "model">, decision: "accepted" | "rejected"): void {
  drizzle_of(database)
    .insert(graph_decisions)
    .values({ id: new_id(), target, target_id: row.id, made_by: row.made_by, rule: row.rule, engine: row.engine, model: row.model, decision, decided_at: now() })
    .run();
}

export function set_link_status(database: SqlDatabase, id: string, status: GraphStatus): void {
  drizzle_of(database).update(graph_links).set({ status, decided_at: now() }).where(eq(graph_links.id, id)).run();
}

export function set_entity_status(database: SqlDatabase, id: string, status: GraphStatus): void {
  drizzle_of(database).update(graph_entities).set({ status, decided_at: now() }).where(eq(graph_entities.id, id)).run();
}

// ── Evidence ─────────────────────────────────────────────────────────────────

const longest_excerpt = 280;

export function clip_excerpt(text: unknown): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > longest_excerpt ? `${flat.slice(0, longest_excerpt - 1)}…` : flat;
}

// What evidence names: its reference, and the sources whose content it carries.
export function resolve_evidence(database: SqlDatabase, evidence: EvidenceInput | null | undefined): { ref: string; sources: string[] } {
  if (!evidence || typeof evidence !== "object") return { ref: "", sources: [] };
  const db = drizzle_of(database);
  if (typeof evidence.item_id === "string" && evidence.item_id) {
    const row = db.select({ id: items.id, collector: items.collector }).from(items).where(eq(items.id, evidence.item_id)).get();
    if (!row) throw new Error(`There is no item ${evidence.item_id} to give as evidence.`);
    return { ref: `item:${row.id}`, sources: row.collector === conversation_collector ? [] : [row.collector] };
  }
  if (typeof evidence.message_id === "string" && evidence.message_id) {
    const row = db.select({ id: conversation_messages.id, role: conversation_messages.role, sources: conversation_messages.sources }).from(conversation_messages).where(eq(conversation_messages.id, evidence.message_id)).get();
    if (!row) throw new Error(`There is no message ${evidence.message_id} to give as evidence.`);
    return { ref: `message:${row.id}`, sources: row.role === "user" ? [] : parse_sources(row.sources) };
  }
  return { ref: "", sources: [] };
}

// ── Tidying ──────────────────────────────────────────────────────────────────

// Takes away every link with an end that no longer exists: a removed context or entity, an item never kept, or a
// deleted conversation. An item merely in no context keeps its links, which show again when it is back.
export function remove_dangling_links(database: SqlDatabase): number {
  const db = drizzle_of(database);
  const context_ids = db.select({ id: contexts.id }).from(contexts);
  const entity_ids = db.select({ id: graph_entities.id }).from(graph_entities);
  const item_ids = db.select({ id: items.id }).from(items).where(not(and(eq(items.collector, conversation_collector), eq(items.status, "missing"))!));
  const dangling = (kind: typeof graph_links.from_kind, id: typeof graph_links.from_id) =>
    or(and(eq(kind, "context"), notInArray(id, context_ids)), and(eq(kind, "entity"), notInArray(id, entity_ids)), and(eq(kind, "item"), notInArray(id, item_ids)));
  const result = db.delete(graph_links).where(or(dangling(graph_links.from_kind, graph_links.from_id), dangling(graph_links.to_kind, graph_links.to_id))).run();
  return Number(result.changes);
}
