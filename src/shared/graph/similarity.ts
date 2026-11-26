// Links proposed by nearness of meaning, with no model call: once embeddings are on, an item given new vectors is
// compared with every other item, and those standing clearly above what it scores against the rest become proposed
// related_to links, a few per item, never between two items already linked in any way or once rejected.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { conversation_collector } from "../conversations/model.ts";
import { drizzle_of } from "../feature.ts";
import type { IndexPass } from "../search/indexer.ts";
import { meaning_floor } from "../search/search.ts";
import { dot, from_blob } from "../search/text.ts";
import { node_key } from "./model.ts";
import { is_open, links_touching, now } from "./records.ts";
import { graph_links } from "./schema.ts";
import { insert_link } from "./writing.ts";

// ── Nearness ─────────────────────────────────────────────────────────────────

// The most proposals of this kind waiting on one item at a time.
export const most_similar_per_item = 3;

export function similarity_link_id(first: string, second: string): string {
  const [low, high] = [first, second].sort();
  return `similarity:${low}>${high}`;
}

// Each item's meaning as the mean of its pieces' vectors, scaled to length one, by item id.
function item_vectors(index: SqlDatabase, embedder: { id: string; model: string }): Map<string, Float32Array> {
  const rows = index
    .prepare("SELECT d.ref_id AS id, v.vector AS vector FROM vectors v JOIN docs d ON d.key = v.key WHERE d.kind = 'item' AND d.collector != ? AND v.embedder = ? AND v.model = ?")
    .all(conversation_collector, embedder.id, embedder.model) as { id: string; vector: Uint8Array }[];
  const sums = new Map<string, Float32Array>();
  for (const row of rows) {
    const vector = from_blob(row.vector);
    const sum = sums.get(row.id) ?? new Float32Array(vector.length);
    for (let at = 0; at < Math.min(sum.length, vector.length); at++) sum[at]! += vector[at]!;
    sums.set(row.id, sum);
  }
  for (const sum of sums.values()) {
    const length = Math.hypot(...sum) || 1;
    for (let at = 0; at < sum.length; at++) sum[at]! /= length;
  }
  return sums;
}

// The other items that stand clearly above what one item scores against everything else, nearest first, judged as
// search judges a query's hits, so the same rule holds whatever scale an embedder's scores have.
export function standing_out<Other>(scored: { other: Other; score: number }[]): { other: Other; score: number }[] {
  const floor = meaning_floor(scored.map((each) => each.score));
  if (floor === null) return [];
  return scored.filter((each) => each.score >= floor).sort((first, second) => second.score - first.score);
}

// Proposes the nearest items of each item that was given new vectors; true when any was proposed.
export function propose_similar(database: SqlDatabase, index: SqlDatabase, pass: IndexPass): boolean {
  if (!pass.embedder) return false;
  const changed = [...new Set(pass.embedded.filter((key) => key.startsWith("item:")).map((key) => key.slice(5)))];
  if (changed.length === 0) return false;
  const vectors = item_vectors(index, pass.embedder);
  const db = drizzle_of(database);
  const at = now();
  let wrote = false;
  for (const id of changed) {
    const own = vectors.get(id);
    if (!own) continue;
    const key = node_key("item", id);
    const touching = links_touching(database, [key]);
    const linked = new Set(touching.flatMap((row) => [`${row.from_kind}:${row.from_id}`, `${row.to_kind}:${row.to_id}`]));
    let waiting = touching.filter((row) => row.made_by === "similarity" && row.status === "proposed" && is_open(row, at)).length;
    const nearest = standing_out(
      [...vectors].filter(([other]) => other !== id).map(([other, vector]) => ({ other, score: dot(own, vector) })),
    );
    for (const { other } of nearest) {
      if (waiting >= most_similar_per_item) break;
      const other_key = node_key("item", other);
      const link_id = similarity_link_id(key, other_key);
      if (linked.has(other_key) || db.select({ id: graph_links.id }).from(graph_links).where(eq(graph_links.id, link_id)).get()) continue;
      const [from, to] = [key, other_key].sort();
      insert_link(database, { id: link_id, from: from!, to: to!, type: "related_to", label: "similar", status: "proposed", made_by: "similarity", engine: pass.embedder.id, model: pass.embedder.model });
      waiting += 1;
      wrote = true;
    }
  }
  return wrote;
}
