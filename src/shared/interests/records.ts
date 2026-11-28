// Reading and writing the interests and their findings: each interest a row, each finding an item of CODEX's own in the
// interest's context, inside the context of the assistant's own that holds them all, made when the first is saved.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, asc, eq, inArray, ne } from "@x-tech-laboratories/x-libs/drizzle";
import { in_transaction, type SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { item_id_of } from "../collectors/collector.ts";
import { context_items, contexts, items } from "../contexts/schema.ts";
import { conversations } from "../conversations/schema.ts";
import { drizzle_of, new_id } from "../feature.ts";
import { parse_sources } from "../privacy/sources.ts";
import { read_setting, write_setting } from "../settings.ts";
import { tool_source_of } from "../tools/model.ts";
import { web_manifest, web_tools_id } from "../tools/manifests.ts";
import {
  finding_collector,
  finding_kind,
  interest_defaults,
  interest_settings,
  interests_context_name,
  longest_finding_text,
  longest_finding_title,
  longest_reason,
  longest_topic,
  max_accepted_bounds,
  most_addresses,
  type Interest,
  type InterestMaker,
  type InterestState,
} from "./model.ts";
import { interests } from "./schema.ts";

// ── Checking ─────────────────────────────────────────────────────────────────

function flat(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// A topic made plain, or a plain error: the text a search engine is sent, so it must be short.
export function checked_topic(given: unknown): string {
  const topic = flat(given);
  if (!topic) throw new Error("Give the interest's topic, such as growing tomatoes in a cold greenhouse.");
  if (topic.length > longest_topic) throw new Error(`An interest's topic is at most ${longest_topic} characters.`);
  return topic;
}

export function checked_reason(given: unknown): string {
  const reason = flat(given);
  return reason.length > longest_reason ? `${reason.slice(0, longest_reason - 1)}…` : reason;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function max_accepted(database: SqlDatabase): number {
  const saved = Number(read_setting(database, interest_settings.max_accepted));
  const [least, most] = max_accepted_bounds;
  return Number.isInteger(saved) && saved >= least && saved <= most ? saved : interest_defaults[interest_settings.max_accepted];
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type InterestRow = typeof interests.$inferSelect;

export function interest_row(database: SqlDatabase, id: string): InterestRow {
  const row = drizzle_of(database).select().from(interests).where(eq(interests.id, id)).get();
  if (!row) throw new Error(`There is no interest ${id}.`);
  return row;
}

export function accepted_rows(database: SqlDatabase): InterestRow[] {
  return drizzle_of(database).select().from(interests).where(eq(interests.state, "accepted")).orderBy(asc(interests.researched_at), asc(interests.created_at)).all();
}

// The findings kept for each interest, by interest id, leaving out those taken out of every context.
function finding_rows(database: SqlDatabase): { item_id: string; title: string; interest_id: string; found_at: string }[] {
  const db = drizzle_of(database);
  const held = new Set(db.select({ item_id: context_items.item_id }).from(context_items).innerJoin(items, eq(items.id, context_items.item_id)).where(eq(items.collector, finding_collector)).all().map((row) => row.item_id));
  return db
    .select()
    .from(items)
    .where(and(eq(items.collector, finding_collector), ne(items.status, "missing")))
    .all()
    .filter((row) => held.has(row.id))
    .map((row) => {
      let detail: Record<string, string> = {};
      try {
        detail = JSON.parse(row.detail) as Record<string, string>;
      } catch {
        // A detail that cannot be read names no interest.
      }
      return { item_id: row.id, title: row.title, interest_id: detail.interest_id ?? "", found_at: detail.found_at ?? "" };
    });
}

// The titles of an interest's findings still kept, oldest first.
export function finding_titles(database: SqlDatabase, interest_id: string): string[] {
  return finding_rows(database)
    .filter((row) => row.interest_id === interest_id)
    .sort((first, second) => first.found_at.localeCompare(second.found_at))
    .map((row) => row.title);
}

export function list_interest_rows(database: SqlDatabase): Interest[] {
  const db = drizzle_of(database);
  const rows = db.select().from(interests).orderBy(asc(interests.created_at)).all();
  const conversation_ids = [...new Set(rows.map((row) => row.conversation_id).filter(Boolean))];
  const titles = new Map(conversation_ids.length > 0 ? db.select({ id: conversations.id, title: conversations.title }).from(conversations).where(inArray(conversations.id, conversation_ids)).all().map((row) => [row.id, row.title]) : []);
  const counts = new Map<string, number>();
  for (const finding of finding_rows(database)) counts.set(finding.interest_id, (counts.get(finding.interest_id) ?? 0) + 1);
  const order: Record<string, number> = { proposed: 0, accepted: 1, paused: 2, dropped: 3 };
  return rows
    .map((row) => ({
      id: row.id,
      topic: row.topic,
      reason: row.reason,
      state: row.state as InterestState,
      made_by: row.made_by as InterestMaker,
      engine: row.engine,
      model: row.model,
      sources: parse_sources(row.sources),
      conversation_id: row.conversation_id,
      conversation_title: titles.get(row.conversation_id) ?? "",
      context_id: row.context_id,
      findings: counts.get(row.id) ?? 0,
      researched_at: row.researched_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
    .sort((first, second) => (order[first.state] ?? 9) - (order[second.state] ?? 9));
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewInterest {
  topic: string;
  reason: string;
  state: InterestState;
  made_by: InterestMaker;
  engine?: string;
  model?: string;
  conversation_id?: string;
  sources?: string[];
}

export function insert_interest(database: SqlDatabase, values: NewInterest): string {
  const id = new_id();
  const at = new Date().toISOString();
  drizzle_of(database)
    .insert(interests)
    .values({ id, ...values, engine: values.engine ?? "", model: values.model ?? "", conversation_id: values.conversation_id ?? "", sources: JSON.stringify([...new Set(values.sources ?? [])].sort()), created_at: at, updated_at: at })
    .run();
  return id;
}

export function update_interest(database: SqlDatabase, id: string, values: Partial<Pick<InterestRow, "topic" | "state" | "context_id" | "researched_at">>): void {
  drizzle_of(database).update(interests).set({ ...values, updated_at: new Date().toISOString() }).where(eq(interests.id, id)).run();
}

// ── Findings ─────────────────────────────────────────────────────────────────

function context_exists(database: SqlDatabase, id: string): boolean {
  return id !== "" && drizzle_of(database).select({ id: contexts.id }).from(contexts).where(eq(contexts.id, id)).get() !== undefined;
}

function new_context(database: SqlDatabase, name: string, parent_id: string | null): string {
  const db = drizzle_of(database);
  const siblings = db.select({ position: contexts.position, parent_id: contexts.parent_id }).from(contexts).all().filter((row) => row.parent_id === parent_id);
  const id = new_id();
  db.insert(contexts).values({ id, parent_id, name, position: siblings.reduce((most, row) => Math.max(most, row.position + 1), 0), created_at: new Date().toISOString() }).run();
  return id;
}

// The context holding an interest's findings, inside the assistant's own, each made when first needed and made again
// when the user removed it.
export function findings_context(database: SqlDatabase, interest: InterestRow): string {
  if (context_exists(database, interest.context_id)) return interest.context_id;
  let root = String(read_setting(database, interest_settings.context) ?? "");
  if (!context_exists(database, root)) {
    root = new_context(database, interests_context_name, null);
    write_setting(database, interest_settings.context, root);
  }
  const id = new_context(database, interest.topic.slice(0, 80), root);
  update_interest(database, interest.id, { context_id: id });
  return id;
}

// The source every finding counts as: the Web plugin's results, since it was written from what the web said.
export const finding_source = tool_source_of(`${web_manifest.id}/${web_tools_id}`);

export interface FindingFields {
  title: string;
  text: string;
  addresses: string[];
}

// A finding checked, or a plain error the run's engine reads: a title, some text and the public addresses it came from.
export function checked_finding(given: Record<string, unknown>): FindingFields {
  const title = flat(given.title);
  const text = String(given.text ?? "").trim();
  if (!title) throw new Error("give the finding a short title");
  if (title.length > longest_finding_title) throw new Error(`a finding's title is at most ${longest_finding_title} characters`);
  if (!text) throw new Error("give the finding's text: what you learned, in a few plain sentences");
  if (text.length > longest_finding_text) throw new Error(`a finding's text is at most ${longest_finding_text} characters`);
  const addresses = (Array.isArray(given.addresses) ? given.addresses : []).map((each) => String(each).trim()).filter((each) => /^https?:\/\/\S+$/i.test(each));
  if (addresses.length === 0) throw new Error("give the addresses of the pages you read for it, each starting with http:// or https://");
  return { title, text, addresses: [...new Set(addresses)].slice(0, most_addresses) };
}

// Keeps a finding as an item in its interest's context, recorded as coming from the web; gives back its item id.
export function save_finding(database: SqlDatabase, interest: InterestRow, fields: FindingFields, run_id: string, now: number): string {
  return in_transaction(database, () => {
    const context_id = findings_context(database, interest);
    const source_id = new_id();
    const id = item_id_of(finding_collector, source_id);
    const at = new Date(now).toISOString();
    const detail = { interest_id: interest.id, topic: interest.topic, addresses: fields.addresses.join("\n"), found_at: at, run_id, sources: JSON.stringify([finding_source]) };
    const db = drizzle_of(database);
    db.insert(items)
      .values({ id, collector: finding_collector, source_id, kind: finding_kind, title: fields.title, snippet: fields.text, uri: fields.addresses[0]!, status: "", detail: JSON.stringify(detail), created_at: at, seen_at: at })
      .run();
    db.insert(context_items).values({ context_id, item_id: id, note: "", added_at: at }).run();
    return id;
  });
}
