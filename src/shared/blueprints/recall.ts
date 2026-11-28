// Recall: at the start of each run CODEX itself, not the engine, matches the user's message against the active
// blueprints that apply in the open context, and puts the best few in the instructions for the engine to follow. A
// blueprint matches by its words when the message shares enough of its title's and "applies when"'s words, and by
// meaning when the index's vectors set it clearly apart from everything else the index holds for that message. The
// count and the characters are capped, so a small model's context is not crowded.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { fill, prompts } from "../prompts/prompts.ts";
import { index_host } from "../search/indexer.ts";
import { meaning_matches } from "../search/search.ts";
import { fuse_ranks } from "../search/text.ts";
import { blueprint_item_id } from "./model.ts";
import { blueprint_ids_applying, rows_of, type BlueprintRow } from "./records.ts";

// ── Caps ─────────────────────────────────────────────────────────────────────

// The most blueprints put in the instructions, and the most characters they take together.
export const recall_caps = { most: 3, chars: 4000 };

// ── Words ────────────────────────────────────────────────────────────────────

// Words that say nothing of a task, left out on both sides.
const stop_words = new Set(
  (
    "the and for are but not you your yours all any can could would should will shall may might must did does doing done had has have having " +
    "her him his its our ours their them they this that these those there here what when where which while who whom why how with without " +
    "into onto from upon about above below over under again then than too very just also only own same such some more most other each few " +
    "both being been was were want wants wanted need needs please help let lets make made get got give gave take took put use used using " +
    "ask asks asked asking tell told say said know like time way thing things user users one two now today tomorrow yesterday yes okay ok " +
    "thanks thank hello hey hi via per itself myself yourself"
  ).split(" "),
);

// A word without its common endings, so "sorting" and "sorted" meet "sort".
function stem(word: string): string {
  for (const ending of ["ings", "ing", "edly", "ed", "es", "s", "ly"]) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) return word.slice(0, -ending.length);
  }
  return word;
}

// The words of a text that can say what a task is: lower case, accents taken off, three letters or more, no stop words.
export function content_words(text: string): string[] {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !stop_words.has(word)).map(stem))];
}

function same_word(first: string, second: string): boolean {
  if (first === second) return true;
  const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

// How many of the message's words the blueprint's words hold.
export function shared_words(message: string[], blueprint: string[]): number {
  return message.filter((word) => blueprint.some((other) => same_word(word, other))).length;
}

// Two words shared, or one when the message or the blueprint's own description has hardly any more to go by.
export function matches_by_words(message: string[], blueprint: string[]): boolean {
  const shared = shared_words(message, blueprint);
  return shared >= 2 || (shared === 1 && (message.length <= 2 || blueprint.length === 1));
}

// ── Recall ───────────────────────────────────────────────────────────────────

export interface Recalled {
  row: BlueprintRow;
  // Its body as given, cut short when the caps left too little room.
  body: string;
  matched_by: ("words" | "meaning")[];
}

// The active blueprints applying in the context that match the message, best first, within the caps.
export async function recall_blueprints(database: SqlDatabase, context_id: string | null, message: string): Promise<Recalled[]> {
  const rows = rows_of(database, blueprint_ids_applying(database, context_id), "active");
  if (rows.length === 0 || !message.trim()) return [];
  const asked = content_words(message);
  const by_words = rows
    .map((row) => ({ row, shared: shared_words(asked, content_words(`${row.title} ${row.applies_when}`)), words: content_words(`${row.title} ${row.applies_when}`) }))
    .filter((entry) => matches_by_words(asked, entry.words))
    .sort((first, second) => second.shared - first.shared)
    .map((entry) => blueprint_item_id(entry.row.id));
  let by_meaning: string[] = [];
  try {
    const keys = new Map(rows.map((row) => [`item:${blueprint_item_id(row.id)}`, blueprint_item_id(row.id)]));
    by_meaning = (await meaning_matches(database, index_host().index(), message, new Set(keys.keys()))).map((match) => keys.get(match.key)!);
  } catch {
    // No index here, or the embedder could not read the message: words alone answer.
  }
  const fused = [...fuse_ranks([by_words, by_meaning])].sort((first, second) => second[1] - first[1]).map(([key]) => key);
  const by_item = new Map(rows.map((row) => [blueprint_item_id(row.id), row]));
  const recalled: Recalled[] = [];
  let room = recall_caps.chars;
  for (const key of fused.slice(0, recall_caps.most)) {
    const row = by_item.get(key)!;
    const fixed = row.title.length + row.applies_when.length + 120;
    if (room - fixed < 200 && recalled.length > 0) break;
    const fits = Math.max(200, room - fixed);
    const body = row.body.length > fits ? `${row.body.slice(0, fits).trimEnd()}\n${prompts.blueprints.cut_short}` : row.body;
    room -= fixed + body.length;
    recalled.push({ row, body, matched_by: [...(by_words.includes(key) ? ["words" as const] : []), ...(by_meaning.includes(key) ? ["meaning" as const] : [])] });
  }
  return recalled;
}

// The instructions' part holding the blueprints recalled: the user's own approved instructions, so not fenced.
export function recalled_part(recalled: Recalled[]): string {
  if (recalled.length === 0) return "";
  const each = recalled.map(({ row, body }) => fill(prompts.blueprints.recalled_one, { title: row.title, id: row.id, applies_when: row.applies_when, body: body.trim() }));
  return [...prompts.blueprints.recalled, ...each].join("\n\n");
}
