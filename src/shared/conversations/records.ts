// The conversations themselves and the items that stand for them: each conversation is an item of kind
// "conversation" in the contexts that hold it, kept up to date here with its title, its latest exchange and when it
// was last used, so every view, search, History and "also in" treat it like any other item.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, eq, inArray, sql } from "@x-tech-laboratories/x-libs/drizzle";
import { clip_snippet } from "@x-tech-laboratories/x-libs/items";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { FoundItem } from "../collectors/collector.ts";
import { context_or_global, global_context_id } from "../contexts/model.ts";
import { context_items, contexts, items } from "../contexts/schema.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { job_runs, jobs } from "../jobs/schema.ts";
import { proposals } from "../policy/schema.ts";
import { conversation_collector, conversation_item_id, conversation_kind, conversation_link, untitled_conversation, type ConversationSummary } from "./model.ts";
import { conversation_messages, conversations } from "./schema.ts";

// ── Titles ───────────────────────────────────────────────────────────────────

const longest_title = 80;

// A title from the first message: its first line, clipped at a word where it can be.
export function title_from(text: string): string {
  const line = text.trim().split("\n")[0]!.replace(/^[#>*\-\s]+/, "").trim();
  if (line.length <= longest_title) return line;
  const cut = line.slice(0, longest_title - 1);
  const at_word = cut.lastIndexOf(" ");
  return `${(at_word > longest_title / 2 ? cut.slice(0, at_word) : cut).trimEnd()}…`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function has_conversation(database: SqlDatabase, id: string): boolean {
  return drizzle_of(database).select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).get() !== undefined;
}

export function conversation_row(database: SqlDatabase, id: string) {
  const row = drizzle_of(database).select().from(conversations).where(eq(conversations.id, id)).get();
  if (!row) throw new Error(`There is no conversation ${id}.`);
  return row;
}

interface Facts {
  first_user_text: string;
  last_used_at: string;
  message_count: number;
  // The latest message of the user's and the latest answer after it.
  exchange: string;
}

// What each conversation's messages say of it, by conversation id.
function facts_of(database: SqlDatabase, ids: string[]): Map<string, Facts> {
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const rows = drizzle_of(database)
    .select({ conversation_id: conversation_messages.conversation_id, role: conversation_messages.role, text: conversation_messages.text, created_at: conversation_messages.created_at })
    .from(conversation_messages)
    .where(inArray(conversation_messages.conversation_id, ids))
    .orderBy(asc(conversation_messages.created_at), asc(conversation_messages.id))
    .all();
  const last_user = new Map<string, string>();
  const last_answer = new Map<string, string>();
  for (const row of rows) {
    const fact = facts.get(row.conversation_id) ?? { first_user_text: "", last_used_at: "", message_count: 0, exchange: "" };
    fact.message_count += 1;
    fact.last_used_at = row.created_at;
    if (row.role === "user") {
      if (!fact.first_user_text && row.text.trim()) fact.first_user_text = row.text;
      last_user.set(row.conversation_id, row.text);
      last_answer.delete(row.conversation_id);
    } else if (row.role === "assistant" && row.text.trim()) last_answer.set(row.conversation_id, row.text);
    facts.set(row.conversation_id, fact);
  }
  for (const [id, fact] of facts) {
    const parts = [last_user.has(id) ? `You: ${last_user.get(id)}` : "", last_answer.has(id) ? `CODEX: ${last_answer.get(id)}` : ""].filter(Boolean);
    fact.exchange = clip_snippet(parts.join(" · "));
  }
  return facts;
}

// The contexts holding each conversation, by conversation id, by name.
function holders_of(database: SqlDatabase, ids: string[]): Map<string, { id: string; name: string }[]> {
  const holders = new Map<string, { id: string; name: string }[]>();
  if (ids.length === 0) return holders;
  const rows = drizzle_of(database)
    .select({ item_id: context_items.item_id, id: contexts.id, name: contexts.name })
    .from(context_items)
    .innerJoin(contexts, eq(contexts.id, context_items.context_id))
    .where(inArray(context_items.item_id, ids.map(conversation_item_id)))
    .orderBy(asc(contexts.name))
    .all();
  for (const row of rows) {
    const id = row.item_id.slice(conversation_collector.length + 1);
    holders.set(id, [...(holders.get(id) ?? []), { id: row.id, name: row.name }]);
  }
  return holders;
}

// The title of the job whose runs each of these conversations keeps, by conversation id; a job since removed is known by its runs.
function job_titles_of(database: SqlDatabase, ids: string[]): Map<string, string> {
  const db = drizzle_of(database);
  const titles = new Map<string, string>();
  for (const row of db.select({ conversation_id: job_runs.conversation_id, title: job_runs.title }).from(job_runs).where(inArray(job_runs.conversation_id, ids)).all()) titles.set(row.conversation_id, row.title);
  for (const row of db.select({ conversation_id: jobs.conversation_id, title: jobs.title }).from(jobs).where(inArray(jobs.conversation_id, ids)).all()) titles.set(row.conversation_id, row.title);
  return titles;
}

// The conversations with these ids, most recently used first; running says which have a reply being written.
export function summaries_of(database: SqlDatabase, ids: string[], running: (id: string) => boolean = () => false): ConversationSummary[] {
  if (ids.length === 0) return [];
  const rows = drizzle_of(database).select().from(conversations).where(inArray(conversations.id, ids)).all();
  const facts = facts_of(database, ids);
  const holders = holders_of(database, ids);
  const job_titles = job_titles_of(database, ids);
  return rows
    .map((row) => {
      const fact = facts.get(row.id);
      return {
        id: row.id,
        title: row.title || (fact?.first_user_text ? title_from(fact.first_user_text) : "") || untitled_conversation,
        is_named: row.title !== "",
        created_at: row.created_at,
        last_used_at: fact?.last_used_at || row.created_at,
        message_count: fact?.message_count ?? 0,
        is_running: running(row.id),
        contexts: holders.get(row.id) ?? [],
        link: conversation_link(row.id),
        job: job_titles.has(row.id) ? { title: job_titles.get(row.id)! } : null,
      };
    })
    .sort((first, second) => second.last_used_at.localeCompare(first.last_used_at) || first.id.localeCompare(second.id));
}

// The conversations a context holds, Global's for null.
export function conversation_ids_in(database: SqlDatabase, context_id: string | null): string[] {
  return drizzle_of(database)
    .select({ item_id: context_items.item_id })
    .from(context_items)
    .innerJoin(items, eq(items.id, context_items.item_id))
    .where(and(eq(context_items.context_id, context_or_global(context_id)), eq(items.collector, conversation_collector)))
    .all()
    .map((row) => row.item_id.slice(conversation_collector.length + 1));
}

// ── Items ────────────────────────────────────────────────────────────────────

// Each conversation as its item: its title, its latest exchange, where it opens and when it was last used.
export function found_items(database: SqlDatabase, ids: string[]): Record<string, FoundItem> {
  const facts = facts_of(database, ids);
  return Object.fromEntries(
    summaries_of(database, ids).map((summary) => {
      const exchange = facts.get(summary.id)?.exchange ?? "";
      return [summary.id, { source_id: summary.id, kind: conversation_kind, title: summary.title, snippet: exchange, uri: summary.link, status: "", detail: { last_used_at: summary.last_used_at, is_named: String(summary.is_named) } }];
    }),
  );
}

// Writes each conversation's item as it is now; one that no longer exists keeps its item, marked missing, so History
// can still put a context back with it.
export function refresh_conversation_items(database: SqlDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const found = found_items(database, ids);
  const now = new Date().toISOString();
  const db = drizzle_of(database);
  for (const id of ids) {
    const item = found[id];
    const item_id = conversation_item_id(id);
    if (!item) {
      db.update(items).set({ status: "missing", snippet: "Deleted.", seen_at: now }).where(eq(items.id, item_id)).run();
      continue;
    }
    const values = { kind: item.kind, title: item.title, snippet: item.snippet ?? "", uri: item.uri ?? "", status: "", detail: JSON.stringify(item.detail ?? {}), seen_at: now };
    const kept = db.select({ title: items.title, snippet: items.snippet, detail: items.detail, status: items.status }).from(items).where(eq(items.id, item_id)).get();
    if (kept && kept.title === values.title && kept.snippet === values.snippet && kept.detail === values.detail && kept.status === "") continue;
    db.insert(items)
      .values({ id: item_id, collector: conversation_collector, source_id: id, created_at: now, ...values })
      .onConflictDoUpdate({ target: items.id, set: values })
      .run();
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

// Makes a conversation in the context given, Global for null, and gives back its id.
export function add_conversation_record(database: SqlDatabase, context_id: string | null, id: string = new_id()): string {
  in_transaction(database, () => {
    const now = new Date().toISOString();
    drizzle_of(database).insert(conversations).values({ id, title: "", created_at: now }).onConflictDoNothing().run();
    refresh_conversation_items(database, [id]);
    drizzle_of(database).insert(context_items).values({ context_id: context_or_global(context_id), item_id: conversation_item_id(id), note: "", added_at: now }).onConflictDoNothing().run();
  });
  return id;
}

export function rename_conversation_record(database: SqlDatabase, id: string, title: string): void {
  conversation_row(database, id);
  drizzle_of(database).update(conversations).set({ title: title.replace(/\s+/g, " ").trim() }).where(eq(conversations.id, id)).run();
  refresh_conversation_items(database, [id]);
}

// Deletes a conversation's messages, proposals and row, and takes its item out of every context.
export function delete_conversation_records(database: SqlDatabase, id: string): void {
  in_transaction(database, () => {
    const db = drizzle_of(database);
    db.delete(conversation_messages).where(eq(conversation_messages.conversation_id, id)).run();
    db.delete(proposals).where(eq(proposals.conversation_id, id)).run();
    db.delete(conversations).where(eq(conversations.id, id)).run();
    db.delete(context_items).where(eq(context_items.item_id, conversation_item_id(id))).run();
    refresh_conversation_items(database, [id]);
  });
}

// Messages and proposals whose conversation has no row, as every conversation kept before conversations were items,
// and any a device still on that shape syncs in: each becomes a conversation, in the context whose id it has when that
// context exists, or in Global. A conversation with no messages was never kept, so empty ones are left behind.
export function adopt_stray_conversations(database: SqlDatabase): string[] {
  const db = drizzle_of(database);
  const known = new Set(db.select({ id: conversations.id }).from(conversations).all().map((row) => row.id));
  const strays = new Map<string, string>();
  for (const table of [conversation_messages, proposals]) {
    const rows = db.select({ id: table.conversation_id, first: sql<string>`min(${table.created_at})` }).from(table).groupBy(table.conversation_id).all();
    for (const row of rows) if (!known.has(row.id) && (!strays.has(row.id) || row.first < strays.get(row.id)!)) strays.set(row.id, row.first);
  }
  if (strays.size === 0) return [];
  const existing = new Set(db.select({ id: contexts.id }).from(contexts).where(inArray(contexts.id, [...strays.keys()])).all().map((row) => row.id));
  in_transaction(database, () => {
    for (const [id, first] of strays) {
      db.insert(conversations).values({ id, title: "", created_at: first }).onConflictDoNothing().run();
      refresh_conversation_items(database, [id]);
      db.insert(context_items).values({ context_id: existing.has(id) ? id : global_context_id, item_id: conversation_item_id(id), note: "", added_at: first }).onConflictDoNothing().run();
    }
  });
  return [...strays.keys()];
}
