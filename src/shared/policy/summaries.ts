// A change an engine asks for, said in plain words for the user deciding whether to approve it, with contexts and items
// named rather than given by id.

// ── Imports ──────────────────────────────────────────────────────────────────

import { eq, inArray } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { contexts, items } from "../contexts/schema.ts";
import { drizzle_of } from "../feature.ts";
import { offered_api } from "./policy.ts";

// ── Names ────────────────────────────────────────────────────────────────────

const longest_quote = 160;

function quote(value: unknown): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return `“${flat.length > longest_quote ? `${flat.slice(0, longest_quote - 1)}…` : flat}”`;
}

function context_name(database: SqlDatabase, id: unknown): string {
  if (typeof id !== "string") return "a context";
  const row = drizzle_of(database).select({ name: contexts.name }).from(contexts).where(eq(contexts.id, id)).get();
  return row ? `the context ${quote(row.name)}` : `a context that does not exist (${id})`;
}

function context_names(database: SqlDatabase, ids: unknown): string {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  if (list.length === 0) return "no context";
  const rows = drizzle_of(database).select({ name: contexts.name }).from(contexts).where(inArray(contexts.id, list)).all();
  const names = rows.map((row) => quote(row.name));
  if (names.length < list.length) names.push(`${list.length - names.length} unknown`);
  return names.length === 1 ? `the context ${names[0]}` : `the contexts ${names.join(", ")}`;
}

function item_name(database: SqlDatabase, id: unknown): string {
  if (typeof id !== "string") return "an item";
  const row = drizzle_of(database).select({ title: items.title }).from(items).where(eq(items.id, id)).get();
  return row ? quote(row.title) : `the item ${id}`;
}

function parent_place(database: SqlDatabase, parent_id: unknown): string {
  return typeof parent_id === "string" && parent_id ? `inside ${context_name(database, parent_id)}` : "at the top level";
}

// ── Summaries ────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

const summaries: Record<string, (database: SqlDatabase, args: Args) => string> = {
  add_context: (database, args) => `Add a context named ${quote(args.name)} ${parent_place(database, args.parent_id)}.`,
  rename_context: (database, args) => `Rename ${context_name(database, args.id)} to ${quote(args.name)}.`,
  set_context_notes: (database, args) => `Replace the notes of ${context_name(database, args.id)} with ${quote(args.notes)}.`,
  set_context_archived: (database, args) => `${args.is_archived ? "Archive" : "Bring back"} ${context_name(database, args.id)}.`,
  move_context: (database, args) => `Move ${context_name(database, args.id)} ${parent_place(database, args.parent_id)}.`,
  remove_context: (database, args) => `Delete ${context_name(database, args.id)} and every context inside it; the items stay in their apps.`,
  add_item: (database, args) => `Add ${quote((args.item as Args | undefined)?.title)} from ${String(args.collector)} to ${context_names(database, args.context_ids)}.`,
  add_manual_item: (database, args) => {
    const values = (args.values ?? {}) as Args;
    return `Add ${quote(values.title || values.url)} to ${context_names(database, args.context_ids)}.`;
  },
  set_item_note: (database, args) => `Set the note on ${item_name(database, args.item_id)} in ${context_name(database, args.context_id)} to ${quote(args.note)}.`,
  remove_item: (database, args) => `Take ${item_name(database, args.item_id)} out of ${context_name(database, args.context_id)}.`,
  refresh_items: (database, args) => `Ask the apps what became of the items in ${args.context_id ? context_name(database, args.context_id) : "every context"}.`,
  follow_feed: (database, args) => `Make ${context_name(database, args.context_id)} follow ${quote(args.label)} in ${String(args.collector)}.`,
  unfollow_feed: (database, args) => `Stop ${context_name(database, args.context_id)} following ${String(args.feed_id)} in ${String(args.collector)}.`,
  add_contexts_from_feeds: (database, args) => {
    const labels = Array.isArray(args.feeds) ? args.feeds.map((feed) => quote((feed as Args).label)).join(", ") : "";
    return `Make a context following each of ${labels || "no feed"} in ${String(args.collector)}, ${parent_place(database, args.parent_id)}.`;
  },
  add_contexts_from_feed_group: (database, args) => `Make contexts from the group ${String(args.group_id)} in ${String(args.collector)}, ${parent_place(database, args.parent_id)}.`,
  stop_feed_group_news: (database, args) => `Stop offering ${context_name(database, args.id)} the feeds added to the group it was made from.`,
};

// The change in plain words; a call without words of its own gets its description and arguments.
export function summarize_call(database: SqlDatabase, method: string, args: Args): string {
  const summary = summaries[method];
  if (summary) return summary(database, args);
  const description = offered_api[method]?.description ?? method;
  return `${description} (${JSON.stringify(args)})`;
}
