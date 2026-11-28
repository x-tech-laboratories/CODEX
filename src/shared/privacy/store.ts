// Privacy and trust by source: each collector plugin's two marks, kept in the synced settings, and the log of what
// each run answered by a hosted engine was sent, as counts of items per source, kept for a set number of days.

// ── Imports ──────────────────────────────────────────────────────────────────

import { desc, lt, synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import { settings_of } from "@x-tech-laboratories/x-libs/settings";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { text } from "../api_schemas.ts";
import { open_plugin_host } from "../collectors/host.ts";
import { blueprints_plugin_id } from "../blueprints/collector.ts";
import { conversations_plugin_id } from "../conversations/collector.ts";
import { findings_plugin_id } from "../interests/collector.ts";
import { define_feature, drizzle_of, new_id } from "../feature.ts";
import { read_setting, write_setting } from "../settings.ts";
import { migrations } from "./migrations/index.ts";
import { mark_names, unmarked, type HostedSend, type MarkName, type SourceCount, type SourceMarkEntry } from "./model.ts";
import { hosted_sends, privacy_tables } from "./schema.ts";
import { mark_key_of, marks_setting, stored_marks } from "./screen.ts";

// ── Marks ────────────────────────────────────────────────────────────────────

// Every collector plugin running, with its marks; CODEX's own conversations and blueprints are never an outside source, so have none.
async function list_source_marks(database: SqlDatabase): Promise<SourceMarkEntry[]> {
  const host = await open_plugin_host(database);
  const stored = stored_marks(database);
  const names = new Map(host.list().map((status) => [status.manifest.id, status.manifest.name]));
  // A collector marked on its own, such as each app the item calls read, is an entry of its own, named by its label.
  const by_key = new Map<string, { name: string; collectors: string[] }>();
  for (const collector of host.providers("collector")) {
    if (collector.plugin_id === conversations_plugin_id || collector.plugin_id === blueprints_plugin_id || collector.plugin_id === findings_plugin_id) continue;
    const key = mark_key_of(collector);
    const name = collector.value.marked_alone ? collector.value.label : (names.get(collector.plugin_id) ?? collector.plugin_id);
    by_key.set(key, { name, collectors: [...(by_key.get(key)?.collectors ?? []), collector.id] });
  }
  return [...by_key].map(([plugin_id, { name, collectors }]) => ({ plugin_id, name, collectors, ...unmarked, ...stored[plugin_id] }));
}

function set_source_mark(database: SqlDatabase, plugin_id: string, mark: MarkName, on: boolean): void {
  if (!mark_names.includes(mark)) throw new Error(`A mark is one of ${mark_names.join(", ")}.`);
  if (typeof on !== "boolean") throw new Error("Turn a mark on with true or off with false.");
  if (!plugin_id.trim()) throw new Error("Name the collector plugin, such as codex.x-tasks.");
  const stored = stored_marks(database);
  write_setting(database, marks_setting, { ...stored, [plugin_id]: { ...unmarked, ...stored[plugin_id], [mark]: on } });
}

// ── Log ──────────────────────────────────────────────────────────────────────

export const keep_days_setting = "hosted_log.keep_days";

const default_keep_days = 90;
const day_ms = 86_400_000;

function parsed_counts(json: string): SourceCount[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as SourceCount[]) : [];
  } catch {
    return [];
  }
}

function list_hosted_sends(database: SqlDatabase, limit = 100): HostedSend[] {
  return drizzle_of(database)
    .select()
    .from(hosted_sends)
    .orderBy(desc(hosted_sends.sent_at))
    .limit(Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100))))
    .all()
    .map((row) => ({ ...row, kind: row.kind === "tool" ? "tool" : "reply", included: parsed_counts(row.included), withheld: parsed_counts(row.withheld) }));
}

function keep_days(database: SqlDatabase): number {
  const days = Number(read_setting(database, keep_days_setting));
  return days >= 1 ? days : default_keep_days;
}

// Keeps what a run answered by a hosted engine was sent, and lets go of entries older than the days kept.
export function record_hosted_send(database: SqlDatabase, send: Omit<HostedSend, "id" | "item_count" | "sent_at" | "kind" | "tool" | "argument_count" | "argument_chars"> & Partial<Pick<HostedSend, "kind" | "tool" | "argument_count" | "argument_chars">>, now = new Date()): void {
  const db = drizzle_of(database);
  db.delete(hosted_sends)
    .where(lt(hosted_sends.sent_at, new Date(now.getTime() - keep_days(database) * day_ms).toISOString()))
    .run();
  db.insert(hosted_sends)
    .values({
      ...send,
      id: new_id(),
      included: JSON.stringify(send.included),
      withheld: JSON.stringify(send.withheld),
      item_count: send.included.reduce((sum, each) => sum + each.count, 0),
      sent_at: now.toISOString(),
    })
    .run();
}

// Keeps one use of a plugin tool that sends its arguments outside this machine: which tool, when, for which run, and
// how many arguments of how many characters; never the arguments themselves. The tool is named by its plugin's label
// and its own name, such as "Web: web_search".
export function record_tool_send(
  database: SqlDatabase,
  use: { run_id: string; conversation_id: string; engine: string; model: string; tool: string; args: Record<string, unknown> },
  now = new Date(),
): void {
  const argument_chars = Object.values(use.args).reduce<number>((sum, value) => sum + (typeof value === "string" ? value.length : JSON.stringify(value ?? null).length), 0);
  record_hosted_send(
    database,
    { run_id: use.run_id, conversation_id: use.conversation_id, engine: use.engine, model: use.model, included: [], withheld: [], kind: "tool", tool: use.tool, argument_count: Object.keys(use.args).length, argument_chars },
    now,
  );
}

// ── Feature ──────────────────────────────────────────────────────────────────

export const privacy_feature = define_feature({
  id: "privacy",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(privacy_tables),
  methods: { list_source_marks, set_source_mark, list_hosted_sends },
  api: {
    list_source_marks: {
      description:
        "Lists each collector plugin running, and each app read through the item calls on its own (its plugin_id then the plugin's id and its collector, such as codex.items/app.x-tasks), with its two marks: send_to_hosted, whether its items may be sent to a hosted engine (without it they are withheld from one), and trusted, whether reading its items leaves the assistant's changes at their own levels instead of making them all wait for approval.",
      params: [],
    },
    set_source_mark: {
      page_only: true,
      description: "Turns one of a collector plugin's marks on or off. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "plugin_id", schema: text("The collector plugin's id, such as codex.x-tasks, or an app's key such as codex.items/app.x-tasks, from list_source_marks.") },
        { name: "mark", schema: { type: "string", enum: mark_names, description: "send_to_hosted or trusted." } },
        { name: "on", schema: { type: "boolean", description: "True to turn it on, false to turn it off." } },
      ],
    },
    list_hosted_sends: {
      description:
        "Lists the replies written by a hosted engine, newest first: when, which engine and model, and how many items from each source it was sent or had withheld; never the items themselves. Each use of a plugin tool that sends its arguments outside this machine is listed too (kind tool), with the tool and how many arguments of how many characters it sent, never the arguments. Entries older than hosted_log.keep_days are let go.",
      params: [{ name: "limit", schema: { type: "integer", minimum: 1, maximum: 1000, description: "How many to list; 100 unless given." }, optional: true }],
    },
  },
  settings: settings_of({ [marks_setting]: {}, [keep_days_setting]: default_keep_days }, { user_only: true }),
});
