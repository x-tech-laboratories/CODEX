// What the index holds, read from the store: every context (its name and notes), every item some context keeps (its
// title, snippet and the user's notes on it; a conversation's title and notes alone), every message of the user
// and the assistant, placed in the contexts holding its conversation, every entity of the graph not rejected (its
// name, kind and other names), placed in the contexts it is linked to, and every blueprint. An item's text from its
// app is read by the indexer, through its collector, and held only in the index; for an app read through the item
// calls, again once the item's changed_at in that app moved.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { inArray, ne } from "@x-tech-laboratories/x-libs/drizzle";
import { blueprint_collector, blueprint_item_id } from "../blueprints/model.ts";
import { blueprints } from "../blueprints/schema.ts";
import { context_items, contexts, items } from "../contexts/schema.ts";
import { conversation_messages } from "../conversations/schema.ts";
import { conversation_collector, conversation_item_id } from "../conversations/model.ts";
import { drizzle_of } from "../feature.ts";
import { graph_entities, graph_links } from "../graph/schema.ts";
import { parse_sources } from "../privacy/sources.ts";
import { item_source_stamps } from "../sources/schema.ts";
import type { HitKind } from "./model.ts";
import { text_hash } from "./text.ts";

// ── Documents ────────────────────────────────────────────────────────────────

export interface SourceDocument {
  // "item:<id>", "context:<id>", "message:<id>" or "entity:<id>".
  key: string;
  kind: HitKind;
  ref_id: string;
  // The item's collector; empty for what the user or the assistant wrote in CODEX.
  collector: string;
  source_id: string;
  title: string;
  // What the store says of it: an item's snippet and notes, a context's notes, a message's text.
  body: string;
  context_ids: string[];
  // The sources whose content it carries: an item's collector, or what an answer's run had read; none for what the
  // user wrote.
  sources: string[];
  // Changes when what the item's app said of it changes, which is when its text is read again.
  source_hash: string;
}

// Every document the store holds now.
export function read_documents(database: SqlDatabase): SourceDocument[] {
  const db = drizzle_of(database);
  const documents: SourceDocument[] = [];
  for (const context of db.select().from(contexts).all()) {
    documents.push({ key: `context:${context.id}`, kind: "context", ref_id: context.id, collector: "", source_id: "", title: context.name, body: context.notes, context_ids: [context.id], sources: [], source_hash: "" });
  }
  const memberships = db.select({ item_id: context_items.item_id, context_id: context_items.context_id, note: context_items.note }).from(context_items).all();
  const held = new Map<string, { context_ids: string[]; notes: string[] }>();
  for (const membership of memberships) {
    const entry = held.get(membership.item_id) ?? { context_ids: [], notes: [] };
    entry.context_ids.push(membership.context_id);
    if (membership.note.trim()) entry.notes.push(membership.note.trim());
    held.set(membership.item_id, entry);
  }
  const kept = held.size > 0 ? db.select().from(items).where(inArray(items.id, [...held.keys()])).all() : [];
  // When an app read through the item calls last changed each item, so a change past its snippet is read again too.
  const stamps = new Map(db.select().from(item_source_stamps).all().map((row) => [row.item_id, row.changed_at]));
  for (const item of kept) {
    const entry = held.get(item.id)!;
    // A blueprint is a document of its own below, held or not.
    if (item.collector === blueprint_collector) continue;
    // A conversation's item is its title and the notes on it, the user's own; its messages are documents of their own.
    if (item.collector === conversation_collector) {
      documents.push({ key: `item:${item.id}`, kind: "item", ref_id: item.id, collector: item.collector, source_id: item.source_id, title: item.title, body: entry.notes.join("\n"), context_ids: entry.context_ids.sort(), sources: [], source_hash: "" });
      continue;
    }
    documents.push({
      key: `item:${item.id}`,
      kind: "item",
      ref_id: item.id,
      collector: item.collector,
      source_id: item.source_id,
      title: item.title,
      body: [item.snippet, ...entry.notes].filter((part) => part.trim()).join("\n"),
      context_ids: entry.context_ids.sort(),
      sources: [item.collector],
      source_hash: text_hash(JSON.stringify([item.collector, item.title, item.snippet, item.uri, item.status, item.detail, ...(stamps.has(item.id) ? [stamps.get(item.id)] : [])])),
    });
  }
  const messages = db.select().from(conversation_messages).where(ne(conversation_messages.role, "event")).all();
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const context_ids = [...(held.get(conversation_item_id(message.conversation_id))?.context_ids ?? [])].sort();
    documents.push({ key: `message:${message.id}`, kind: "message", ref_id: message.id, collector: "", source_id: "", title: message.role === "user" ? "You" : "Assistant", body: message.text, context_ids, sources: message.role === "user" ? [] : parse_sources(message.sources), source_hash: "" });
  }
  documents.push(...entity_documents(database, held));
  documents.push(...blueprint_documents(database, held));
  return documents;
}

// Each entity not rejected, placed in the contexts it is linked to, directly or through an item they hold.
function entity_documents(database: SqlDatabase, held: Map<string, { context_ids: string[] }>): SourceDocument[] {
  const db = drizzle_of(database);
  const entities = db.select().from(graph_entities).where(ne(graph_entities.status, "rejected")).all();
  if (entities.length === 0) return [];
  const places = new Map<string, Set<string>>();
  const place = (entity_id: string, kind: string, id: string) => {
    const found = places.get(entity_id) ?? new Set<string>();
    if (kind === "context") found.add(id);
    else if (kind === "item") for (const context_id of held.get(id)?.context_ids ?? []) found.add(context_id);
    places.set(entity_id, found);
  };
  for (const link of db.select().from(graph_links).where(ne(graph_links.status, "rejected")).all()) {
    if (link.from_kind === "entity") place(link.from_id, link.to_kind, link.to_id);
    if (link.to_kind === "entity") place(link.to_id, link.from_kind, link.from_id);
  }
  return entities.map((entity) => ({
    key: `entity:${entity.id}`,
    kind: "entity",
    ref_id: entity.id,
    collector: "",
    source_id: entity.kind,
    title: entity.name,
    body: [entity.kind, ...parse_names(entity.alt_names)].join("\n"),
    context_ids: [...(places.get(entity.id) ?? [])].sort(),
    sources: parse_sources(entity.sources),
    source_hash: "",
  }));
}

// Each blueprint as an item, held or applying everywhere: its title, when it applies, its body and the notes on it; one
// written during a run carries what that run had read until the user makes it theirs.
function blueprint_documents(database: SqlDatabase, held: Map<string, { context_ids: string[]; notes: string[] }>): SourceDocument[] {
  return drizzle_of(database)
    .select()
    .from(blueprints)
    .all()
    .map((row) => {
      const item_id = blueprint_item_id(row.id);
      const entry = held.get(item_id);
      return {
        key: `item:${item_id}`,
        kind: "item",
        ref_id: item_id,
        collector: blueprint_collector,
        source_id: row.id,
        title: row.title,
        body: [row.applies_when, row.body, ...(entry?.notes ?? [])].filter((part) => part.trim()).join("\n"),
        context_ids: [...(entry?.context_ids ?? [])].sort(),
        sources: parse_sources(row.sources),
        source_hash: "",
      };
    });
}

function parse_names(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

// ── Places ───────────────────────────────────────────────────────────────────

// Every context's name and parent, by id, to say where a hit is and to scope a search to a context and those inside it.
export function context_tree(database: SqlDatabase): Map<string, { name: string; parent_id: string | null }> {
  return new Map(
    drizzle_of(database)
      .select({ id: contexts.id, name: contexts.name, parent_id: contexts.parent_id })
      .from(contexts)
      .all()
      .map((row) => [row.id, { name: row.name, parent_id: row.parent_id }]),
  );
}

// The context and every context inside it.
export function subtree(tree: Map<string, { parent_id: string | null }>, root: string): Set<string> {
  const found = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, context] of tree) {
      if (context.parent_id && found.has(context.parent_id) && !found.has(id)) {
        found.add(id);
        grew = true;
      }
    }
  }
  return found;
}
