// Searching the index: the words through FTS5 and the meaning through the vectors of the embedder in use, each ranked
// on its own and fused by reciprocal rank, scoped to a context and every context inside it when one is given.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { scope_of } from "../contexts/model.ts";
import { items } from "../contexts/schema.ts";
import { summaries_of } from "../conversations/records.ts";
import { conversation_messages } from "../conversations/schema.ts";
import { drizzle_of } from "../feature.ts";
import { graph_entities } from "../graph/schema.ts";
import { parse_sources } from "../privacy/sources.ts";
import { context_tree, subtree } from "./documents.ts";
import { find_embedder } from "./indexer.ts";
import type { HitKind, HitPlace, SearchHit } from "./model.ts";
import { dot, from_blob, fts_query, fuse_ranks, unit } from "./text.ts";

// ── Search ───────────────────────────────────────────────────────────────────

// How many each ranking offers the fusion, and how long an excerpt is.
const ranked_per_list = 50;
const excerpt_chars = 200;
export const default_hits = 20;
export const most_hits = 100;

interface DocRow {
  key: string;
  kind: HitKind;
  ref_id: string;
  collector: string;
  title: string;
  body: string;
  content: string;
  context_ids: string;
  sources: string;
}

function in_scope(row: { context_ids: string }, scope: Set<string> | null): boolean {
  if (!scope) return true;
  return (JSON.parse(row.context_ids) as string[]).some((id) => scope.has(id));
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > excerpt_chars ? `${flat.slice(0, excerpt_chars - 1)}…` : flat;
}

// ── Meaning ──────────────────────────────────────────────────────────────────

// Every text is somewhat near every other, and how near depends on the model, so a hit is judged against the other
// documents' scores for the same query rather than against a fixed cosine.
// Below this many documents there are too few scores to tell the usual from the unusual.
export const fewest_for_spread = 8;
// The best must stand this many spreads (the middle half's width) above the upper quartile, or nothing matches.
export const stand_out_spreads = 1.2;
// A hit must reach this share of the way from the upper quartile to the best.
export const share_above_upper = 0.25;
// With too few documents, a hit must reach this share of the way from the lowest to the best, and one alone is not judged.
const share_of_range = 0.75;

function quantile(ascending: number[], share: number): number {
  const at = (ascending.length - 1) * share;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return ascending[low]! + (ascending[high]! - ascending[low]!) * (at - low);
}

// The least score that counts as a meaning match for one query, given every document's score; null when the best does
// not stand out from the rest, so the query matches nothing by meaning. Unchanged by any rescaling of the scores.
export function meaning_floor(scores: number[]): number | null {
  if (scores.length === 0) return null;
  const ascending = [...scores].sort((first, second) => first - second);
  const best = ascending.at(-1)!;
  if (ascending.length < fewest_for_spread) {
    const lowest = ascending[0]!;
    return best > lowest ? lowest + share_of_range * (best - lowest) : null;
  }
  const upper = quantile(ascending, 0.75);
  const spread = upper - quantile(ascending, 0.25);
  if (best <= upper || best - upper < stand_out_spreads * spread) return null;
  return upper + share_above_upper * (best - upper);
}

// ── Words ────────────────────────────────────────────────────────────────────

// The documents whose words match, best first, each with the piece of text around the match.
function by_words(index: SqlDatabase, query: string, scope: Set<string> | null): { keys: string[]; excerpts: Map<string, string> } {
  const run = (match: string) =>
    match
      ? (index
          .prepare("SELECT t.key AS key, snippet(docs_text, 2, '', '', '…', 24) AS excerpt, d.context_ids AS context_ids FROM docs_text t JOIN docs d ON d.key = t.key WHERE docs_text MATCH ? ORDER BY bm25(docs_text, 0, 5, 1) LIMIT ?")
          .all(match, ranked_per_list * 4) as { key: string; excerpt: string; context_ids: string }[])
      : [];
  let rows = run(fts_query(query, "AND"));
  if (rows.length === 0) rows = run(fts_query(query, "OR"));
  const kept = rows.filter((row) => in_scope(row, scope)).slice(0, ranked_per_list);
  return { keys: kept.map((row) => row.key), excerpts: new Map(kept.map((row) => [row.key, row.excerpt])) };
}

// The documents nearest the query's meaning, best first, each with its nearest piece; empty without an embedder.
async function by_meaning(database: SqlDatabase, index: SqlDatabase, query: string, scope: Set<string> | null, problems: string[]): Promise<{ keys: string[]; excerpts: Map<string, string> }> {
  const none = { keys: [], excerpts: new Map<string, string>() };
  const { found } = await find_embedder(database);
  if (!found) return none;
  const model = found.embedder.model();
  const rows = index
    .prepare("SELECT v.key AS key, v.seq AS seq, v.vector AS vector, d.context_ids AS context_ids, c.text AS text FROM vectors v JOIN docs d ON d.key = v.key JOIN chunks c ON c.key = v.key AND c.seq = v.seq WHERE v.embedder = ? AND v.model = ?")
    .all(found.id, model) as { key: string; seq: number; vector: Uint8Array; context_ids: string; text: string }[];
  if (rows.length === 0) return none;
  let wanted: Float32Array;
  try {
    const { embedder } = found;
    const vector = embedder.embed_query ? await embedder.embed_query(query) : (await embedder.embed([query]))[0];
    wanted = unit(vector ?? []);
  } catch (error) {
    problems.push(`The embedder could not read the search: ${(error as Error).message}`);
    return none;
  }
  const best = new Map<string, { score: number; text: string }>();
  for (const row of rows) {
    if (!in_scope(row, scope)) continue;
    const score = dot(wanted, from_blob(row.vector));
    if (score > (best.get(row.key)?.score ?? -Infinity)) best.set(row.key, { score, text: row.text });
  }
  const sorted = [...best].sort((first, second) => second[1].score - first[1].score);
  const floor = meaning_floor(sorted.map(([, { score }]) => score));
  const ranked = floor === null ? [] : sorted.filter(([, { score }]) => score >= floor).slice(0, ranked_per_list);
  return { keys: ranked.map(([key]) => key), excerpts: new Map(ranked.map(([key, { text }]) => [key, shorten(text)])) };
}

// The documents among those wanted that match the query by meaning, best first with their scores, judged against every
// document's score for it; none without an embedder or when the best does not stand out.
export async function meaning_matches(database: SqlDatabase, index: SqlDatabase, query: string, wanted: Set<string>): Promise<{ key: string; score: number }[]> {
  if (wanted.size === 0 || !query.trim()) return [];
  const { found } = await find_embedder(database);
  if (!found) return [];
  const rows = index.prepare("SELECT key, vector FROM vectors WHERE embedder = ? AND model = ?").all(found.id, found.embedder.model()) as { key: string; vector: Uint8Array }[];
  if (!rows.some((row) => wanted.has(row.key))) return [];
  const { embedder } = found;
  const vector = embedder.embed_query ? await embedder.embed_query(query) : (await embedder.embed([query]))[0];
  const asked = unit(vector ?? []);
  const best = new Map<string, number>();
  for (const row of rows) {
    const score = dot(asked, from_blob(row.vector));
    if (score > (best.get(row.key) ?? -Infinity)) best.set(row.key, score);
  }
  const floor = meaning_floor([...best.values()]);
  if (floor === null) return [];
  return [...best]
    .filter(([key, score]) => wanted.has(key) && score >= floor)
    .sort((first, second) => second[1] - first[1])
    .map(([key, score]) => ({ key, score }));
}

// A message's score is weighed down by this much, so items, contexts and entities rank ahead of messages scoring close.
export const message_weight = 0.85;

// The keys of a conversation's messages, to leave out of a search made from within it.
function message_keys_of(database: SqlDatabase, conversation_id: string | null): Set<string> {
  if (!conversation_id) return new Set();
  const rows = drizzle_of(database).select({ id: conversation_messages.id }).from(conversation_messages).where(eq(conversation_messages.conversation_id, conversation_id)).all();
  return new Set(rows.map((row) => `message:${row.id}`));
}

// Finds items, contexts and messages by words and by meaning, in one context and those inside it or everywhere; the
// messages of the conversation named last are left out, as an engine answering there already has them.
export async function search(database: SqlDatabase, index: SqlDatabase, query: string, given_context: string | null = null, limit = default_hits, problems: string[] = [], leave_out_conversation: string | null = null): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  // Global covers everything, as null does.
  const context_id = scope_of(given_context);
  const tree = context_tree(database);
  if (context_id && !tree.has(context_id)) throw new Error(`There is no context ${context_id}.`);
  const scope = context_id ? subtree(tree, context_id) : null;
  const words = by_words(index, query, scope);
  const meaning = await by_meaning(database, index, query, scope, problems);
  const scores = fuse_ranks([words.keys, meaning.keys]);
  const left_out = message_keys_of(database, leave_out_conversation);
  for (const key of left_out) scores.delete(key);
  for (const [key, score] of scores) if (key.startsWith("message:")) scores.set(key, score * message_weight);
  const wanted = Math.max(1, Math.min(most_hits, Math.floor(Number(limit) || default_hits)));
  const keys = [...scores].sort((first, second) => second[1] - first[1]).slice(0, wanted).map(([key]) => key);
  if (keys.length === 0) return [];
  const rows = new Map((index.prepare(`SELECT key, kind, ref_id, collector, title, body, content, context_ids, sources FROM docs WHERE key IN (${keys.map(() => "?").join(", ")})`).all(...keys) as unknown as DocRow[]).map((row) => [row.key, row]));
  const item_ids = [...rows.values()].filter((row) => row.kind === "item").map((row) => row.ref_id);
  const item_rows = new Map(item_ids.length > 0 ? drizzle_of(database).select({ id: items.id, kind: items.kind, uri: items.uri }).from(items).where(inArray(items.id, item_ids)).all().map((row) => [row.id, row]) : []);
  const message_ids = [...rows.values()].filter((row) => row.kind === "message").map((row) => row.ref_id);
  const conversation_of = new Map(message_ids.length > 0 ? drizzle_of(database).select({ id: conversation_messages.id, conversation_id: conversation_messages.conversation_id }).from(conversation_messages).where(inArray(conversation_messages.id, message_ids)).all().map((row) => [row.id, row.conversation_id]) : []);
  const conversations = new Map(summaries_of(database, [...new Set(conversation_of.values())]).map((summary) => [summary.id, summary]));
  const entity_ids = [...rows.values()].filter((row) => row.kind === "entity").map((row) => row.ref_id);
  const entity_kinds = new Map(entity_ids.length > 0 ? drizzle_of(database).select({ id: graph_entities.id, kind: graph_entities.kind }).from(graph_entities).where(inArray(graph_entities.id, entity_ids)).all().map((row) => [row.id, row.kind]) : []);
  const place = (id: string): HitPlace => ({ id, name: tree.get(id)?.name ?? id });
  return keys.flatMap((key): SearchHit[] => {
    const row = rows.get(key);
    if (!row) return [];
    const context_ids = JSON.parse(row.context_ids) as string[];
    const parent = row.kind === "context" ? tree.get(row.ref_id)?.parent_id : null;
    const where = row.kind === "context" ? (parent ? [place(parent)] : []) : context_ids.map(place);
    const matched_by = [...(words.excerpts.has(key) ? ["words" as const] : []), ...(meaning.excerpts.has(key) ? ["meaning" as const] : [])];
    // The title is shown anyway, so it is never the excerpt too.
    const excerpt = shorten(words.excerpts.get(key) || meaning.excerpts.get(key) || row.body || row.content);
    const item = item_rows.get(row.ref_id);
    const found_in = conversations.get(conversation_of.get(row.ref_id) ?? "");
    const conversation = found_in ? { id: found_in.id, title: found_in.title } : null;
    const item_kind = row.kind === "entity" ? (entity_kinds.get(row.ref_id) ?? "") : (item?.kind ?? "");
    return [{ kind: row.kind, id: row.ref_id, title: row.title, excerpt, collector: row.collector, item_kind, uri: item?.uri ?? found_in?.link ?? "", where, conversation, sources: parse_sources(row.sources), matched_by, score: scores.get(key)! }];
  });
}
