// Searching the index: the words through FTS5 and the meaning through the vectors of the embedder in use, each ranked
// on its own and fused by reciprocal rank, scoped to a context and every context inside it when one is given.

// ── Imports ──────────────────────────────────────────────────────────────────

import { inArray } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { items } from "../contexts/schema.ts";
import { summaries_of } from "../conversations/records.ts";
import { conversation_messages } from "../conversations/schema.ts";
import { drizzle_of } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import { context_tree, subtree } from "./documents.ts";
import { find_embedder } from "./indexer.ts";
import type { HitKind, HitPlace, SearchHit } from "./model.ts";
import { dot, from_blob, fts_query, fuse_ranks, unit } from "./text.ts";

// ── Search ───────────────────────────────────────────────────────────────────

// How many each ranking offers the fusion, and how long an excerpt is.
const ranked_per_list = 50;
// A piece counts as near in meaning only above this cosine, and within this share of the nearest one, since every
// text is somewhat near every other.
const least_similarity = 0.3;
const share_of_best = 0.75;
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
    const [vector] = await found.embedder.embed([query]);
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
  const floor = Math.max(least_similarity, (sorted[0]?.[1].score ?? 0) * share_of_best);
  const ranked = sorted.filter(([, { score }]) => score >= floor).slice(0, ranked_per_list);
  return { keys: ranked.map(([key]) => key), excerpts: new Map(ranked.map(([key, { text }]) => [key, shorten(text)])) };
}

// Finds items, contexts and messages by words and by meaning, in one context and those inside it or everywhere.
export async function search(database: SqlDatabase, index: SqlDatabase, query: string, context_id: string | null = null, limit = default_hits, problems: string[] = []): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  const tree = context_tree(database);
  if (context_id && !tree.has(context_id)) throw new Error(`There is no context ${context_id}.`);
  const scope = context_id ? subtree(tree, context_id) : null;
  const words = by_words(index, query, scope);
  const meaning = await by_meaning(database, index, query, scope, problems);
  const scores = fuse_ranks([words.keys, meaning.keys]);
  const wanted = Math.max(1, Math.min(most_hits, Math.floor(Number(limit) || default_hits)));
  const keys = [...scores].sort((first, second) => second[1] - first[1]).slice(0, wanted).map(([key]) => key);
  if (keys.length === 0) return [];
  const rows = new Map((index.prepare(`SELECT key, kind, ref_id, collector, title, body, content, context_ids, sources FROM docs WHERE key IN (${keys.map(() => "?").join(", ")})`).all(...keys) as unknown as DocRow[]).map((row) => [row.key, row]));
  const item_ids = [...rows.values()].filter((row) => row.kind === "item").map((row) => row.ref_id);
  const item_rows = new Map(item_ids.length > 0 ? drizzle_of(database).select({ id: items.id, kind: items.kind, uri: items.uri }).from(items).where(inArray(items.id, item_ids)).all().map((row) => [row.id, row]) : []);
  const message_ids = [...rows.values()].filter((row) => row.kind === "message").map((row) => row.ref_id);
  const conversation_of = new Map(message_ids.length > 0 ? drizzle_of(database).select({ id: conversation_messages.id, conversation_id: conversation_messages.conversation_id }).from(conversation_messages).where(inArray(conversation_messages.id, message_ids)).all().map((row) => [row.id, row.conversation_id]) : []);
  const conversations = new Map(summaries_of(database, [...new Set(conversation_of.values())]).map((summary) => [summary.id, summary]));
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
    return [{ kind: row.kind, id: row.ref_id, title: row.title, excerpt, collector: row.collector, item_kind: item?.kind ?? "", uri: item?.uri ?? found_in?.link ?? "", where, conversation, sources: parse_sources(row.sources), matched_by, score: scores.get(key)! }];
  });
}
