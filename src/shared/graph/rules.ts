// Links made without any model, on an exact key, accepted at once: an item or context whose text holds another item's
// address ("links to"), or a codex:// or other app's item link to something CODEX holds ("links to"), and an item
// whose app says it belongs to another (part_of). They run after each index pass, only for what it wrote and what
// may point at it, and a link a rule no longer finds is closed.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { parse_item_link } from "@x-tech-laboratories/x-libs/items";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { contexts, items } from "../contexts/schema.ts";
import { conversation_collector, conversation_item_id } from "../conversations/model.ts";
import { drizzle_of } from "../feature.ts";
import { route_of_link } from "../links.ts";
import type { IndexPass } from "../search/indexer.ts";
import { node_key, parse_node_key, type LinkType } from "./model.ts";
import { held_item_ids, is_open, now, read_joins, type LinkRow } from "./records.ts";
import { graph_links } from "./schema.ts";
import { insert_link, same_links } from "./writing.ts";

// ── Rules ────────────────────────────────────────────────────────────────────

export const rule_links_to = "links_to";
export const rule_app_link = "app_link";
export const rule_parent = "parent";

// Above this many changed documents every one is looked at again, rather than searching for what points at each.
const most_changed_looked_up = 200;

// An address shorter than this is too loose to match on.
const shortest_address = 8;

interface Wanted {
  to: string;
  type: LinkType;
  label: string;
  rule: string;
}

// The one id every device gives the same rule's link between the same nodes, so two devices make one link.
export function rule_link_id(rule: string, from: string, to: string): string {
  return `rule:${rule}:${from}>${to}`;
}

// ── Addresses ────────────────────────────────────────────────────────────────

const address_pattern = /[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s<>"'`()[\]{}|\\^]+/gi;

// An address as matched: without trailing punctuation or a trailing slash.
export function normal_address(text: string): string {
  return text.replace(/[.,;:!?'"]+$/, "").replace(/\/+$/, "");
}

// Every address-like piece of the text, as matched.
export function addresses_in(text: string): string[] {
  return [...new Set((text.match(address_pattern) ?? []).map(normal_address).filter((each) => each.length >= shortest_address))];
}

// ── Reading ──────────────────────────────────────────────────────────────────

interface Doc {
  key: string;
  kind: string;
  ref_id: string;
  text: string;
}

function docs_of(index: SqlDatabase, keys: string[] | null): Doc[] {
  const select = "SELECT key, kind, ref_id, title || char(10) || body || char(10) || content AS text FROM docs";
  if (keys === null) return index.prepare(`${select} WHERE kind IN ('item', 'context')`).all() as unknown as Doc[];
  const found: Doc[] = [];
  for (let at = 0; at < keys.length; at += 500) {
    const part = keys.slice(at, at + 500);
    found.push(...(index.prepare(`${select} WHERE key IN (${part.map(() => "?").join(", ")})`).all(...part) as unknown as Doc[]));
  }
  return found;
}

// The documents whose text holds the given text.
function docs_holding(index: SqlDatabase, text: string): string[] {
  return (index.prepare("SELECT key FROM docs WHERE kind IN ('item', 'context') AND (instr(title, ?) > 0 OR instr(body, ?) > 0 OR instr(content, ?) > 0)").all(text, text, text) as { key: string }[]).map((row) => row.key);
}

type ItemRow = Pick<typeof items.$inferSelect, "id" | "collector" | "source_id" | "uri" | "detail" | "status">;

function parent_of(row: ItemRow): string {
  try {
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    return typeof detail.parent === "string" ? detail.parent : "";
  } catch {
    return "";
  }
}

// ── Running ──────────────────────────────────────────────────────────────────

// Runs the rules for what the pass wrote and what may point at it; true when a link was made, opened again or closed.
export function run_rules(database: SqlDatabase, index: SqlDatabase, pass: IndexPass): boolean {
  const changed = pass.written.filter((key) => key.startsWith("item:") || key.startsWith("context:"));
  if (changed.length === 0) return false;
  const db = drizzle_of(database);
  const held = held_item_ids(database);
  const item_rows = new Map(db.select({ id: items.id, collector: items.collector, source_id: items.source_id, uri: items.uri, detail: items.detail, status: items.status }).from(items).all().filter((row) => held.has(row.id)).map((row) => [row.id, row]));
  const context_ids = new Set(db.select({ id: contexts.id }).from(contexts).all().map((row) => row.id));
  const by_address = new Map<string, string[]>();
  for (const row of item_rows.values()) {
    const address = normal_address(row.uri);
    if (address.length >= shortest_address) by_address.set(address, [...(by_address.get(address) ?? []), row.id]);
  }

  // What to look at: the documents written, and those whose text may point at one, or whose parent it is.
  let looked: Doc[];
  if (pass.all || changed.length > most_changed_looked_up) looked = docs_of(index, null);
  else {
    const keys = new Set(changed);
    for (const key of changed) {
      const parsed = parse_node_key(key)!;
      const row = parsed.kind === "item" ? item_rows.get(parsed.id) : undefined;
      if (row && normal_address(row.uri).length >= shortest_address) for (const found of docs_holding(index, normal_address(row.uri))) keys.add(found);
      if (parsed.kind === "context") for (const found of docs_holding(index, `codex://context/${parsed.id}`)) keys.add(found);
      if (row) {
        const children = db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.collector, row.collector), sql`json_extract(${items.detail}, '$.parent') = ${row.source_id}`))
          .all();
        for (const child of children) keys.add(node_key("item", child.id));
      }
    }
    looked = docs_of(index, [...keys]);
    // A document no longer indexed is looked at too, so its links are closed.
    const found = new Set(looked.map((doc) => doc.key));
    for (const key of keys) if (!found.has(key)) looked.push({ key, kind: key.split(":")[0]!, ref_id: key.slice(key.indexOf(":") + 1), text: "" });
  }

  let wrote = false;
  for (const doc of looked) wrote = apply_rules(database, doc, wanted_of(doc, item_rows, by_address, context_ids)) || wrote;
  return wrote;
}

// What each rule finds for one document: the addresses and app links in its text, and an item's parent.
function wanted_of(doc: Doc, item_rows: Map<string, ItemRow>, by_address: Map<string, string[]>, context_ids: Set<string>): Wanted[] {
  const self = node_key(doc.kind as "item" | "context", doc.ref_id);
  const found = new Map<string, Wanted>();
  const want = (to: string, type: LinkType, label: string, rule: string) => {
    if (to !== self && !found.has(`${type}|${to}`)) found.set(`${type}|${to}`, { to, type, label, rule });
  };
  const own = doc.kind === "item" ? item_rows.get(doc.ref_id) : undefined;
  if (doc.kind === "item" && !own) return [];
  for (const address of addresses_in(doc.text)) {
    for (const id of by_address.get(address) ?? []) want(node_key("item", id), "related_to", "links to", rule_links_to);
    const route = route_of_link(address);
    const context = /^#\/context\/(.+)$/.exec(route ?? "")?.[1];
    if (context && context_ids.has(decodeURIComponent(context))) want(node_key("context", decodeURIComponent(context)), "related_to", "links to", rule_app_link);
    const parsed = parse_item_link(address);
    if (parsed) {
      const id = parsed.scheme.toLowerCase() === "codex" && parsed.kind === "conversation" ? conversation_item_id(parsed.id) : `${parsed.scheme.toLowerCase()}:${parsed.id}`;
      if (item_rows.has(id) && !(item_rows.get(id)!.collector === conversation_collector && item_rows.get(id)!.status === "missing")) want(node_key("item", id), "related_to", "links to", rule_app_link);
    }
  }
  const parent = own ? parent_of(own) : "";
  if (own && parent) {
    const parent_id = `${own.collector}:${parent}`;
    if (item_rows.has(parent_id)) want(node_key("item", parent_id), "part_of", "", rule_parent);
  }
  return [...found.values()];
}

// Makes the links the rules want from one document, opens again one that comes back, and closes those no longer found.
function apply_rules(database: SqlDatabase, doc: Doc, wanted: Wanted[]): boolean {
  const db = drizzle_of(database);
  const from = node_key(doc.kind as "item" | "context", doc.ref_id);
  const parsed = parse_node_key(from)!;
  const existing = new Map<string, LinkRow>(
    db
      .select()
      .from(graph_links)
      .where(and(eq(graph_links.made_by, "rule"), eq(graph_links.from_kind, parsed.kind), eq(graph_links.from_id, parsed.id)))
      .all()
      .map((row) => [row.id, row]),
  );
  const at = now();
  const joins = read_joins(database);
  let wrote = false;
  const kept = new Set<string>();
  for (const each of wanted) {
    const id = rule_link_id(each.rule, from, each.to);
    kept.add(id);
    const row = existing.get(id);
    if (row) {
      if (row.status !== "rejected" && !is_open(row, at)) {
        db.update(graph_links).set({ valid_until: "", recorded_at: at }).where(eq(graph_links.id, id)).run();
        wrote = true;
      }
      continue;
    }
    // A link of that type someone else made, or the user rejected, stands in its place.
    if (same_links(database, from, each.to, each.type, joins).some((other) => other.made_by !== "rule" && (other.status === "rejected" || is_open(other, at)))) continue;
    insert_link(database, { id, from, to: each.to, type: each.type, label: each.label, status: "accepted", made_by: "rule", rule: each.rule, evidence_ref: doc.kind === "item" ? from : "" });
    wrote = true;
  }
  const stale = [...existing.values()].filter((row) => !kept.has(row.id) && row.status !== "rejected" && is_open(row, at)).map((row) => row.id);
  if (stale.length > 0) {
    db.update(graph_links).set({ valid_until: at }).where(inArray(graph_links.id, stale)).run();
    wrote = true;
  }
  return wrote;
}
